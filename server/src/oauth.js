import crypto from "node:crypto";
import { issueTokens, publicUser } from "./auth.js";
import { q } from "./db.js";

/**
 * "Continue with Google / Discord" for a desktop app, without a local web server:
 *
 *  1. The app calls POST /auth/oauth/:provider/start and gets { url, state, poll }.
 *  2. It opens `url` in the system browser. The provider sends the browser back to
 *     /auth/oauth/:provider/callback here, which exchanges the code (PKCE + client secret),
 *     reads the verified email, finds or creates the account, and shows "you can close this tab".
 *  3. Meanwhile the app polls POST /auth/oauth/poll with { state, poll }. The poll secret never
 *     touches the browser, so someone who sees the redirect URL can't collect the tokens.
 *
 * Accounts link by verified email: signing in with Google as the address you signed up with
 * opens that same account. A provider only shows up once its client id and secret are set.
 */
const PROVIDERS = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    profile: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    read: (p) => ({ subject: String(p.sub ?? ""), email: p.email, verified: p.email_verified === true || p.email_verified === "true", name: p.name || p.given_name }),
  },
  discord: {
    auth: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    profile: "https://discord.com/api/users/@me",
    scope: "identify email",
    id: () => process.env.DISCORD_CLIENT_ID,
    secret: () => process.env.DISCORD_CLIENT_SECRET,
    read: (p) => ({ subject: String(p.id ?? ""), email: p.email, verified: p.verified === true, name: p.global_name || p.username }),
  },
};

const PENDING_TTL_MIN = 10;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64url = (buf) => buf.toString("base64url");
const publicUrl = () => (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");

export const oauthProviders = () => (publicUrl() ? Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].id() && PROVIDERS[k].secret()) : []);

const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#06070b;color:#eef;font-family:system-ui,sans-serif">
<div style="text-align:center;max-width:420px;padding:24px"><div style="font:800 28px system-ui;letter-spacing:-.02em;margin-bottom:8px">Abix<span style="color:#8b6cff">Cine</span></div>
<h1 style="font-size:20px;margin:16px 0 8px">${title}</h1><p style="color:#aab">${msg}</p></div></body>`;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Find the account for this identity, linking by verified email, or create one. */
export async function accountFor(provider, prof) {
  const { rows: idn } = await q(`SELECT u.* FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.subject = $2`, [provider, prof.subject]);
  if (idn[0]) return idn[0];
  const email = String(prof.email).trim().toLowerCase();
  let { rows } = await q(`SELECT * FROM users WHERE lower(email) = $1`, [email]);
  let user = rows[0];
  if (!user) {
    const name = String(prof.name || email.split("@")[0]).trim().slice(0, 40);
    ({ rows } = await q(
      `WITH u AS (INSERT INTO users (email, name, password_hash, avatar_hue, email_verified_at) VALUES ($1, $2, NULL, $3, now()) RETURNING *),
            s AS (INSERT INTO user_settings (user_id) SELECT id FROM u)
       SELECT * FROM u`,
      [email, name, Math.floor(Math.random() * 360)],
    ));
    user = rows[0];
  } else if (!user.email_verified_at) {
    ({ rows } = await q(`UPDATE users SET email_verified_at = now() WHERE id = $1 RETURNING *`, [user.id]));
    user = rows[0];
  }
  await q(`INSERT INTO user_identities (provider, subject, user_id, email) VALUES ($1, $2, $3, $4) ON CONFLICT (provider, subject) DO NOTHING`, [provider, prof.subject, user.id, email]);
  return user;
}

export function registerOAuth(app) {
  const limit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/auth/oauth/:provider/start", limit, async (req, reply) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p || !oauthProviders().includes(name)) return reply.code(404).send({ error: "provider_unavailable" });
    const state = b64url(crypto.randomBytes(24));
    const poll = b64url(crypto.randomBytes(32));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    await q(`DELETE FROM oauth_pending WHERE created_at < now() - interval '1 hour'`);
    await q(`INSERT INTO oauth_pending (state, provider, poll_hash, verifier) VALUES ($1, $2, $3, $4)`, [state, name, sha256(poll), verifier]);
    const u = new URL(p.auth);
    u.search = new URLSearchParams({
      client_id: p.id(),
      redirect_uri: `${publicUrl()}/auth/oauth/${name}/callback`,
      response_type: "code",
      scope: p.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: name === "google" ? "select_account" : "consent",
    }).toString();
    return { url: u.toString(), state, poll };
  });

  app.get("/auth/oauth/:provider/callback", limit, async (req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    const name = req.params.provider;
    const p = PROVIDERS[name];
    const { code, state, error } = req.query ?? {};
    const { rows } = await q(
      `SELECT * FROM oauth_pending WHERE state = $1 AND provider = $2 AND user_id IS NULL AND error IS NULL AND created_at > now() - ($3 || ' minutes')::interval`,
      [String(state ?? ""), String(name), String(PENDING_TTL_MIN)],
    );
    const pending = rows[0];
    if (!p || !pending) return reply.code(400).send(page("This sign-in link expired", "Go back to AbixCine and press the button again."));
    const fail = async (why, msg) => {
      await q(`UPDATE oauth_pending SET error = $2 WHERE state = $1`, [pending.state, why]);
      return reply.code(400).send(page("Couldn't sign you in", escape(msg)));
    };
    if (error || !code) return fail("denied", "Sign-in was cancelled. You can close this tab and try again in AbixCine.");
    try {
      const tok = await fetch(p.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: `${publicUrl()}/auth/oauth/${name}/callback`,
          client_id: p.id(),
          client_secret: p.secret(),
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))));
      const prof = p.read(
        await fetch(p.profile, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) }).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`profile ${r.status}`)),
        ),
      );
      if (!prof.subject || !prof.email) return fail("no_email", `Your ${name === "google" ? "Google" : "Discord"} account didn't share an email address.`);
      if (!prof.verified) return fail("unverified_email", `Verify your email with ${name === "google" ? "Google" : "Discord"} first, then try again.`);
      const user = await accountFor(name, prof);
      await q(`UPDATE oauth_pending SET user_id = $2 WHERE state = $1`, [pending.state, user.id]);
      return reply.send(page("You're signed in", "Go back to AbixCine. You can close this tab."));
    } catch (e) {
      req.log.warn({ err: e }, "oauth callback failed");
      return fail("provider_error", "The sign-in service didn't answer. Close this tab and try again.");
    }
  });

  /** The app asks until the browser part is done. */
  app.post("/auth/oauth/poll", { config: { rateLimit: { max: 90, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { state = "", poll = "" } = req.body ?? {};
    const { rows } = await q(`SELECT * FROM oauth_pending WHERE state = $1 AND poll_hash = $2`, [String(state), sha256(String(poll))]);
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: "unknown_state" });
    if (Date.now() - new Date(r.created_at).getTime() > PENDING_TTL_MIN * 60_000 && !r.user_id) {
      await q(`DELETE FROM oauth_pending WHERE state = $1`, [r.state]);
      return reply.code(410).send({ error: "expired" });
    }
    if (r.error) {
      await q(`DELETE FROM oauth_pending WHERE state = $1`, [r.state]);
      return reply.code(400).send({ error: r.error });
    }
    if (!r.user_id) return { pending: true };
    // One-time: the row goes as the tokens are handed over.
    const { rows: del } = await q(`DELETE FROM oauth_pending WHERE state = $1 AND user_id IS NOT NULL RETURNING user_id`, [r.state]);
    if (!del[0]) return reply.code(404).send({ error: "unknown_state" });
    const { rows: u } = await q(`SELECT * FROM users WHERE id = $1`, [del[0].user_id]);
    if (!u[0]) return reply.code(404).send({ error: "unknown_state" });
    return { user: publicUser(u[0]), ...(await issueTokens(u[0], req.headers["user-agent"])) };
  });
}
