// Integration test against a real Postgres: DATABASE_URL=... JWT_SECRET=... npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";
process.env.NODE_ENV ??= "test";
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

test("deletes leave tombstones so another device's sync can't resurrect them", async () => {
  const t = tokens.accessToken;
  const media = { key: "tmdb:tv:1399", kind: "tv", title: "GoT", genres: [], overview: "" };
  const now = Date.now();
  await call("PUT", "/progress/tmdb:tv:1399", { media, season: 1, episode: 1, position: 10, duration: 3000, updatedAt: now - 5000 }, t);
  await call("PUT", "/watchlist/tmdb:tv:1399", { media }, t);
  await call("DELETE", "/progress/tmdb:tv:1399", null, t);
  await call("DELETE", "/watchlist/tmdb:tv:1399", null, t);

  let s = (await call("GET", "/sync", null, t)).json();
  assert.equal(s.progress.some((p) => p.media.key === "tmdb:tv:1399"), false);
  assert.equal(s.watchlist.some((w) => w.media.key === "tmdb:tv:1399"), false);
  assert.ok(s.progressDeleted.some((d) => d.key === "tmdb:tv:1399" && d.deletedAt > 0));
  assert.ok(s.watchlistDeleted.some((d) => d.key === "tmdb:tv:1399"));

  // A stale device pushing its older copy doesn't bring the progress back...
  await call("PUT", "/progress/tmdb:tv:1399", { media, season: 1, episode: 1, position: 10, duration: 3000, updatedAt: now - 4000 }, t);
  s = (await call("GET", "/sync", null, t)).json();
  assert.equal(s.progress.some((p) => p.media.key === "tmdb:tv:1399"), false);

  // ...but watching it again (a newer write) and re-adding it to the list do.
  await call("PUT", "/progress/tmdb:tv:1399", { media, season: 1, episode: 2, position: 20, duration: 3000, updatedAt: Date.now() + 1000 }, t);
  await call("PUT", "/watchlist/tmdb:tv:1399", { media }, t);
  s = (await call("GET", "/sync", null, t)).json();
  assert.equal(s.progress.find((p) => p.media.key === "tmdb:tv:1399")?.episode, 2);
  assert.ok(s.watchlist.some((w) => w.media.key === "tmdb:tv:1399"));
  assert.equal(s.watchlistDeleted.some((d) => d.key === "tmdb:tv:1399"), false);
});

test("refresh rotation, retry grace and reuse detection", async () => {
  let r = await call("POST", "/auth/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(r.statusCode, 200);
  const next = r.json();
  // A retry of the old token right away (lost response) is refused but doesn't sign the user out.
  r = await call("POST", "/auth/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(r.statusCode, 401);
  r = await call("POST", "/auth/refresh", { refreshToken: next.refreshToken });
  assert.equal(r.statusCode, 200);
  const third = r.json();
  // Reuse long after rotation is a theft signal: the whole family dies.
  await q(`UPDATE refresh_tokens SET replaced_at = now() - interval '5 minutes' WHERE replaced_at IS NOT NULL`);
  r = await call("POST", "/auth/refresh", { refreshToken: next.refreshToken });
  assert.equal(r.statusCode, 401);
  r = await call("POST", "/auth/refresh", { refreshToken: third.refreshToken });
  assert.equal(r.statusCode, 401);
  tokens = (await call("POST", "/auth/login", { email, password: "correct horse" })).json();
});

test("sync timestamps are validated and clamped", async () => {
  const t = tokens.accessToken;
  const media = { key: "anilist:22", kind: "anime", title: "Y", genres: [], overview: "" };
  let r = await call("PUT", "/progress/anilist:22", { media, position: 1, duration: 10, updatedAt: "soon" }, t);
  assert.equal(r.statusCode, 400);
  r = await call("PUT", "/progress/anilist:22", { media, position: 1, duration: 10, updatedAt: 1e20 }, t);
  assert.equal(r.statusCode, 200); // used to be a 500 "Invalid time value"; now clamped
  // A device clock in the year 3000 must not lock the row forever.
  await call("PUT", "/progress/anilist:22", { media, episode: 1, position: 1, duration: 10, updatedAt: 32503680000000 }, t);
  await new Promise((res) => setTimeout(res, 5));
  r = await call("PUT", "/progress/anilist:22", { media, episode: 2, position: 1, duration: 10, updatedAt: Date.now() + 6 * 60_000 }, t);
  const s = (await call("GET", "/sync", null, t)).json();
  assert.equal(s.progress.find((p) => p.media.key === "anilist:22").episode, 2);
  r = await call("PUT", "/watchlist/tmdb:movie:1", { media: { blob: "x".repeat(9000) } }, t);
  assert.equal(r.statusCode, 400);
});

test("sign out everywhere kills access tokens", async () => {
  const t = tokens.accessToken;
  assert.equal((await call("POST", "/auth/logout-all", null, t)).statusCode, 200);
  assert.equal((await call("GET", "/me", null, t)).statusCode, 401);
  assert.equal((await call("POST", "/auth/refresh", { refreshToken: tokens.refreshToken })).statusCode, 401);
  tokens = (await call("POST", "/auth/login", { email, password: "correct horse" })).json();
  assert.equal((await call("GET", "/me", null, tokens.accessToken)).statusCode, 200);
});

test("health checks the database", async () => {
  const r = await call("GET", "/health");
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);
});

test("tmdb proxy is off without a key", async () => {
  delete process.env.TMDB_KEY;
  const r = await call("GET", "/tmdb/movie/popular", null, tokens.accessToken);
  assert.equal(r.statusCode, 501);
});

test("subtitlePref sync validates, sanitizes, and enforces size limits", async () => {
  const t = tokens.accessToken;

  // Reject non-plain-object payloads
  for (const bad of ["string", ["array"], 123, null]) {
    const r = await call("PUT", "/settings", { subtitlePref: bad }, t);
    assert.equal(r.statusCode, 400);
  }

  // Reject oversized subtitlePref (> 2048 bytes)
  const oversized = await call("PUT", "/settings", { subtitlePref: { lang: "en", pad: "x".repeat(2500) } }, t);
  assert.equal(oversized.statusCode, 400);

  // Sanitize unknown/nested/unsafe fields while keeping valid primitives
  const valid = await call(
    "PUT",
    "/settings",
    {
      subtitlePref: {
        mode: "on",
        lang: "PT-BR",
        secondaryLang: "en",
        size: "l",
        font: "rounded",
        color: "#FFE88A",
        bg: "glass",
        bgOpacity: 0.8,
        edge: "outline",
        bottomPct: 12,
        lineHeight: 1.4,
        preferHearingImpaired: "avoid",
        autoFetchOnline: true,
        unknownKey: "should-be-dropped",
        nested: { deep: true },
      },
    },
    t,
  );
  assert.equal(valid.statusCode, 200);

  const synced = (await call("GET", "/sync", null, t)).json();
  assert.deepEqual(synced.settings.subtitlePref, {
    mode: "on",
    lang: "pt-br",
    secondaryLang: "en",
    size: "l",
    font: "rounded",
    color: "#ffe88a",
    bg: "glass",
    bgOpacity: 0.8,
    edge: "outline",
    bottomPct: 12,
    lineHeight: 1.4,
    preferHearingImpaired: "avoid",
    autoFetchOnline: true,
  });

  // Reject invalid color / size values via sanitization
  const unsafeColor = await call(
    "PUT",
    "/settings",
    { subtitlePref: { size: "m", color: "javascript:alert(1)", bgOpacity: 5 } },
    t,
  );
  assert.equal(unsafeColor.statusCode, 200);
  const afterUnsafe = (await call("GET", "/sync", null, t)).json();
  assert.deepEqual(afterUnsafe.settings.subtitlePref, { size: "m" });
});

test("failed logins for one account never lock anyone else out", async () => {
  const from = (ip, body) => app.inject({ method: "POST", url: "/auth/login", payload: body, remoteAddress: ip });
  const victim = `victim${Date.now()}@example.com`;
  let last;
  for (let i = 0; i < 9; i++) last = await from("10.9.0.1", { email: victim, password: "wrong pass" });
  assert.equal(last.statusCode, 429, "the guesser is limited");
  // A different person on a different address signs in normally.
  const r = await from("10.9.0.2", { email, password: "correct horse" });
  assert.equal(r.statusCode, 200);
  // And a request with no body at all is rejected as bad credentials, not counted against everyone.
  assert.equal((await from("10.9.0.3", undefined)).statusCode, 401);
});

test("progress rows must carry their title", async () => {
  const t = tokens.accessToken;
  let r = await call("PUT", "/progress/anilist:77", { position: 10, duration: 100, updatedAt: Date.now() }, t);
  assert.equal(r.statusCode, 400);
  r = await call("PUT", "/progress/anilist:77", { media: { key: "anilist:77", kind: "anime", title: "Y", genres: [], overview: "" }, position: -5, duration: 100 }, t);
  assert.equal(r.statusCode, 400);
});

test("settings sync drops malformed fields and keeps source toggles", async () => {
  const t = tokens.accessToken;
  const r = await call("PUT", "/settings", { preferredQuality: "huge", animeAudio: "dub", disabledSources: ["vidlink"], enabledExtras: null, junk: 1 }, t);
  assert.equal(r.statusCode, 200);
  const s = (await call("GET", "/sync", null, t)).json().settings;
  assert.equal(s.animeAudio, "dub");
  assert.deepEqual(s.disabledSources, ["vidlink"]);
  assert.equal(s.enabledExtras, null);
  assert.ok(!("junk" in s));
  assert.notEqual(s.preferredQuality, "huge");
});
