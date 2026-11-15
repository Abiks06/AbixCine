import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The account module reads its sign-in from localStorage when it loads: give it one, then load it fresh. */
async function loadSignedIn() {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem(
    "abx.auth.v1",
    JSON.stringify({ user: { id: "u", email: "e@x.y", name: "U", avatarHue: 1, createdAt: "" }, accessToken: "tok", refreshToken: "r" }),
  );
  return import("./account");
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answer: (c: Call) => Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const c = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      return answer(c);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const outbox = () => JSON.parse(localStorage.getItem("abx.outbox.v1") || "{}") as Record<string, unknown>;

describe("sync outbox", () => {
  it("sends a lone write on its own", async () => {
    answer = () => json({ ok: true });
    const a = await loadSignedIn();
    a.push("/progress/anilist:1", "PUT", { x: 1 });
    await a.flushOutbox();
    await tick();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["PUT /progress/anilist:1"]);
    expect(outbox()).toEqual({});
  });

  it("groups writes made together into one batch, oldest first", async () => {
    answer = (c) => json({ results: (c.body as { ops: unknown[] }).ops.map(() => ({ status: 200 })) });
    const a = await loadSignedIn();
    a.push("/progress/anilist:1", "PUT", { x: 1 });
    a.push("/watchlist/anilist:2", "DELETE");
    a.push("/settings", "PUT", { autoplayNext: true });
    await tick();
    await a.flushOutbox();
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/sync/batch");
    expect((calls[0].body as { ops: { path: string }[] }).ops.map((o) => o.path)).toEqual(["/progress/anilist:1", "/watchlist/anilist:2", "/settings"]);
    expect(outbox()).toEqual({});
  });

  it("keeps a failed write and everything after it", async () => {
    // The server answers up to the write it failed on, then stops.
    answer = (c) => {
      const ops = (c.body as { ops: { path: string }[] }).ops;
      const stop = ops.findIndex((o) => o.path === "/progress/anilist:2");
      return json({ results: ops.slice(0, stop + 1).map((o) => ({ status: o.path === "/progress/anilist:2" ? 500 : 200 })) });
    };
    const a = await loadSignedIn();
    a.push("/progress/anilist:1", "PUT", { x: 1 });
    a.push("/progress/anilist:2", "PUT", { x: 2 });
    a.push("/progress/anilist:3", "PUT", { x: 3 });
    await tick();
    await a.flushOutbox();
    expect(Object.keys(outbox())).toEqual(["/progress/anilist:2", "/progress/anilist:3"]);
  });

  it("falls back to one by one on a server without batches", async () => {
    answer = (c) => (new URL(c.url).pathname === "/sync/batch" ? json({ error: "not_found" }, 404) : json({ ok: true }));
    const a = await loadSignedIn();
    a.push("/progress/anilist:1", "PUT", { x: 1 });
    a.push("/progress/anilist:2", "PUT", { x: 2 });
    await tick();
    await a.flushOutbox();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/sync/batch", "/progress/anilist:1", "/progress/anilist:2"]);
    expect(outbox()).toEqual({});
  });
});
