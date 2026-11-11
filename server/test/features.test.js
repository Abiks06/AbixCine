// Password reset, email verification, watch history, anime ID map, OAuth plumbing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";
process.env.NODE_ENV ??= "test";
process.env.PGLITE_DIR ??= "./data/pglite-features";
process.env.ANIME_LIST_FILE = fileURLToPath(new URL("./fixtures/anime-list.json", import.meta.url));
const { buildApp } = await import("../src/app.js");
const { migrate, pool, q } = await import("../src/db.js");
const { devOutbox } = await import("../src/mail.js");
const { accountFor } = await import("../src/oauth.js");

let app;
const email = `f${Date.now()}@example.com`;
const oauthEmail = `o${Date.now()}@example.com`;
let tokens;

before(async () => {
  await migrate();
  app = await buildApp({ logger: false });
});
after(async () => {
  await q(`DELETE FROM users WHERE email = ANY($1)`, [[email, oauthEmail]]);
  await app.close();
  await pool.end();
});

const call = (method, url, body, token) =>
  app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
const lastCode = (to) => devOutbox.filter((m) => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];

test("signup sends a verification code; verify confirms the address", async () => {
  let r = await call("POST", "/auth/signup", { email, password: "first password", name: "F" });
  assert.equal(r.statusCode, 200);
  tokens = r.json();
  assert.equal(tokens.user.emailVerified, false);
  assert.equal(tokens.user.hasPassword, true);
  // The mail goes out in the background.
  await new Promise((res) => setTimeout(res, 50));
  const code = lastCode(email);
  assert.ok(code, "verification mail");
  r = await call("POST", "/auth/verify", { code: "000000" === code ? "111111" : "000000" }, tokens.accessToken);
  assert.equal(r.statusCode, 400);
  r = await call("POST", "/auth/verify", { code }, tokens.accessToken);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().user.emailVerified, true);
});

test("forgot + reset: same answer for unknown emails, code works once, old sessions end", async () => {
  let r = await call("POST", "/auth/forgot", { email: "nobody-here@example.com" });
  assert.equal(r.statusCode, 200);
  r = await call("POST", "/auth/forgot", { email: email.toUpperCase() });
  assert.equal(r.statusCode, 200);
  const code = lastCode(email);
  assert.ok(code);
  r = await call("POST", "/auth/reset", { email, code: "12345", password: "second password" });
  assert.equal(r.statusCode, 400);
  r = await call("POST", "/auth/reset", { email, code, password: "second password" });
  assert.equal(r.statusCode, 200);
  const fresh = r.json();
  // Used up.
  r = await call("POST", "/auth/reset", { email, code, password: "third password" });
  assert.equal(r.statusCode, 400);
  // The old access token was signed out everywhere.
  assert.equal((await call("GET", "/me", null, tokens.accessToken)).statusCode, 401);
  assert.equal((await call("POST", "/auth/login", { email, password: "first password" })).statusCode, 401);
  assert.equal((await call("POST", "/auth/login", { email, password: "second password" })).statusCode, 200);
  tokens = fresh;
});

test("five wrong codes burn a reset code", async () => {
  await call("POST", "/auth/forgot", { email });
  const code = lastCode(email);
  for (let i = 0; i < 5; i++) await call("POST", "/auth/reset", { email, code: code === "999999" ? "999998" : "999999", password: "whatever pw" });
  const r = await call("POST", "/auth/reset", { email, code, password: "whatever pw" });
  assert.equal(r.statusCode, 400);
});

test("watch history: per-episode rows, newest wins, delete", async () => {
  const t = tokens.accessToken;
  const media = { key: "tmdb:tv:1399", kind: "tv", title: "GoT", genres: [], overview: "" };
  let r = await call("PUT", "/history/tmdb:tv:1399", { media, entries: [
    { ep: "s1e1", season: 1, episode: 1, position: 3000, duration: 3100, watched: true, at: 2000 },
    { ep: "s1e2", season: 1, episode: 2, position: 100, duration: 3100, watched: false, at: 3000 },
  ] }, t);
  assert.equal(r.statusCode, 200);
  // Older write for s1e1 is ignored.
  await call("PUT", "/history/tmdb:tv:1399", { media, entries: [{ ep: "s1e1", position: 0, duration: 3100, watched: false, at: 1000 }] }, t);
  r = await call("PUT", "/history/tmdb:tv:1399", { media, entries: [{ ep: "../x", position: 0, duration: 1, at: 1 }] }, t);
  assert.equal(r.statusCode, 400);
  let s = (await call("GET", "/sync", null, t)).json();
  const e1 = s.history.find((h) => h.ep === "s1e1");
  assert.equal(e1.watched, true);
  assert.equal(e1.key, "tmdb:tv:1399");
  assert.equal(s.history.length, 2);
  await call("DELETE", "/history/tmdb:tv:1399?ep=s1e2", null, t);
  s = (await call("GET", "/sync", null, t)).json();
  assert.deepEqual(s.history.map((h) => h.ep), ["s1e1"]);
  await call("DELETE", "/history", null, t);
  assert.equal((await call("GET", "/sync", null, t)).json().history.length, 0);
});

test("progress keeps up-next and finished flags", async () => {
  const t = tokens.accessToken;
  const media = { key: "anilist:16498", kind: "anime", title: "AoT", genres: [], overview: "" };
  await call("PUT", "/progress/anilist:16498", { media, episode: 25, position: 0, duration: 1400, finished: true, updatedAt: Date.now() }, t);
  const p = (await call("GET", "/sync", null, t)).json().progress.find((x) => x.media.key === "anilist:16498");
  assert.equal(p.finished, true);
});

test("anime id map", async () => {
  let r = await call("GET", "/idmap/anilist/20958");
  assert.equal(r.statusCode, 200);
  const e = r.json();
  assert.equal(e.mal, 25777);
  assert.equal(e.tmdbTv, 1429);
  assert.equal(e.season.tvdb, 2);
  assert.deepEqual(e.seasons.map((x) => x.anilist), [16498, 20958]);
  r = await call("GET", "/idmap/tmdb?kind=tv&ids=1429,5");
  assert.deepEqual(Object.keys(r.json().map), ["1429"]);
  assert.equal(r.json().map[1429][0].anilist, 16498);
  r = await call("GET", "/idmap/tmdb?kind=movie&ids=372058");
  assert.equal(r.json().map[372058][0].anilist, 21519);
  assert.equal((await call("GET", "/idmap/anilist/1")).statusCode, 404);
  assert.equal((await call("GET", "/idmap/anilist/abc")).statusCode, 400);
});

test("oauth: unconfigured providers are hidden; accounts link by verified email", async () => {
  const h = (await call("GET", "/health")).json();
  assert.deepEqual(h.oauth, []);
  assert.equal(h.mail, true);
  assert.equal((await call("POST", "/auth/oauth/google/start")).statusCode, 404);
  assert.equal((await call("POST", "/auth/oauth/poll", { state: "x", poll: "y" })).statusCode, 404);
  // Same email as the password account: same user.
  const a = await accountFor("google", { subject: "g-1", email: email.toUpperCase(), verified: true, name: "G" });
  const { rows } = await q(`SELECT id FROM users WHERE email = $1`, [email]);
  assert.equal(a.id, rows[0].id);
  // New email: a new account with no password, which can't log in with one.
  const b = await accountFor("discord", { subject: "d-1", email: oauthEmail, verified: true, name: "D" });
  assert.equal(b.password_hash, null);
  assert.equal((await call("POST", "/auth/login", { email: oauthEmail, password: "anything at all" })).statusCode, 401);
  // Second sign-in finds it by identity.
  const again = await accountFor("discord", { subject: "d-1", email: "changed@example.com", verified: true });
  assert.equal(again.id, b.id);
});
