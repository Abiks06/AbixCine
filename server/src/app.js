import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { checkPassword, hashPassword, issueTokens, publicUser, requireUser, revokeRefresh, rotateRefresh } from "./auth.js";
import { q } from "./db.js";
import { tmdbProxy } from "./tmdb.js";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_RX = /^[a-z]+:[a-z0-9:]+$/i; // e.g. tmdb:movie:603, anilist:21
// Settings that follow the user across devices. Device-specific things (library folders) stay local.
const SYNCED_SETTINGS = ["preferredQuality", "autoplayNext", "reduceMotion", "animeAudio", "audioByTitle"];

export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, trustProxy: true });

  // Desktop app origins (Tauri on Windows uses http://tauri.localhost) plus local dev.
  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://localhost:4173").split(","),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(rateLimit, { global: false });

  app.get("/health", async () => ({ ok: true, tmdbProxy: !!process.env.TMDB_KEY }));

  // ---------- auth ----------
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/auth/signup", authLimit, async (req, reply) => {
    const { email = "", password = "", name = "" } = req.body ?? {};
    const em = String(email).trim().toLowerCase();
    if (!EMAIL_RX.test(em)) return reply.code(400).send({ error: "invalid_email" });
    if (String(password).length < 8) return reply.code(400).send({ error: "weak_password" });
    const nm = String(name).trim().slice(0, 40) || em.split("@")[0];
    const hue = Math.floor(Math.random() * 360);
    try {
      const { rows } = await q(
        `INSERT INTO users (email, name, password_hash, avatar_hue) VALUES ($1, $2, $3, $4) RETURNING *`,
        [em, nm, await hashPassword(String(password)), hue],
      );
      await q(`INSERT INTO user_settings (user_id) VALUES ($1)`, [rows[0].id]);
      return { user: publicUser(rows[0]), ...(await issueTokens(rows[0], req.headers["user-agent"])) };
    } catch (e) {
      if (e.code === "23505") return reply.code(409).send({ error: "email_taken" });
      throw e;
    }
  });

  app.post("/auth/login", authLimit, async (req, reply) => {
    const { email = "", password = "" } = req.body ?? {};
    const { rows } = await q(`SELECT * FROM users WHERE lower(email) = lower($1)`, [String(email).trim()]);
    const u = rows[0];
    // Compare against a dummy hash when the user doesn't exist so timing doesn't leak which emails are registered.
    const ok = await checkPassword(String(password), u?.password_hash ?? "$2a$11$C6UzMDM.H6dfI/f/IKcEeO7Q9rG2n3Yw2yQq1uQ0eY0uC5mJ8Z7xW");
    if (!u || !ok) return reply.code(401).send({ error: "bad_credentials" });
    return { user: publicUser(u), ...(await issueTokens(u, req.headers["user-agent"])) };
  });

  app.post("/auth/refresh", authLimit, async (req, reply) => {
    const r = await rotateRefresh(String(req.body?.refreshToken ?? ""), req.headers["user-agent"]);
    if (!r) return reply.code(401).send({ error: "invalid_refresh" });
    return r;
  });

  app.post("/auth/logout", async (req) => {
    if (req.body?.refreshToken) await revokeRefresh(String(req.body.refreshToken));
    return { ok: true };
  });

  // ---------- account ----------
  app.get("/me", { preHandler: requireUser }, async (req, reply) => {
    const { rows } = await q(`SELECT * FROM users WHERE id = $1`, [req.userId]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    return { user: publicUser(rows[0]) };
  });

  app.patch("/me", { preHandler: requireUser }, async (req) => {
    const { name, avatarHue } = req.body ?? {};
    const { rows } = await q(
      `UPDATE users SET name = COALESCE($2, name), avatar_hue = COALESCE($3, avatar_hue) WHERE id = $1 RETURNING *`,
      [req.userId, name ? String(name).trim().slice(0, 40) : null, Number.isInteger(avatarHue) ? avatarHue % 360 : null],
    );
    return { user: publicUser(rows[0]) };
  });

  app.delete("/me", { preHandler: requireUser }, async (req) => {
    await q(`DELETE FROM users WHERE id = $1`, [req.userId]);
    return { ok: true };
  });

  // ---------- sync ----------
  app.get("/sync", { preHandler: requireUser }, async (req) => {
    const [p, w, s] = await Promise.all([
      q(`SELECT media_key, data, updated_at FROM progress WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 500`, [req.userId]),
      q(`SELECT media_key, media, added_at FROM watchlist WHERE user_id = $1 ORDER BY added_at DESC`, [req.userId]),
      q(`SELECT data FROM user_settings WHERE user_id = $1`, [req.userId]),
    ]);
    return {
      progress: p.rows.map((r) => ({ ...r.data, updatedAt: new Date(r.updated_at).getTime() })),
      watchlist: w.rows.map((r) => ({ media: r.media, addedAt: new Date(r.added_at).getTime() })),
      settings: s.rows[0]?.data ?? {},
    };
  });

  app.put("/progress/:key", { preHandler: requireUser }, async (req, reply) => {
    const key = req.params.key;
    const e = req.body ?? {};
    if (!KEY_RX.test(key) || typeof e.position !== "number" || typeof e.duration !== "number") return reply.code(400).send({ error: "bad_request" });
    const updatedAt = new Date(Number(e.updatedAt) || Date.now());
    // Last write wins, but never let an older device overwrite a newer one.
    await q(
      `INSERT INTO progress (user_id, media_key, data, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, media_key) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
       WHERE progress.updated_at < EXCLUDED.updated_at`,
      [req.userId, key, JSON.stringify({ media: e.media, season: e.season, episode: e.episode, audio: e.audio, position: e.position, duration: e.duration }), updatedAt],
    );
    return { ok: true };
  });

  app.delete("/progress/:key", { preHandler: requireUser }, async (req) => {
    await q(`DELETE FROM progress WHERE user_id = $1 AND media_key = $2`, [req.userId, req.params.key]);
    return { ok: true };
  });

  app.put("/watchlist/:key", { preHandler: requireUser }, async (req, reply) => {
    const key = req.params.key;
    if (!KEY_RX.test(key) || !req.body?.media) return reply.code(400).send({ error: "bad_request" });
    await q(
      `INSERT INTO watchlist (user_id, media_key, media) VALUES ($1, $2, $3) ON CONFLICT (user_id, media_key) DO NOTHING`,
      [req.userId, key, JSON.stringify(req.body.media)],
    );
    return { ok: true };
  });

  app.delete("/watchlist/:key", { preHandler: requireUser }, async (req) => {
    await q(`DELETE FROM watchlist WHERE user_id = $1 AND media_key = $2`, [req.userId, req.params.key]);
    return { ok: true };
  });

  app.put("/settings", { preHandler: requireUser }, async (req) => {
    const clean = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => SYNCED_SETTINGS.includes(k)));
    await q(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || EXCLUDED.data, updated_at = now()`,
      [req.userId, JSON.stringify(clean)],
    );
    return { ok: true };
  });

  // ---------- catalog proxy ----------
  // Lets every signed-in user browse TMDB without their own key, if TMDB_KEY is set on the server.
  app.get("/tmdb/*", { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, tmdbProxy);

  return app;
}
