// ============================================================
// INKTRACK API — auth.js
// Password hashing via PBKDF2 (Web Crypto, native to Workers).
// Session tokens are random, hashed before storing in D1 (so a
// stolen DB snapshot doesn't hand out live sessions), and sent
// to the browser as an HttpOnly, Secure, SameSite=Strict cookie.
// ============================================================

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_DAYS = 30;

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomHex(numBytes) {
  const bytes = new Uint8Array(numBytes);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function pbkdf2(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    HASH_BYTES * 8
  );
  return bytesToHex(new Uint8Array(derived));
}

export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, saltBytes);
  return { hash, salt: bytesToHex(saltBytes) };
}

export async function verifyPassword(password, storedHash, storedSaltHex) {
  const saltBytes = hexToBytes(storedSaltHex);
  const candidateHash = await pbkdf2(password, saltBytes);
  return timingSafeEqual(candidateHash, storedHash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ---------- Session tokens ----------
// The cookie holds the raw token. We store only sha256(token) in D1,
// so reading the database never reveals a usable session token.

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function createSession(db, artistId, userAgent) {
  const token = randomHex(SESSION_TOKEN_BYTES);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare("INSERT INTO sessions (id, artist_id, expires_at, user_agent) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, artistId, expiresAt, userAgent || null)
    .run();

  return { token, expiresAt };
}

export async function getArtistFromRequest(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const token = parseCookie(cookieHeader, "inktrack_session");
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB
    .prepare(
      `SELECT a.id, a.email, a.name
       FROM sessions s JOIN artists a ON a.id = s.artist_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .bind(tokenHash)
    .first();

  return row || null;
}

export async function destroySession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const token = parseCookie(cookieHeader, "inktrack_session");
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
}

export function parseCookie(cookieHeader, name) {
  const parts = cookieHeader.split(";").map(p => p.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export function sessionCookie(token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  // Secure + HttpOnly + SameSite=None: Required for cross-origin (pages.dev -> workers.dev)
  return `inktrack_session=${token}; Path=/; Expires=${expires}; HttpOnly; Secure; SameSite=None`;
}

export function clearSessionCookie() {
  // Secure + HttpOnly + SameSite=None: Required for cross-origin
  return `inktrack_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None`;
}

// ---------- Basic brute-force throttling ----------
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

export async function isLockedOut(artistRow) {
  if (!artistRow.locked_until) return false;
  return new Date(artistRow.locked_until) > new Date();
}

export async function recordFailedAttempt(db, artistId, currentFailedCount) {
  const newCount = (currentFailedCount || 0) + 1;
  if (newCount >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
    await db
      .prepare("UPDATE artists SET failed_attempts = ?, locked_until = ? WHERE id = ?")
      .bind(newCount, lockedUntil, artistId)
      .run();
  } else {
    await db
      .prepare("UPDATE artists SET failed_attempts = ? WHERE id = ?")
      .bind(newCount, artistId)
      .run();
  }
}

export async function clearFailedAttempts(db, artistId) {
  await db
    .prepare("UPDATE artists SET failed_attempts = 0, locked_until = NULL WHERE id = ?")
    .bind(artistId)
    .run();
}
