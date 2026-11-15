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
  // Managed Postgres (Supabase, Render's external URL) requires TLS.
  const needsSsl = /render\.com|supabase\.(?:co|com)|sslmode=require/.test(url) || process.env.PGSSL === "1";
  // Certificate checks are opt-in so existing deployments keep connecting: set PGSSL_VERIFY=1
  // (optionally with the server's CA in PGSSL_CA) to reject unverified certificates.
  const verify = process.env.PGSSL_VERIFY === "1";
  const ssl = needsSsl
    ? { rejectUnauthorized: verify, ...(process.env.PGSSL_CA ? { ca: process.env.PGSSL_CA } : {}) }
    : undefined;
  pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX ?? 5) });
} else {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR ?? "./data/pglite";
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(dir), { recursive: true });
  embedded = new PGlite(dir);
  // PGlite reports changed rows as `affectedRows`; callers read node-postgres's `rowCount`.
  pool = {
    query: async (t, p) => {
      const r = await embedded.query(t, p);
      return { ...r, rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
    },
    end: () => embedded.close(),
  };
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

    -- v3: soft-delete tombstones, so a delete on one device isn't undone by another device's sync
    ALTER TABLE progress ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
  `);
  // Hosted Postgres with a public data API (Supabase): row-level security with no policies keeps
  // that API out of every table. The server logs in as the tables' owner, which RLS doesn't limit.
  if (!embedded) {
    await run(`
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
      ALTER TABLE progress ENABLE ROW LEVEL SECURITY;
      ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
      ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
    `);
  }
}
