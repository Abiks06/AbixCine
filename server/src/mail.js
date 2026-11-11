import crypto from "node:crypto";
import { q } from "./db.js";

/**
 * Email for sign-in codes (password reset, address verification).
 *
 * Production sends through Resend (https://resend.com, free tier 3k mails/month): set
 * RESEND_API_KEY and MAIL_FROM ("AbixCine <hello@your-domain>", a domain verified in Resend).
 * Without a key, local dev and tests print the mail to the log instead, and production reports
 * mail as unavailable so the app hides the flows that need it.
 */
const PROD = process.env.NODE_ENV === "production";
export const mailEnabled = () => !!process.env.RESEND_API_KEY || !PROD;

/** Mails "sent" without a provider, newest last (tests read the code from here). */
export const devOutbox = [];

export async function sendMail({ to, subject, text, html }) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM ?? "AbixCine <onboarding@resend.dev>", to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`mail provider ${res.status}`);
    return;
  }
  if (PROD) throw new Error("mail_disabled");
  devOutbox.push({ to, subject, text });
  if (devOutbox.length > 50) devOutbox.shift();
  if (process.env.NODE_ENV !== "test") console.log(`[mail] to ${to}: ${subject}\n${text}`);
}

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const hash = (userId, code) => crypto.createHash("sha256").update(`${userId}:${code}`).digest("hex");

/** A fresh 6-digit code for this purpose; any earlier unused one stops working. */
export async function createCode(userId, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await q(`UPDATE email_codes SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await q(
    `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [userId, purpose, hash(userId, code), String(CODE_TTL_MIN)],
  );
  return code;
}

/** True once for a correct, unexpired code. Five wrong guesses burn the code. */
export async function useCode(userId, purpose, code) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return false;
  const { rows } = await q(
    `UPDATE email_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM email_codes WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
                  ORDER BY created_at DESC LIMIT 1)
      RETURNING id, code_hash, attempts`,
    [userId, purpose],
  );
  const r = rows[0];
  if (!r || r.attempts > MAX_ATTEMPTS) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(r.code_hash), Buffer.from(hash(userId, String(code))));
  if (ok) await q(`UPDATE email_codes SET used_at = now() WHERE id = $1`, [r.id]);
  return ok;
}

const wrap = (title, body, code) => ({
  text: `${body}\n\n${code}\n\nThe code works for ${CODE_TTL_MIN} minutes. If you didn't ask for it, ignore this email.\n\nAbixCine`,
  html: `<div style="font-family:system-ui,sans-serif;max-width:440px;margin:auto;padding:24px;color:#111">
    <h2 style="margin:0 0 12px">${title}</h2><p>${body}</p>
    <p style="font:700 32px/1 ui-monospace,monospace;letter-spacing:6px;margin:24px 0">${code}</p>
    <p style="color:#666;font-size:13px">The code works for ${CODE_TTL_MIN} minutes. If you didn't ask for it, ignore this email.</p></div>`,
});

export const resetMail = (code) => ({ subject: `${code} is your AbixCine reset code`, ...wrap("Reset your password", "Enter this code in AbixCine to choose a new password:", code) });
export const verifyMail = (code) => ({ subject: `${code} is your AbixCine verification code`, ...wrap("Confirm your email", "Enter this code in AbixCine to confirm this is your address:", code) });
