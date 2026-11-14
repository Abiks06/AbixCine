import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import { lastPick, resetHealth } from "./health";
import { candKey } from "./registry";
import { acquireSession, invalidateSessions, SourceSession, type SessionDeps } from "./session";
import type { SourceProvider, StreamCandidate } from "./types";

vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  native: true,
}));

const request = (key = "tmdb:movie:1"): PlaybackRequest => ({
  media: { key, kind: "movie", title: "Test", overview: "", genres: [] },
});

const direct = (pid: string, n = 1): StreamCandidate => ({
  providerId: pid,
  providerName: pid,
  label: pid,
  url: `https://${pid}.example/${n}.m3u8`,
  kind: "hls",
  via: "direct",
});

const embed = (pid: string): StreamCandidate => ({
  providerId: pid,
  providerName: pid,
  label: pid,
  url: `https://${pid}.example/embed`,
  pageUrl: `https://${pid}.example/embed`,
  kind: "embed",
  via: "embed",
});

const provider = (
  id: string,
  category: SourceProvider["category"],
  found: StreamCandidate[] | (() => Promise<StreamCandidate[]>),
  priority = category === "embed" ? 15 : 24,
): SourceProvider => ({
  id,
  name: id,
  category,
  priority,
  isEnabled: () => true,
  find: () => (typeof found === "function" ? found() : Promise.resolve(found)),
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
  });

type Plan = Record<string, { ms?: number; ok?: boolean; quality?: number; error?: string }>;

/** A fake checker: each provider answers after `ms` with ok / not ok. Records what was checked. */
function checker(plan: Plan) {
  const calls: string[] = [];
  const run = async (c: StreamCandidate, signal: AbortSignal): Promise<StreamCandidate> => {
    calls.push(c.providerId);
    const p = plan[c.providerId] ?? {};
    try {
      await sleep(p.ms ?? 10, signal);
    } catch {
      return { ...c, probe: { ok: false, latencyMs: 0, error: "AbortError" } };
    }
    if (p.ok === false) return { ...c, probe: { ok: false, latencyMs: p.ms ?? 10, error: p.error ?? "no stream" } };
    const captured = c.kind === "embed" ? { url: `https://cdn.example/${c.providerId}.m3u8`, kind: "hls" as const, via: "sniffed" as const } : {};
    return { ...c, ...captured, probe: { ok: true, latencyMs: p.ms ?? 10, quality: p.quality ?? 1080 } };
  };
  return { calls, run };
}

function make(providers: SourceProvider[], plan: Plan = {}, extra: Partial<SessionDeps> = {}) {
  const check = checker(plan);
  const confirm = vi.fn(async () => ({ ok: true }) as { ok: boolean; quality?: number; error?: string });
  const session = new SourceSession(request(), {
    providers,
    settings: getSettings(),
    probe: check.run,
    capture: check.run,
    confirm,
    ...extra,
  });
  return { session, calls: check.calls, confirm };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
  invalidateSessions();
  resetHealth();
  localStorage.clear();
});

describe("source session: picking", () => {
  it("plays a direct stream without capturing a single embed page", async () => {
    const { session, calls } = make(
      [provider("vidlink-direct", "external", [direct("vidlink-direct")]), provider("vidfast", "embed", [embed("vidfast")]), provider("vidnest", "embed", [embed("vidnest")])],
      { "vidlink-direct": { ms: 200 } },
    );
    session.start(1);
    await tick(600);
    const snap = session.getSnapshot();
    expect(snap.pick?.providerId).toBe("vidlink-direct");
    expect(snap.phase).toBe("picked");
    expect(calls).toEqual(["vidlink-direct"]);
    expect(snap.waiting).toBe(2);
    await tick(10_000);
    expect(calls).toEqual(["vidlink-direct"]);
  });

  it("starts capturing embeds once direct sources have answered with nothing", async () => {
    const { session, calls } = make(
      [provider("vidlink-direct", "external", []), provider("vidfast", "embed", [embed("vidfast")])],
      { vidfast: { ms: 400 } },
    );
    session.start(1);
    await tick(50);
    expect(calls).toEqual(["vidfast"]);
    await tick(500);
    expect(session.getSnapshot().pick?.providerId).toBe("vidfast");
    expect(session.getSnapshot().pick?.via).toBe("sniffed");
  });

  it("stops waiting for a slow direct source after the hold and races the embeds", async () => {
    const { session, calls } = make(
      [provider("slow", "external", () => sleep(6000).then(() => [direct("slow")])), provider("vidfast", "embed", [embed("vidfast")])],
      { vidfast: { ms: 300 } },
    );
    session.start(1);
    await tick(1000);
    expect(calls).toEqual([]);
    await tick(1000);
    expect(calls).toEqual(["vidfast"]);
    await tick(400);
    expect(session.getSnapshot().pick?.providerId).toBe("vidfast");
  });

  it("waits a moment for a better stream that is about to land, but not for a worse one", async () => {
    const better = make(
      [provider("jellyfin", "external", [direct("jellyfin")], 20), provider("vidrock", "external", [direct("vidrock")], 24.5)],
      { jellyfin: { ms: 100, quality: 480 }, vidrock: { ms: 250, quality: 1080 } },
    );
    better.session.start(1);
    await tick(120);
    expect(better.session.getSnapshot().pick).toBeUndefined();
    await tick(300);
    expect(better.session.getSnapshot().pick?.providerId).toBe("vidrock");
  });

  it("never commits to a stream whose first segment won't load", async () => {
    const confirm = vi.fn(async (c: StreamCandidate) => (c.providerId === "vidrock" ? { ok: false, error: "segment HTTP 403" } : { ok: true }));
    const { session } = make(
      [provider("vidrock", "external", [direct("vidrock")], 25), provider("vixsrc", "external", [direct("vixsrc")], 23)],
      { vidrock: { ms: 50 }, vixsrc: { ms: 60 } },
      { confirm },
    );
    session.start(1);
    await tick(800);
    const snap = session.getSnapshot();
    expect(snap.pick?.providerId).toBe("vixsrc");
    expect(session.find("vidrock")?.probe).toMatchObject({ ok: false, error: "segment HTTP 403" });
  });

  it("treats a slow first-segment check as inconclusive and plays anyway", async () => {
    const confirm = vi.fn((_c: StreamCandidate, signal: AbortSignal) => sleep(60_000, signal).then(() => ({ ok: true })));
    const { session } = make([provider("vidrock", "external", [direct("vidrock")])], { vidrock: { ms: 50 } }, { confirm });
    session.start(1);
    await tick(3000);
    expect(session.getSnapshot().pick).toBeUndefined();
    await tick(1000);
    expect(session.getSnapshot().pick?.providerId).toBe("vidrock");
  });

  it("reports empty with each provider's outcome when nothing is found", async () => {
    const { session } = make([
      provider("a", "external", []),
      provider("b", "external", () => Promise.reject(new Error("boom"))),
      provider("c", "embed", [embed("c")]),
    ], { c: { ok: false } });
    session.start(1);
    const picked = session.picked();
    await tick(3000);
    expect(await picked).toBeNull();
    const snap = session.getSnapshot();
    expect(snap.phase).toBe("empty");
    expect(Object.fromEntries(snap.lanes.map((l) => [l.providerId, l.status]))).toEqual({ a: "empty", b: "error", c: "found" });
    expect(snap.failed).toBe(1);
  });
});

describe("source session: backups and failover", () => {
  const embeds = ["e1", "e2", "e3", "e4", "e5"].map((id) => provider(id, "embed", [embed(id)]));

  it("fills backups after the stream has had time to start, then stops", async () => {
    const { session, calls } = make([provider("d", "external", [direct("d")]), ...embeds], { d: { ms: 100 } });
    session.start(3);
    await tick(500);
    expect(session.getSnapshot().pick?.providerId).toBe("d");
    expect(calls).toEqual(["d"]);
    await tick(3000);
    expect(calls).toEqual(["d"]);
    await tick(1500);
    expect(calls.length).toBe(3);
    await tick(5000);
    const snap = session.getSnapshot();
    expect(snap.ready).toBe(3);
    expect(snap.waiting).toBe(3);
    expect(snap.busy).toBe(false);
    expect(calls.length).toBe(3);
  });

  it("returns a capture that was cut short to waiting, not failed", async () => {
    const { session } = make([...embeds], { e1: { ms: 100 }, e2: { ms: 9000 }, e3: { ms: 9000 } });
    session.start(1);
    await tick(400);
    const snap = session.getSnapshot();
    expect(snap.pick?.providerId).toBe("e1");
    expect(snap.failed).toBe(0);
    expect(snap.waiting).toBe(4);
  });

  it("moves the pick on when the player reports the stream dead", async () => {
    const { session } = make(
      [provider("a", "external", [direct("a")], 25), provider("b", "external", [direct("b")], 22)],
      { a: { ms: 20 }, b: { ms: 30 } },
    );
    session.start(2);
    await tick(600);
    const first = session.getSnapshot().pick!;
    expect(first.providerId).toBe("a");
    session.report(candKey(first), false, { error: "stalled" });
    const next = await session.failover(candKey(first));
    expect(next?.providerId).toBe("b");
    await tick(50);
    expect(session.getSnapshot().pick?.providerId).toBe("b");
    expect(session.find("a")?.probe).toMatchObject({ ok: false, error: "stalled" });
  });

  it("checks waiting servers on failover when no backup is ready, and gives up cleanly", async () => {
    const { session, calls } = make([provider("d", "external", [direct("d")]), ...embeds.slice(0, 2)], { d: { ms: 20 }, e1: { ok: false }, e2: { ms: 300 } });
    session.start(1);
    await tick(500);
    const pick = session.getSnapshot().pick!;
    session.report(candKey(pick), false);
    const next = session.failover(candKey(pick));
    await tick(1000);
    expect((await next)?.providerId).toBe("e2");
    expect(calls).toContain("e1");

    session.report(candKey((await next)!), false);
    const none = session.failover(candKey((await next)!));
    await tick(1000);
    expect(await none).toBeNull();
  });

  it("checks one server on request and shares a check that is already running", async () => {
    const { session, calls } = make([provider("d", "external", [direct("d")]), ...embeds.slice(0, 2)], { d: { ms: 20 }, e2: { ms: 200 } });
    session.start(1);
    await tick(500);
    const key = candKey(session.find("e2")!);
    const a = session.verify(key);
    const b = session.verify(key);
    await tick(400);
    expect((await a)?.probe?.ok).toBe(true);
    expect(await b).toBe(await a);
    expect(calls.filter((c) => c === "e2").length).toBe(1);
    expect(session.getSnapshot().ready).toBe(2);
  });

  it("re-captures the page of a sniffed stream that failed, instead of re-fetching the dead link", async () => {
    const capture = vi.fn(async (c: StreamCandidate) => ({ ...c, url: "https://cdn.example/fresh.m3u8", probe: { ok: true, latencyMs: 5 } }));
    const { session } = make([embeds[0]], { e1: { ms: 20 } }, { capture });
    session.start(1);
    await tick(500);
    const key = candKey(session.getSnapshot().pick!);
    session.report(key, false, { error: "HTTP 403" });
    const again = session.verify(key);
    await tick(50);
    expect((await again)?.url).toBe("https://cdn.example/fresh.m3u8");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("turns servers with a page into web players as a last resort", async () => {
    const { session } = make(embeds.slice(0, 2), { e1: { ok: false }, e2: { ok: false } });
    session.start(1);
    await tick(1000);
    expect(session.getSnapshot().phase).toBe("empty");
    const first = session.useWebPlayers();
    expect(first?.kind).toBe("embed");
    const snap = session.getSnapshot();
    expect(snap.phase).toBe("picked");
    expect(snap.ready).toBe(2);
  });
});

describe("source session: memory", () => {
  it("remembers a server the viewer chose by hand and goes to it first next time", async () => {
    const providers = [provider("d", "external", [direct("d")], 25), provider("e1", "embed", [embed("e1")]), provider("e2", "embed", [embed("e2")])];
    const one = make(providers, { d: { ms: 20 } });
    one.session.start(1);
    await tick(500);
    const key = candKey(one.session.find("e2")!);
    one.session.choose(key);
    void one.session.verify(key);
    await tick(100);
    one.session.report(key, true, { latencyMs: 900 });
    expect(lastPick(request())).toMatchObject({ providerId: "e2", manual: true });

    // Next episode: the chosen server is captured at once (no hold) and wins over the direct stream.
    const two = make(providers, { d: { ms: 20 }, e2: { ms: 150 } });
    two.session.start(1);
    await tick(10);
    expect(two.calls).toContain("e2");
    expect(two.calls).not.toContain("e1");
    await tick(600);
    const pick = two.session.getSnapshot().pick!;
    expect(pick.providerId).toBe("e2");
    expect(pick.why).toContain("your choice for this show");
  });

  it("gives a hand-picked server real time to arrive, and lets the viewer skip the wait", async () => {
    const providers = [provider("d", "external", [direct("d")], 25), provider("e2", "embed", [embed("e2")])];
    const one = make(providers, { d: { ms: 20 } });
    one.session.start(1);
    await tick(500);
    const key = candKey(one.session.find("e2")!);
    one.session.choose(key);
    void one.session.verify(key);
    await tick(100);
    one.session.report(key, true);

    // A capture takes seconds: the direct stream is ready long before, but the choice is waited for.
    const two = make(providers, { d: { ms: 20 }, e2: { ms: 5000 } });
    two.session.start(1);
    await tick(1500);
    expect(two.session.getSnapshot().pick).toBeUndefined();
    expect(two.session.getSnapshot().awaitingChoice).toBe("e2");
    await tick(4000);
    expect(two.session.getSnapshot().pick?.providerId).toBe("e2");

    // "Play now" stops waiting, and the capture nobody needs any more is cut short.
    const three = make(providers, { d: { ms: 20 }, e2: { ms: 5000 } });
    three.session.start(1);
    await tick(1500);
    three.session.pickNow();
    await tick(50);
    const snap = three.session.getSnapshot();
    expect(snap.pick?.providerId).toBe("d");
    expect(snap.awaitingChoice).toBeUndefined();
    expect(snap.checking.size).toBe(0);
    expect(snap.waiting).toBe(1);
  });

  it("an automatic pick does not become a manual choice", async () => {
    const { session } = make([provider("d", "external", [direct("d")])], { d: { ms: 20 } });
    session.start(1);
    await tick(500);
    session.report(candKey(session.getSnapshot().pick!), true);
    expect(lastPick(request())?.manual).toBeUndefined();
  });

  it("shares one session per request until it is invalidated", () => {
    const a = acquireSession(request("tmdb:movie:77"));
    expect(acquireSession(request("tmdb:movie:77"))).toBe(a);
    expect(acquireSession(request("tmdb:movie:78"))).not.toBe(a);
    invalidateSessions();
    expect(acquireSession(request("tmdb:movie:77"))).not.toBe(a);
  });
});
