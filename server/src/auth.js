import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { q } from "./db.js";

const PROD = process.env.NODE_ENV === "production";
const DEV = !process.env.DATABASE_URL && !PROD;
if (PROD && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
// Local dev gets a fixed throwaway secret; anything deployed must set its own.
const SECRET = process.env.JWT_SECRET ?? (DEV ? "abixcine-local-dev-secret-not-for-production" : undefined);
if (!SECRET || SECRET.length < 32) throw new Error("JWT_SECRET must be set (32+ characters)");
if (PROD && /change-me|not-for-production/.test(SECRET)) throw new Error("JWT_SECRET is a placeholder; generate a real one");

const ACCESS_TTL = "15m";
const REFRESH_DAYS = 60;
/** A rotated token presented again within this window is a lost response / retry, not theft. */
const REUSE_GRACE_MS = 30_000;
/** bcrypt only reads 72 bytes; longer inputs just burn CPU. */
export const MAX_PASSWORD = 128;

export const hashPassword = (pw) => bcrypt.hash(pw, 11);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, avatarHue: u.avatar_hue, createdAt: u.created_at, emailVerified: !!u.email_verified_at, hasPassword: !!u.password_hash };
}

/**
 * Short-lived JWT for API calls plus a long-lived opaque refresh token (stored hashed, rotated on use).
 * Each sign-in starts a token family; rotations stay in it so theft detection only kills that device's chain.
 */
export async function issueTokens(user, device, familyId = crypto.randomUUID()) {
  const accessToken = jwt.sign({ sub: user.id, ver: user.token_version ?? 0 }, SECRET, { expiresIn: ACCESS_TTL, algorithm: "HS256" });
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  await q(
    `INSERT INTO refresh_tokens (user_id, token_hash, device, family_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)`,
    [user.id, sha256(refreshToken), device?.slice(0, 120) ?? null, familyId, String(REFRESH_DAYS)],
  );
  return { accessToken, refreshToken, expiresIn: 900 };
}

/**
 * Exchange a refresh token for a new pair. The revoke is a single conditional UPDATE, so two
 * concurrent refreshes with the same token can't both win. Presenting an already-rotated token
 * after the grace window revokes that token's family (theft signal).
 */
export async function rotateRefresh(token, device) {
  const h = sha256(token);
  const { rows } = await q(
    `UPDATE refresh_tokens SET revoked_at = now(), replaced_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id, family_id`,
    [h],
  );
  if (!rows[0]) {
    const { rows: old } = await q(`SELECT family_id, replaced_at FROM refresh_tokens WHERE token_hash = $1`, [h]);
    const o = old[0];
    if (o?.replaced_at && Date.now() - new Date(o.replaced_at).getTime() > REUSE_GRACE_MS) {
      await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [o.family_id]);
    }
    return null;
  }
  const { rows: u } = await q(`SELECT * FROM users WHERE id = $1`, [rows[0].user_id]);
  if (!u[0]) return null;
  return { user: publicUser(u[0]), ...(await issueTokens(u[0], device, rows[0].family_id ?? undefined)) };
}

export async function revokeRefresh(token) {
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
}

/** Sign out everywhere: bump the token version (kills access tokens) and revoke every refresh token. */
export async function revokeAll(userId) {
  await q(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId]);
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

/**
 * Fastify preHandler: requires a valid Bearer access token, sets req.userId.
 * One indexed lookup confirms the account still exists and the token wasn't revoked by sign-out-everywhere.
 */
export async function requireUser(req, reply) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return reply.code(401).send({ error: "unauthorized" });
  let payload;
  try {
    payload = jwt.verify(token, SECRET, { algorithms: ["HS256"] });
  } catch {
    return reply.code(401).send({ error: "token_expired" });
  }
  const { rows } = await q(`SELECT token_version FROM users WHERE id = $1`, [payload.sub]);
  if (!rows[0] || rows[0].token_version !== (payload.ver ?? 0)) return reply.code(401).send({ error: "unauthorized" });
  req.userId = payload.sub;
}

/** Housekeeping: expired and long-revoked refresh tokens, spent email codes and abandoned sign-ins are dead weight. */
export const pruneTokens = async () => {
  await q(`DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`);
  await q(`DELETE FROM email_codes WHERE expires_at < now() - interval '1 day'`);
  await q(`DELETE FROM oauth_pending WHERE created_at < now() - interval '1 hour'`);
};
