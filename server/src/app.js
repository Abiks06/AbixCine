import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { checkPassword, forgetTokenVersion, hashPassword, issueTokens, MAX_PASSWORD, pruneTokens, publicUser, requireUser, revokeAll, revokeRefresh, rotateRefresh } from "./auth.js";
import { q } from "./db.js";
import { tmdbProxy } from "./tmdb.js";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_RX = /^[a-z]+:[a-z0-9:]+$/i; // e.g. tmdb:movie:603, anilist:21
// Settings that follow the user across devices. Device-specific things (library folders) stay local.
const SYNCED_SETTINGS = ["preferredQuality", "autoplayNext", "reduceMotion", "animeAudio", "audioByTitle", "subtitlePref", "disabledSources", "enabledExtras"];
const QUALITIES = new Set([2160, 1080, 720, 480]);
const AUDIO = new Set(["sub", "dub"]);
const MAX_AUDIO_TITLES = 2000;
const MAX_SOURCE_IDS = 300;
const idList = (v) => Array.isArray(v) && v.length <= MAX_SOURCE_IDS && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 80);
/** Client clocks are trusted for last-write-wins, but never further ahead than this (else a bad clock locks a row forever). */
const MAX_SKEW_MS = 5 * 60_000;
const MAX_MEDIA_BYTES = 8 * 1024;
const MAX_SUBTITLE_PREF_BYTES = 2048;
const MAX_WATCHLIST = 2000;

const isPlainObject = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const SUBTITLE_ENUMS = {
  mode: new Set(["auto", "on", "off"]),
  size: new Set(["xs", "s", "m", "l", "xl"]),
  font: new Set(["sans", "serif", "mono", "rounded"]),
  bg: new Set(["glass", "box", "none"]),
  edge: new Set(["shadow", "outline", "raised", "none"]),
  preferHearingImpaired: new Set(["any", "avoid", "prefer"]),
};

function sanitizeSubtitlePref(raw) {
  if (!isPlainObject(raw)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (!serialized || serialized.length > MAX_SUBTITLE_PREF_BYTES) return null;

  const clean = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === "on" || key === "autoFetchOnline") {
      if (typeof val === "boolean") clean[key] = val;
    } else if (key in SUBTITLE_ENUMS) {
      if (typeof val === "string" && SUBTITLE_ENUMS[key].has(val)) clean[key] = val;
    } else if (key === "lang" || key === "secondaryLang") {
      if (typeof val === "string") {
        const trimmed = val.trim().toLowerCase();
        if (trimmed.length <= 24 && /^[a-z0-9_-]*$/.test(trimmed)) clean[key] = trimmed;
      }
    } else if (key === "color") {
      if (typeof val === "string") {
        const trimmed = val.trim().toLowerCase();
        if (/^#[0-9a-f]{3,8}$/.test(trimmed)) clean[key] = trimmed;
      }
    } else if (key === "bgOpacity") {
      if (typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 1) clean[key] = val;
    } else if (key === "bottomPct") {
      if (typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 100) clean[key] = val;
    } else if (key === "lineHeight") {
      if (typeof val === "number" && Number.isFinite(val) && val >= 0.5 && val <= 4) clean[key] = val;
    }
  }
  return clean;
}

/** Parse a client timestamp: reject garbage, clamp the future. */
function clientTime(v) {
  const n = Number(v ?? Date.now());
  if (!Number.isFinite(n) || n < 1_000) return null;
  return new Date(Math.min(n, Date.now() + MAX_SKEW_MS));
}
const mediaOk = (m) =>
  isPlainObject(m) && typeof m.key === "string" && KEY_RX.test(m.key) && typeof m.title === "string" && JSON.stringify(m).length <= MAX_MEDIA_BYTES;
const optInt = (v) => v === undefined || v === null || (Number.isInteger(v) && v >= 0 && v < 100_000);

/** Keep only well-formed values; a malformed field is dropped rather than stored and synced to every device. */
function sanitizeSettings(body) {
  const clean = {};
  for (const [k, v] of Object.entries(body)) {
    if (!SYNCED_SETTINGS.includes(k)) continue;
    if (k === "preferredQuality") {
      if (QUALITIES.has(v)) clean[k] = v;
    } else if (k === "autoplayNext" || k === "reduceMotion") {
      if (typeof v === "boolean") clean[k] = v;
    } else if (k === "animeAudio") {
      if (AUDIO.has(v)) clean[k] = v;
    } else if (k === "audioByTitle") {
      if (!isPlainObject(v)) continue;
      const entries = Object.entries(v).filter(([key, a]) => KEY_RX.test(key) && key.length <= 80 && AUDIO.has(a));
      if (entries.length <= MAX_AUDIO_TITLES) clean[k] = Object.fromEntries(entries);
    } else if (k === "disabledSources") {
      if (idList(v)) clean[k] = v;
    } else if (k === "enabledExtras") {
      // null means "never chosen" on the client, which is different from an empty list.
      if (v === null || idList(v)) clean[k] = v;
    } else if (k === "subtitlePref") {
      clean[k] = v; // validated separately by the route
    }
  }
  return clean;
}

export async function buildApp({ logger = true } = {}) {
  // Trust only Render's own proxy hop(s); `true` would let a client spoof X-Forwarded-For and dodge rate limits.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  const app = Fastify({ logger, bodyLimit: 64 * 1024, trustProxy: Number.isInteger(hops) && hops >= 0 && hops <= 5 ? hops : 1 });

  // Never leak SQL errors or upstream messages to clients.
  app.setErrorHandler((err, req, reply) => {
    if (err.validation || (err.statusCode && err.statusCode < 500)) return reply.code(err.statusCode ?? 400).send({ error: err.code ?? "bad_request" });
    if (err.code === "23503") return reply.code(401).send({ error: "unauthorized" }); // account deleted mid-session
    req.log.error(err);
    return reply.code(500).send({ error: "server_error" });
  });

  // Desktop app origins (Tauri on Windows uses http://tauri.localhost) plus local dev.
  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://localhost:4173").split(","),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  // Touches the DB so Render's health check notices a dead database, not just a live process.
  app.get("/health", { config: { rateLimit: false } }, async (req, reply) => {
    try {
      await q("SELECT 1");
      return { ok: true, tmdbProxy: !!process.env.TMDB_KEY };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  if (process.env.NODE_ENV !== "test") setInterval(() => pruneTokens().catch(() => {}), 6 * 3600_000).unref();

  // ---------- auth ----------
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  // Login limits run as preHandlers, i.e. after the JSON body is parsed. As an onRequest hook the
  // body was still undefined, so every client shared the one key "login:" and eight bad passwords
  // anywhere locked the whole service out for fifteen minutes.
  const loginEmail = (req) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "");
  // createRateLimit, not app.rateLimit: the plugin lets only one of its own handlers run per
  // request, and the global one has already run by now, so an app.rateLimit preHandler is a no-op.
  const loginChecks = [
    app.createRateLimit({ max: 10, timeWindow: 60_000, keyGenerator: (req) => `auth:${req.ip}` }),
    // One address guessing at one account.
    app.createRateLimit({ max: 8, timeWindow: 15 * 60_000, keyGenerator: (req) => `login:${req.ip}:${loginEmail(req)}` }),
    // Many addresses guessing at one account: generous enough that a stranger can't cheaply lock the owner out.
    app.createRateLimit({ max: 60, timeWindow: 15 * 60_000, keyGenerator: (req) => `login-any:${loginEmail(req)}` }),
  ];
  const loginLimits = async (req, reply) => {
    for (const check of loginChecks) {
      const r = await check(req);
      if (!r.isAllowed && r.isExceeded) {
        return reply.code(429).header("retry-after", String(r.ttlInSeconds)).send({ error: "rate_limited" });
      }
    }
  };
  const pwOk = (pw) => typeof pw === "string" && pw.length <= MAX_PASSWORD;

  app.post("/auth/signup", authLimit, async (req, reply) => {
    const { email = "", password = "", name = "" } = req.body ?? {};
    const em = String(email).trim().toLowerCase();
    if (!EMAIL_RX.test(em)) return reply.code(400).send({ error: "invalid_email" });
    if (!pwOk(password)) return reply.code(400).send({ error: "password_too_long" });
    if (password.length < 8) return reply.code(400).send({ error: "weak_password" });
    const nm = String(name).trim().slice(0, 40) || em.split("@")[0];
    const hue = Math.floor(Math.random() * 360);
    try {
      // One statement, so a user row never exists without its settings row.
      const { rows } = await q(
        `WITH u AS (INSERT INTO users (email, name, password_hash, avatar_hue) VALUES ($1, $2, $3, $4) RETURNING *),
              s AS (INSERT INTO user_settings (user_id) SELECT id FROM u)
         SELECT * FROM u`,
        [em, nm, await hashPassword(password), hue],
      );
      return { user: publicUser(rows[0]), ...(await issueTokens(rows[0], req.headers["user-agent"])) };
    } catch (e) {
      if (e.code === "23505") return reply.code(409).send({ error: "email_taken" });
      throw e;
    }
  });

  app.post("/auth/login", { preHandler: loginLimits }, async (req, reply) => {
    const { email = "", password = "" } = req.body ?? {};
    if (!pwOk(password)) return reply.code(401).send({ error: "bad_credentials" });
    const { rows } = await q(`SELECT * FROM users WHERE lower(email) = lower($1)`, [String(email).trim()]);
    const u = rows[0];
    // Compare against a dummy hash when the user doesn't exist so timing doesn't leak which emails are registered.
    const ok = await checkPassword(password, u?.password_hash ?? "$2a$11$C6UzMDM.H6dfI/f/IKcEeO7Q9rG2n3Yw2yQq1uQ0eY0uC5mJ8Z7xW");
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

  app.post("/auth/logout-all", { preHandler: requireUser }, async (req) => {
    await revokeAll(req.userId);
    return { ok: true };
  });

  // ---------- account ----------
  app.get("/me", { preHandler: requireUser }, async (req, reply) => {
    const { rows } = await q(`SELECT * FROM users WHERE id = $1`, [req.userId]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    return { user: publicUser(rows[0]) };
  });

  app.patch("/me", { preHandler: requireUser }, async (req, reply) => {
    const { name, avatarHue } = req.body ?? {};
    const { rows } = await q(
      `UPDATE users SET name = COALESCE($2, name), avatar_hue = COALESCE($3, avatar_hue) WHERE id = $1 RETURNING *`,
      [req.userId, typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : null, Number.isInteger(avatarHue) ? ((avatarHue % 360) + 360) % 360 : null],
    );
    if (!rows[0]) return reply.code(404).send({ error: "not_found" }); // account deleted on another device
    return { user: publicUser(rows[0]) };
  });

  app.delete("/me", { preHandler: requireUser }, async (req) => {
    await q(`DELETE FROM users WHERE id = $1`, [req.userId]);
    forgetTokenVersion(req.userId);
    return { ok: true };
  });

  // ---------- sync ----------
  app.get("/sync", { preHandler: requireUser }, async (req) => {
    const [p, w, s, pd, wd] = await Promise.all([
      q(`SELECT media_key, data, updated_at FROM progress WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500`, [req.userId]),
      q(`SELECT media_key, media, added_at FROM watchlist WHERE user_id = $1 AND deleted_at IS NULL ORDER BY added_at DESC LIMIT ${MAX_WATCHLIST}`, [req.userId]),
      q(`SELECT data FROM user_settings WHERE user_id = $1`, [req.userId]),
      q(`SELECT media_key, deleted_at FROM progress WHERE user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`, [req.userId]),
      q(`SELECT media_key, deleted_at FROM watchlist WHERE user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`, [req.userId]),
    ]);
    const tomb = (rows) => rows.map((r) => ({ key: r.media_key, deletedAt: new Date(r.deleted_at).getTime() }));
    return {
      progress: p.rows.map((r) => ({ ...r.data, updatedAt: new Date(r.updated_at).getTime() })),
      watchlist: w.rows.map((r) => ({ media: r.media, addedAt: new Date(r.added_at).getTime() })),
      settings: s.rows[0]?.data ?? {},
      // Deleted on some device: other devices drop their copy instead of pushing it back.
      progressDeleted: tomb(pd.rows),
      watchlistDeleted: tomb(wd.rows),
    };
  });

  app.put("/progress/:key", { preHandler: requireUser }, async (req, reply) => {
    const key = req.params.key;
    const e = req.body ?? {};
    const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e7;
    if (!KEY_RX.test(key) || !num(e.position) || !num(e.duration)) return reply.code(400).send({ error: "bad_request" });
    const updatedAt = clientTime(e.updatedAt);
    // Every client reads `media.key` off these rows: a row without its title would break their sync.
    if (!updatedAt || !mediaOk(e.media) || !optInt(e.season) || !optInt(e.episode)) return reply.code(400).send({ error: "bad_request" });
    if (e.audio !== undefined && e.audio !== null && !AUDIO.has(e.audio)) return reply.code(400).send({ error: "bad_request" });
    // Last write wins, but never let an older device overwrite a newer one.
    await q(
      `INSERT INTO progress (user_id, media_key, data, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, media_key) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, deleted_at = NULL
       WHERE progress.updated_at < EXCLUDED.updated_at
         AND (progress.deleted_at IS NULL OR progress.deleted_at < EXCLUDED.updated_at)`,
      [req.userId, key, JSON.stringify({ media: e.media, season: e.season ?? undefined, episode: e.episode ?? undefined, audio: e.audio ?? undefined, position: e.position, duration: e.duration, ...(e.upNext === true ? { upNext: true } : {}), ...(e.finished === true ? { finished: true } : {}) }), updatedAt],
    );
    return { ok: true };
  });

  app.delete("/progress/:key", { preHandler: requireUser }, async (req) => {
    // Soft delete: the tombstone tells other devices this was removed (a newer watch revives it).
    await q(`UPDATE progress SET deleted_at = now() WHERE user_id = $1 AND media_key = $2 AND deleted_at IS NULL`, [req.userId, req.params.key]);
    return { ok: true };
  });

  app.put("/watchlist/:key", { preHandler: requireUser }, async (req, reply) => {
    const key = req.params.key;
    if (!KEY_RX.test(key) || !mediaOk(req.body?.media)) return reply.code(400).send({ error: "bad_request" });
    // One statement: the cap is checked and the row written together, so two devices adding at
    // once can't both slip past it; an existing row refreshes its artwork instead of going stale.
    const { rowCount } = await q(
      `INSERT INTO watchlist (user_id, media_key, media)
       SELECT $1, $2, $3::jsonb
       WHERE (SELECT count(*) FROM watchlist WHERE user_id = $1 AND deleted_at IS NULL) < $4
          OR EXISTS (SELECT 1 FROM watchlist WHERE user_id = $1 AND media_key = $2 AND deleted_at IS NULL)
       ON CONFLICT (user_id, media_key) DO UPDATE SET
         media = EXCLUDED.media,
         added_at = CASE WHEN watchlist.deleted_at IS NULL THEN watchlist.added_at ELSE now() END,
         deleted_at = NULL`,
      [req.userId, key, JSON.stringify(req.body.media), MAX_WATCHLIST],
    );
    if (!rowCount) return reply.code(413).send({ error: "watchlist_full" });
    return { ok: true };
  });

  app.delete("/watchlist/:key", { preHandler: requireUser }, async (req) => {
    await q(`UPDATE watchlist SET deleted_at = now() WHERE user_id = $1 AND media_key = $2 AND deleted_at IS NULL`, [req.userId, req.params.key]);
    return { ok: true };
  });

  app.put("/settings", { preHandler: requireUser }, async (req, reply) => {
    const body = req.body ?? {};
    if (!isPlainObject(body)) return reply.code(400).send({ error: "bad_request" });
    const clean = sanitizeSettings(body);
    if ("subtitlePref" in clean) {
      const sanitized = sanitizeSubtitlePref(clean.subtitlePref);
      if (!sanitized) return reply.code(400).send({ error: "bad_request" });
      clean.subtitlePref = sanitized;
    }
    await q(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || EXCLUDED.data, updated_at = now()`,
      [req.userId, JSON.stringify(clean)],
    );
    return { ok: true };
  });

  // ---------- catalog proxy ----------
  // Lets every signed-in user browse TMDB without their own key, if TMDB_KEY is set on the server.
  app.get("/tmdb/*", { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: (req) => req.userId ?? req.ip } } }, tmdbProxy);

  return app;
}
