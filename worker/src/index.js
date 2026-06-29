// ============================================================
// INKTRACK API — index.js
// Cloudflare Worker, paired with D1.
//
// Security model summary (see README for full notes):
// - Passwords: PBKDF2 (100k iterations), unique salt per artist.
// - Sessions: random opaque token in an HttpOnly/Secure/SameSite
//   cookie; only a SHA-256 hash of it is stored server-side.
// - Every entries/* route re-derives the artist from the session
//   and filters all queries by artist_id — no client-supplied
//   "user id" is ever trusted.
// - CORS is locked to ALLOWED_ORIGIN (set it to your Pages URL).
// - Basic lockout after repeated failed logins.
// ============================================================

import {
  hashPassword, verifyPassword, createSession, getArtistFromRequest,
  destroySession, sessionCookie, clearSessionCookie,
  isLockedOut, recordFailedAttempt, clearFailedAttempts
} from "./auth.js";

import {
  err, ok, cleanText, isValidEmail, isValidPassword,
  isValidDate, isValidMoney, isValidHours, isValidStyle
} from "./validate.js";

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function withCors(response, env, request) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(env, request);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    try {
      let response;

      if (path === "/api/signup" && method === "POST") {
        response = await handleSignup(request, env);
      } else if (path === "/api/login" && method === "POST") {
        response = await handleLogin(request, env);
      } else if (path === "/api/logout" && method === "POST") {
        response = await handleLogout(request, env);
      } else if (path === "/api/me" && method === "GET") {
        response = await handleMe(request, env);
      } else if (path === "/api/entries" && method === "GET") {
        response = await handleListEntries(request, env);
      } else if (path === "/api/entries" && method === "POST") {
        response = await handleCreateEntry(request, env);
      } else if (path.match(/^\/api\/entries\/[^/]+$/) && method === "PUT") {
        response = await handleUpdateEntry(request, env, path.split("/").pop());
      } else if (path.match(/^\/api\/entries\/[^/]+$/) && method === "DELETE") {
        response = await handleDeleteEntry(request, env, path.split("/").pop());
      } else if (path === "/api/export" && method === "GET") {
        response = await handleExport(request, env);
      } else if (path === "/api/import" && method === "POST") {
        response = await handleImport(request, env);
      } else {
        response = err("Not found", 404);
      }

      return withCors(response, env, request);
    } catch (e) {
      console.error(e);
      return withCors(err("Something went wrong on our end. Try again in a moment.", 500), env, request);
    }
  }
};

// ---------- Auth handlers ----------

async function handleSignup(request, env) {
  const body = await readJson(request);
  if (!body) return err("Send name, email, and password.");

  const name = cleanText(body.name, 80);
  const email = cleanText(body.email, 254).toLowerCase();
  const password = body.password;

  if (!name) return err("Enter your artist or studio name.");
  if (!isValidEmail(email)) return err("Enter a valid email address.");
  if (!isValidPassword(password)) return err("Password must be at least 8 characters.");

  const existing = await env.DB.prepare("SELECT id FROM artists WHERE email = ?").bind(email).first();
  if (existing) return err("An account with that email already exists. Try logging in instead.", 409);

  const id = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);

  await env.DB
    .prepare("INSERT INTO artists (id, email, name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, name, hash, salt)
    .run();

  const { token, expiresAt } = await createSession(env.DB, id, request.headers.get("User-Agent"));

  return new Response(JSON.stringify({ artist: { id, name, email } }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie(token, expiresAt)
    }
  });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body) return err("Send email and password.");

  const email = cleanText(body.email, 254).toLowerCase();
  const password = body.password;
  const genericError = "That email and password don't match an account.";

  if (!isValidEmail(email) || typeof password !== "string") return err(genericError, 401);

  const artist = await env.DB.prepare("SELECT * FROM artists WHERE email = ?").bind(email).first();
  if (!artist) return err(genericError, 401);

  if (await isLockedOut(artist)) {
    return err("Too many failed attempts. Try again in a few minutes.", 429);
  }

  const valid = await verifyPassword(password, artist.password_hash, artist.password_salt);
  if (!valid) {
    await recordFailedAttempt(env.DB, artist.id, artist.failed_attempts);
    return err(genericError, 401);
  }

  await clearFailedAttempts(env.DB, artist.id);
  const { token, expiresAt } = await createSession(env.DB, artist.id, request.headers.get("User-Agent"));

  return new Response(
    JSON.stringify({ artist: { id: artist.id, name: artist.name, email: artist.email } }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": sessionCookie(token, expiresAt)
      }
    }
  );
}

async function handleLogout(request, env) {
  await destroySession(request, env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() }
  });
}

async function handleMe(request, env) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);
  return ok({ artist });
}

// ---------- Entry (tattoo session) handlers ----------
// Every handler below re-fetches the artist from the session
// cookie. The client can never pass an artist_id directly.

async function handleListEntries(request, env) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);

  const { results } = await env.DB
    .prepare("SELECT * FROM entries WHERE artist_id = ? ORDER BY entry_date DESC, created_at DESC")
    .bind(artist.id)
    .all();

  return ok({ entries: results.map(toClientEntry) });
}

async function handleCreateEntry(request, env) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);

  const body = await readJson(request);
  const validationError = validateEntryPayload(body);
  if (validationError) return err(validationError);

  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO entries (id, artist_id, entry_date, client_name, gross_gains, hours_worked, supply_spend, style)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, artist.id, body.date, cleanText(body.clientName, 120) || null, body.grossGains, body.hoursWorked, body.supplySpend || 0, body.style || null)
    .run();

  const row = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
  return ok({ entry: toClientEntry(row) }, 201);
}

async function handleUpdateEntry(request, env, entryId) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);

  // Ownership check before any write.
  const existing = await env.DB.prepare("SELECT id FROM entries WHERE id = ? AND artist_id = ?")
    .bind(entryId, artist.id).first();
  if (!existing) return err("Session not found.", 404);

  const body = await readJson(request);
  const validationError = validateEntryPayload(body);
  if (validationError) return err(validationError);

  await env.DB
    .prepare(
      `UPDATE entries SET entry_date = ?, client_name = ?, gross_gains = ?, hours_worked = ?, supply_spend = ?, style = ?, updated_at = datetime('now')
       WHERE id = ? AND artist_id = ?`
    )
    .bind(body.date, cleanText(body.clientName, 120) || null, body.grossGains, body.hoursWorked, body.supplySpend || 0, body.style || null, entryId, artist.id)
    .run();

  const row = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(entryId).first();
  return ok({ entry: toClientEntry(row) });
}

async function handleDeleteEntry(request, env, entryId) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);

  const result = await env.DB
    .prepare("DELETE FROM entries WHERE id = ? AND artist_id = ?")
    .bind(entryId, artist.id)
    .run();

  if (result.meta.changes === 0) return err("Session not found.", 404);
  return ok({ ok: true });
}

function validateEntryPayload(body) {
  if (!body) return "Send the session details.";
  if (!isValidDate(body.date)) return "Enter a valid date.";
  if (!isValidMoney(body.grossGains)) return "Enter a gross amount of $0 or more.";
  if (!isValidHours(body.hoursWorked)) return "Hours worked must be greater than 0 and no more than 24.";
  if (body.supplySpend !== undefined && body.supplySpend !== null && !isValidMoney(body.supplySpend)) {
    return "Supply spend must be $0 or more.";
  }
  if (!isValidStyle(body.style)) return "Unrecognized tattoo style.";
  return null;
}

function toClientEntry(row) {
  return {
    id: row.id,
    date: row.entry_date,
    clientName: row.client_name,
    grossGains: row.gross_gains,
    hoursWorked: row.hours_worked,
    supplySpend: row.supply_spend,
    style: row.style
  };
}

// ---------- Backup export / import ----------

async function handleExport(request, env) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);

  const { results } = await env.DB
    .prepare("SELECT * FROM entries WHERE artist_id = ? ORDER BY entry_date ASC")
    .bind(artist.id)
    .all();

  return ok({
    exportedAt: new Date().toISOString(),
    artist: artist.email,
    entries: results.map(toClientEntry)
  });
}

async function handleImport(request, env) {
  const artist = await getArtistFromRequest(request, env);
  if (!artist) return err("Not logged in.", 401);

  const body = await readJson(request);
  if (!body || !Array.isArray(body.entries)) return err("Malformed backup file.");
  if (body.entries.length > 5000) return err("That backup has too many entries to import at once.");

  let imported = 0;
  for (const entry of body.entries) {
    if (!isValidDate(entry.date) || !isValidMoney(entry.grossGains) || !isValidHours(entry.hoursWorked)) {
      continue; // skip malformed rows rather than failing the whole import
    }
    const supplySpend = isValidMoney(entry.supplySpend) ? entry.supplySpend : 0;
    const style = isValidStyle(entry.style) ? entry.style : null;

    await env.DB
      .prepare(
        `INSERT INTO entries (id, artist_id, entry_date, client_name, gross_gains, hours_worked, supply_spend, style)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), artist.id, entry.date, cleanText(entry.clientName, 120) || null, entry.grossGains, entry.hoursWorked, supplySpend, style)
      .run();
    imported++;
  }

  return ok({ imported });
}
