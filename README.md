# InkTrack

A tattoo income tracker for individual artists. Static frontend on
Cloudflare Pages, API + database on Cloudflare Workers + D1 — both
free tier, both plenty for a small shop.

```
inktrack/
├── frontend/        ← deploy this folder to Cloudflare Pages
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── dashboard.html
│   ├── _headers     ← security headers Pages picks up automatically
│   └── assets/
│       ├── style.css
│       └── app.js
└── worker/           ← deploy this with Wrangler (Cloudflare CLI)
    ├── schema.sql
    ├── wrangler.jsonc
    └── src/
        ├── index.js
        ├── auth.js
        └── validate.js
```

## What changed from the local-only version

The original version stored everything — including a plaintext
password table — in the browser's `localStorage`. That meant no
real accounts (each device was its own silo) and nothing was
actually secret. This version moves accounts and income data to a
real backend:

- **Passwords** are hashed with PBKDF2 (100,000 iterations) plus a
  random salt per artist. The server never stores or sees the raw
  password after signup/login.
- **Sessions** are a random token in an `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie. JavaScript on the page can't read it, and
  only its SHA-256 hash is stored in the database — a leaked database
  snapshot doesn't hand out working logins.
- **Every entry (tattoo session) is scoped to the logged-in artist**
  at the database level. The client never sends an "artist ID" — the
  server derives it from the session cookie on every request.
- **Login lockout**: 8 failed attempts locks the account for 15
  minutes, slowing down password-guessing.
- **CORS is locked** to your specific Pages URL via `ALLOWED_ORIGIN`.

This is a meaningful security upgrade over `localStorage`, appropriate
for a small shop's day-to-day income tracking. It is not a substitute
for a security audit if you ever handle something more sensitive
(e.g. payment card numbers) — don't add that here without
professional review.

## Deploy: the backend (Worker + D1)

You'll need Node.js installed locally, and a free Cloudflare account.

```bash
cd worker
npm install
npx wrangler login          # opens a browser to authorize the CLI

# 1. Create the database
npx wrangler d1 create inktrack-db
# This prints a database_id — copy it into wrangler.jsonc,
# replacing "REPLACE_WITH_YOUR_DATABASE_ID"

# 2. Run the schema against your new database
npm run db:migrate:remote

# 3. Set the session-signing secret (used internally — generate any
#    long random string; this command keeps it out of your source code)
npx wrangler secret put SESSION_SECRET
# paste a random value when prompted, e.g. output of: openssl rand -hex 32

# 4. Deploy
npm run deploy
```

Wrangler prints your live Worker URL, something like:
`https://inktrack-api.your-subdomain.workers.dev`

**Copy that URL** — you need it in two places in the frontend (next
section), and in `wrangler.jsonc` under `ALLOWED_ORIGIN` (set to your
Pages URL, not the Worker URL itself — see below).

## Deploy: the frontend (Cloudflare Pages)

1. In each of `index.html`, `login.html`, `signup.html`,
   `dashboard.html`, and in `assets/app.js`, replace
   `https://inktrack-api.YOUR-SUBDOMAIN.workers.dev` with the real
   Worker URL from the previous step. (Search-and-replace works fine
   — it's the same placeholder string everywhere.)
2. Also update that URL in `frontend/_headers` (the `connect-src` line)
   so the Content-Security-Policy allows the API call.
3. Push the `frontend/` folder to a GitHub repo, then in the
   Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect
   to Git**, point it at the repo, and set the build output directory
   to `frontend` (or just the repo root if `frontend/` is the repo
   root).
   - No build command needed — this is a static site, just HTML/CSS/JS.
4. Once deployed, Pages gives you a URL like
   `https://inktrack.pages.dev`. Take that URL and put it in
   `worker/wrangler.jsonc` as `ALLOWED_ORIGIN`, then redeploy the
   worker (`npm run deploy` again from `worker/`).

That circular dependency (frontend needs the Worker URL, Worker needs
the Pages URL) is normal — you set placeholders, deploy both once,
then go back and fill in the real values and redeploy each side once
more.

## Local development

```bash
# backend
cd worker
npx wrangler dev               # runs the API at http://localhost:8787

# frontend — any static file server works, e.g.:
cd frontend
npx serve .                    # or: python3 -m http.server 8080
```

While testing locally, temporarily set `window.INKTRACK_API_BASE =
"http://localhost:8787"` in the HTML files, and set `ALLOWED_ORIGIN`
in `wrangler.jsonc` to your local frontend's origin (e.g.
`http://localhost:8080`).

## Free tier headroom

Cloudflare Workers Free includes 100,000 requests/day; D1 includes
5 GB storage and 100,000 rows written per day. A single-shop tool
with a handful of artists logging a few sessions a day uses a tiny
fraction of that — you won't need to upgrade for this use case.

## What's deliberately out of scope

- **Password reset / "forgot password"** — needs an email-sending
  service (e.g. Resend, Cloudflare Email Workers) wired in; flagged
  here so it doesn't get missed before real artists rely on this.
- **Multi-artist / shop-owner roles** — right now every artist is
  fully independent with their own login and their own data. If you
  want a shop owner to see everyone's numbers, that's a deliberate
  follow-up, not a small tweak (it changes the permission model).
