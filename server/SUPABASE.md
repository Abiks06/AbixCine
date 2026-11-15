# Database on Supabase

The sync server keeps running on Render; only its Postgres moves to Supabase (free tier). Render's
free Postgres is deleted after 30 days. Supabase's free database is kept, and only pauses after a
week with no requests at all (the app's sync keeps it awake; a paused project is restored from the
Supabase dashboard).

## AbixCine's project

Already created: **abixcine** (ref `vclxkfcwurffrqvrpjoi`, region us-west-1, near Render's default
Oregon region), with the full schema applied and row-level security on every table (no policies,
so Supabase's public REST API can't read or write them; the server logs in as the owner and isn't
limited). What's left is step 2–3 below: copy its Session pooler URI and set it on Render.

## Set up


1. Create a project at supabase.com (any region near your Render service).
2. **Connect → Session pooler** → copy the URI. It looks like
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Use the session pooler, not the direct connection: Render's free services have no IPv6, and
   Supabase's direct host is IPv6-only.
3. In Render → `abixcine-api` → Environment, set `DATABASE_URL` to that URI and redeploy.
   The server creates its tables on boot (`migrate()` in `src/db.js`); TLS is switched on
   automatically for `supabase.co` / `pooler.supabase.com` hosts.

## Moving existing accounts and progress

Before the old Render database expires, copy it across (needs the PostgreSQL client tools):

```sh
pg_dump --no-owner --no-acl "<Render external connection string>" > abixcine.sql
psql "<Supabase session pooler URI>" -f abixcine.sql
```

Then point `DATABASE_URL` at Supabase. Everyone stays signed in: refresh tokens live in the
database you just copied.

## Optional

- `PGSSL_VERIFY=1` (with `PGSSL_CA` set to Supabase's CA certificate, downloadable from the project's
  database settings) turns on certificate verification.
- `PG_POOL_MAX` (default 5) caps connections; the session pooler allows plenty for one instance.
