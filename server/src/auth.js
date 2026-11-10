import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { q } from "./db.js";

const DEV = !process.env.DATABASE_URL && process.env.NODE_ENV !== "production";
// Local dev gets a fixed throwaway secret; anything deployed must set its own.
const SECRET = process.env.JWT_SECRET ?? (DEV ? "abixcine-local-dev-secret-not-for-production" : undefined);
if (!SECRET || SECRET.length < 32) throw new Error("JWT_SECRET must be set (32+ characters)");

const ACCESS_TTL = "15m";
const REFRESH_DAYS = 60;

export const hashPassword = (pw) => bcrypt.hash(pw, 11);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, avatarHue: u.avatar_hue, createdAt: u.created_at };
}

/** Short-lived JWT for API calls plus a long-lived opaque refresh token (stored hashed, rotated on use). */
export async function issueTokens(user, device) {
  const accessToken = jwt.sign({ sub: user.id }, SECRET, { expiresIn: ACCESS_TTL, algorithm: "HS256" });
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  await q(
    `INSERT INTO refresh_tokens (user_id, token_hash, device, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [user.id, sha256(refreshToken), device?.slice(0, 120) ?? null, String(REFRESH_DAYS)],
  );
  return { accessToken, refreshToken, expiresIn: 900 };
}

/** Exchange a refresh token for a new pair. Reusing a revoked token revokes the whole family (theft signal). */
export async function rotateRefresh(token, device) {
  const { rows } = await q(
    `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at, u.* FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) {
    await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
    return null;
  }
  if (new Date(row.expires_at) < new Date()) return null;
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)]);
  const user = { ...row, id: row.user_id };
  return { user: publicUser(user), ...(await issueTokens(user, device)) };
}

export async function revokeRefresh(token) {
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
}

/** Fastify preHandler: requires a valid Bearer access token, sets req.userId. */
export async function requireUser(req, reply) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return reply.code(401).send({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ["HS256"] });
    req.userId = payload.sub;
  } catch {
    return reply.code(401).send({ error: "token_expired" });
  }
}
