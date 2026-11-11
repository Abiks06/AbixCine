import pg from "pg";

const url = process.env.DATABASE_URL;

/**
 * Production (Render): a real Postgres via DATABASE_URL.
 * Local dev with no DATABASE_URL: an embedded Postgres (PGlite) stored in ./data, so
 * `npm run dev` works on any machine with nothing else installed.
 */
let pool;
let embedded = null;
if (url) {
  // Render's managed Postgres requires TLS from outside its private network.
  const needsSsl = /render\.com|sslmode=require/.test(url) || process.env.PGSSL === "1";
  pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: Number(process.env.PG_POOL_MAX ?? 5) });
} else {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR ?? "./data/pglite";
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(dir), { recursive: true });
  embedded = new PGlite(dir);
  pool = { query: (t, p) => embedded.query(t, p), end: () => embedded.close() };
  console.log("[db] DATABASE_URL not set: using embedded Postgres in ./data/pglite");
}
export { pool };

export const q = (text, params) => pool.query(text, params);

/** Idempotent schema setup, run on boot. Small enough not to need a migration tool yet. */
export async function migrate() {
  const run = embedded ? (sql) => embedded.exec(sql) : (sql) => q(sql);
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email         text NOT NULL,
      name          text NOT NULL,
      password_hash text NOT NULL,
      avatar_hue    int  NOT NULL DEFAULT 260,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  text NOT NULL UNIQUE,
      device      text,
      expires_at  timestamptz NOT NULL,
      revoked_at  timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens (user_id);

    CREATE TABLE IF NOT EXISTS progress (
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_key  text NOT NULL,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, media_key)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_key text NOT NULL,
      media     jsonb NOT NULL,
      added_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, media_key)
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- v2: token families, sign-out-everywhere, sync/housekeeping indexes
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 0;
    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id uuid;
    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_at timestamptz;
    CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens (family_id);
    CREATE INDEX IF NOT EXISTS refresh_tokens_expiry ON refresh_tokens (expires_at);
    CREATE INDEX IF NOT EXISTS progress_user_updated ON progress (user_id, updated_at DESC);

    -- v3: per-episode watch history, email codes, Google/Discord sign-in
    CREATE TABLE IF NOT EXISTS watch_history (
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_key  text NOT NULL,
      ep_key     text NOT NULL,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, media_key, ep_key)
    );
    CREATE INDEX IF NOT EXISTS watch_history_user_updated ON watch_history (user_id, updated_at DESC);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
    -- Accounts made with Google/Discord have no password.
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS email_codes (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose    text NOT NULL,
      code_hash  text NOT NULL,
      attempts   int  NOT NULL DEFAULT 0,
      expires_at timestamptz NOT NULL,
      used_at    timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS email_codes_user ON email_codes (user_id, purpose, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_identities (
      provider   text NOT NULL,
      subject    text NOT NULL,
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email      text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, subject)
    );
    CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities (user_id);

    CREATE TABLE IF NOT EXISTS oauth_pending (
      state      text PRIMARY KEY,
      provider   text NOT NULL,
      poll_hash  text NOT NULL,
      verifier   text NOT NULL,
      user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
      error      text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}
