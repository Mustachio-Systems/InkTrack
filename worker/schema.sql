-- ============================================================
-- INKTRACK — D1 Schema v3
-- SQLite (via Cloudflare D1)
-- ============================================================

CREATE TABLE IF NOT EXISTS artists (
    id            TEXT PRIMARY KEY,           -- uuid
    email         TEXT NOT NULL UNIQUE,       -- stored lowercase
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,              -- PBKDF2 hash, see auth.js
    password_salt TEXT NOT NULL,               -- random salt, hex
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    -- basic brute-force throttling
    failed_attempts   INTEGER NOT NULL DEFAULT 0,
    locked_until       TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    -- this is an AUTH session (login token), not a tattoo session.
    -- "tattoo session" rows live in the `entries` table below.
    id          TEXT PRIMARY KEY,             -- random token id (hashed before storage)
    artist_id   TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_artist ON sessions(artist_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS entries (
    -- a single tattoo session / client ticket
    id           TEXT PRIMARY KEY,            -- uuid
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    entry_date   TEXT NOT NULL,               -- YYYY-MM-DD
    client_name  TEXT,
    gross_gains  REAL NOT NULL,
    hours_worked REAL NOT NULL,
    supply_spend REAL NOT NULL DEFAULT 0,
    style        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_artist ON entries(artist_id);
CREATE INDEX IF NOT EXISTS idx_entries_artist_date ON entries(artist_id, entry_date);
