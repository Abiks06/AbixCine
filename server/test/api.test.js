// Integration test against a real Postgres: DATABASE_URL=... JWT_SECRET=... npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";
const { buildApp } = await import("../src/app.js");
const { migrate, pool, q } = await import("../src/db.js");

let app;
const email = `t${Date.now()}@example.com`;
let tokens;

before(async () => {
  await migrate();
  app = await buildApp({ logger: false });
});
after(async () => {
  await q(`DELETE FROM users WHERE email = $1`, [email]);
  await app.close();
  await pool.end();
});

const call = (method, url, body, token) =>
  app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });

test("signup, duplicate, login", async () => {
  let r = await call("POST", "/auth/signup", { email, password: "short" });
  assert.equal(r.statusCode, 400);
  r = await call("POST", "/auth/signup", { email, password: "correct horse", name: "Ayo" });
  assert.equal(r.statusCode, 200);
  tokens = r.json();
  assert.equal(tokens.user.name, "Ayo");
  r = await call("POST", "/auth/signup", { email: email.toUpperCase(), password: "correct horse" });
  assert.equal(r.statusCode, 409);
  r = await call("POST", "/auth/login", { email, password: "wrong pass" });
  assert.equal(r.statusCode, 401);
  r = await call("POST", "/auth/login", { email, password: "correct horse" });
  assert.equal(r.statusCode, 200);
});

test("auth required", async () => {
  assert.equal((await call("GET", "/me")).statusCode, 401);
  assert.equal((await call("GET", "/me", null, "garbage")).statusCode, 401);
  assert.equal((await call("GET", "/me", null, tokens.accessToken)).json().user.email, email);
});

test("progress sync keeps the newest write", async () => {
  const t = tokens.accessToken;
  const media = { key: "anilist:21", kind: "anime", title: "X", genres: [], overview: "" };
  await call("PUT", "/progress/anilist:21", { media, episode: 3, audio: "dub", position: 100, duration: 1400, updatedAt: 2000 }, t);
  await call("PUT", "/progress/anilist:21", { media, episode: 2, position: 50, duration: 1400, updatedAt: 1000 }, t); // older, ignored
  await call("PUT", "/watchlist/tmdb:movie:603", { media: { ...media, key: "tmdb:movie:603" } }, t);
  await call("PUT", "/settings", { preferredQuality: 720, animeAudio: "dub", libraryPaths: ["C:/x"] }, t);
  const s = (await call("GET", "/sync", null, t)).json();
  assert.equal(s.progress[0].episode, 3);
  assert.equal(s.progress[0].audio, "dub");
  assert.equal(s.watchlist.length, 1);
  assert.deepEqual(s.settings, { preferredQuality: 720, animeAudio: "dub" }); // libraryPaths stays local
});

test("refresh rotation and reuse detection", async () => {
  let r = await call("POST", "/auth/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(r.statusCode, 200);
  const next = r.json();
  r = await call("POST", "/auth/refresh", { refreshToken: tokens.refreshToken }); // reuse of old token
  assert.equal(r.statusCode, 401);
  r = await call("POST", "/auth/refresh", { refreshToken: next.refreshToken }); // family revoked
  assert.equal(r.statusCode, 401);
});

test("tmdb proxy is off without a key", async () => {
  delete process.env.TMDB_KEY;
  const r = await call("GET", "/tmdb/movie/popular", null, tokens.accessToken);
  assert.equal(r.statusCode, 501);
});
