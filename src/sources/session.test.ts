import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import { CIRCUIT_STREAK_THRESHOLD, getHealth, isCircuitOpen, lastPick, recordLookupFailure, recordPlayback, resetHealth } from "./health";
import { candKey, score } from "./registry";
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

describe("source session: lookup timing", () => {
  it("learns lookup time only from searches that found something", async () => {
    const quickNo = provider("quick-no", "external", []);
    const slowYes = provider("slow-yes", "external", async () => {
      await sleep(3000);
      return [direct("slow-yes")];
    });
    const { session } = make([quickNo, slowYes]);
    session.start(1);
    await tick(4000);
    expect(getHealth("quick-no").lookupMs).toBeUndefined();
    expect(getHealth("slow-yes").lookupMs).toBeGreaterThanOrEqual(3000);
  });

  it("records an unreachable server as a failed lookup, not as an empty one", async () => {
    const dead = provider("dead-srv", "external", async () => {
      throw new Error("error sending request: dns error");
    });
    const { session } = make([dead, provider("live", "external", [direct("live")])]);
    session.start(1);
    await tick(100);
    const lane = session.getSnapshot().lanes.find((l) => l.providerId === "dead-srv");
    expect(lane?.status).toBe("error");
    expect(getHealth("dead-srv").streak).toBeGreaterThan(0);
  });
});

describe("source session: audit fixes", () => {
  it("previews side-effect providers in warm mode and asks them again for real on play", async () => {
    const seen: (boolean | undefined)[] = [];
    const debridLike: SourceProvider = {
      ...provider("stremio", "external", []),
      sideEffectsOnLookup: () => true,
      find: async (_req, _s, _signal, ctx) => {
        seen.push(ctx?.warm);
        return ctx?.warm ? [] : [direct("stremio")];
      },
    };
    const plain: SourceProvider = { ...provider("vidrock", "external", [direct("vidrock")]) };
    const plainSpy = vi.spyOn(plain, "find");
    const { session } = make([debridLike, plain]);
    session.start(1);
    await tick(100);
    expect(seen).toEqual([true]);
    expect(plainSpy).toHaveBeenCalledTimes(1);
    expect(plainSpy.mock.calls[0][3]).toEqual({ warm: false });

    session.start(3); // Watch takes over the shared session
    await tick(100);
    expect(seen).toEqual([true, false]);
    expect(plainSpy).toHaveBeenCalledTimes(1); // only the warm provider is asked again
    expect([...session.getSnapshot().candidates].some((c) => c.providerId === "stremio")).toBe(true);
  });

  it("never captures a direct stream's API page on refresh: it reports it expired instead", async () => {
    const withPage = { ...direct("vixsrc"), pageUrl: "https://vixsrc.example/api/movie/1" };
    const capture = vi.fn();
    const { session } = make([provider("vixsrc", "external", [withPage])], {}, { capture });
    session.start(1);
    await tick(100);
    const r = await session.refresh(candKey(withPage));
    expect(capture).not.toHaveBeenCalled();
    expect(r?.probe?.ok).toBe(false);
    expect(r?.probe?.error).toBe("expired stream");
  });

  it("keeps a shared-dependency outage out of the provider's circuit breaker", async () => {
    const outage = Object.assign(new Error("enc-dec.app unavailable: HTTP 502"), { dependencyOutage: true });
    const { session } = make([
      provider("hexa-direct", "external", () => Promise.reject(outage)),
      provider("broken", "external", () => Promise.reject(new Error("boom"))),
    ]);
    session.start(1);
    await tick(100);
    expect(getHealth("hexa-direct").streak ?? 0).toBe(0);
    expect(getHealth("broken").streak).toBeGreaterThan(0);
  });

  it("gives every provider a turn before one provider's dead links use up the checks", async () => {
    const many = Array.from({ length: 12 }, (_, i) => direct("addon", i + 1));
    const { session, calls } = make(
      [provider("addon", "external", many, 30), provider("vidrock", "external", [direct("vidrock")], 10)],
      { addon: { ok: false, ms: 20 }, vidrock: { ms: 20 } },
    );
    session.start(1);
    await tick(400);
    // vidrock ranks lower but is checked within the first round, not after all 12 addon links.
    expect(calls.indexOf("vidrock")).toBeLessThanOrEqual(6);
    expect(session.getSnapshot().pick?.providerId).toBe("vidrock");
  });
});

describe("source session: local priority & server scheduler improvements", () => {
  const localCand = (name = "Movie.mkv", quality?: number): StreamCandidate => ({
    providerId: "local",
    providerName: "Local library",
    label: name,
    url: `asset://localhost/${encodeURIComponent(name)}`,
    kind: "file",
    via: "direct",
    localPath: `D:/Movies/${name}`,
    ...(quality ? { quality } : {}),
  });

  it("prioritizes local library files (even without a resolution tag) over 1080p online streams with history", () => {
    const req = request("tmdb:movie:500");
    // Give vidrock strong prior history (non-manual pick + playback).
    recordPlayback(req, direct("vidrock"), true);
    const localScored = score(
      { ...localCand("Film.mkv"), probe: { ok: true, latencyMs: 5 } },
      1080,
      60,
      req,
    );
    const onlineScored = score(
      { ...direct("vidrock"), quality: 1080, probe: { ok: true, latencyMs: 40, quality: 1080 } },
      1080,
      24.5,
      req,
    );
    expect(localScored.score!).toBeGreaterThan(onlineScored.score!);
    expect(localScored.why).toContain("on this PC");
  });

  it("waits briefly for a slower local lookup and promotes local over an unplayed online auto-pick", async () => {
    // Wait up to LOCAL_GRACE_MS (2.5s) before committing to an online stream.
    const a = make(
      [
        provider("local", "local", () => sleep(600).then(() => [localCand()]), 60),
        provider("vidrock", "external", [direct("vidrock")], 24.5),
      ],
      { local: { ms: 10 }, vidrock: { ms: 20, quality: 1080 } },
    );
    a.session.start(1);
    await tick(250);
    expect(a.session.getSnapshot().pick).toBeUndefined();
    await tick(600);
    expect(a.session.getSnapshot().pick?.providerId).toBe("local");

    // If local arrives after LOCAL_GRACE_MS while the viewer hasn't started playing yet, promote it.
    const b = make(
      [
        provider("local", "local", () => sleep(3000).then(() => [localCand()]), 60),
        provider("vidrock", "external", [direct("vidrock")], 24.5),
      ],
      { local: { ms: 10 }, vidrock: { ms: 20, quality: 1080 } },
    );
    b.session.start(1);
    await tick(2700);
    expect(b.session.getSnapshot().pick?.providerId).toBe("vidrock");
    await tick(500);
    expect(b.session.getSnapshot().pick?.providerId).toBe("local");
  });

  it("does not spin up background embed captures when a local file is picked", async () => {
    const { session, calls } = make(
      [
        provider("local", "local", [localCand()], 60),
        provider("vidfast", "embed", [embed("vidfast")]),
        provider("vidnest", "embed", [embed("vidnest")]),
      ],
      { local: { ms: 10 }, vidfast: { ms: 200 }, vidnest: { ms: 200 } },
    );
    session.start(1);
    await tick(100);
    expect(session.getSnapshot().pick?.providerId).toBe("local");
    session.start(3);
    await tick(10_000);
    expect(calls).toEqual(["local"]);
    expect(session.getSnapshot().waiting).toBe(2);
  });

  it("skips circuit-open external providers automatically while keeping local immune and retrying on checkAll", async () => {
    for (let i = 0; i < CIRCUIT_STREAK_THRESHOLD; i++) recordLookupFailure("dead-ext", 5000);
    for (let i = 0; i < 5; i++) recordLookupFailure("local", 500);
    expect(isCircuitOpen("dead-ext")).toBe(true);
    expect(isCircuitOpen("local")).toBe(false);

    const deadFind = vi.fn(async () => [direct("dead-ext")]);
    const deadProv: SourceProvider = {
      id: "dead-ext",
      name: "DeadExt",
      category: "external",
      priority: 22,
      isEnabled: () => true,
      find: deadFind,
    };
    const { session } = make([
      deadProv,
      provider("local", "local", [localCand()], 60),
    ], { local: { ms: 10 }, "dead-ext": { ms: 10 } });
    session.start(1);
    await tick(100);
    expect(deadFind).not.toHaveBeenCalled();
    expect(session.getSnapshot().lanes.find((l) => l.providerId === "dead-ext")).toMatchObject({
      status: "error",
      error: "circuit open",
    });
    expect(session.getSnapshot().pick?.providerId).toBe("local");

    session.checkAll();
    await tick(100);
    expect(deadFind).toHaveBeenCalledTimes(1);
  });

  it("skips obviously inapplicable direct providers up front", async () => {
    const hianimeFind = vi.fn(async () => [direct("hianime")]);
    const vixsrcFind = vi.fn(async () => [direct("vixsrc")]);
    const hianime: SourceProvider = {
      id: "hianime",
      name: "HiAnime",
      category: "external",
      priority: 26,
      isEnabled: () => true,
      find: hianimeFind,
    };
    const vixsrc: SourceProvider = {
      id: "vixsrc",
      name: "VixSrc",
      category: "external",
      priority: 23.5,
      isEnabled: () => true,
      find: vixsrcFind,
    };

    const movieCheck = checker({});
    const sMovie = new SourceSession(request("tmdb:movie:1"), {
      providers: [hianime, vixsrc],
      settings: getSettings(),
      probe: movieCheck.run,
      capture: movieCheck.run,
      confirm: async () => ({ ok: true }),
    });
    sMovie.start(1);
    await tick(50);
    expect(hianimeFind).not.toHaveBeenCalled();
    expect(vixsrcFind).toHaveBeenCalledTimes(1);

    hianimeFind.mockClear();
    vixsrcFind.mockClear();
    const dubCheck = checker({});
    const sAnimeDub = new SourceSession(
      { media: { key: "anilist:1", kind: "anime", title: "Anime", overview: "", genres: [] }, episode: 1, audio: "dub" },
      {
        providers: [hianime, vixsrc],
        settings: getSettings(),
        probe: dubCheck.run,
        capture: dubCheck.run,
        confirm: async () => ({ ok: true }),
      },
    );
    sAnimeDub.start(1);
    await tick(50);
    expect(vixsrcFind).not.toHaveBeenCalled();
    expect(hianimeFind).toHaveBeenCalledTimes(1);
  });

  it("deduplicates shared CDN URLs in readyCount and avoids token-expired backups in failover", async () => {
    const pastSec = Math.floor((Date.now() - 60_000) / 1000);
    const expiredCand: StreamCandidate = {
      providerId: "stale-direct",
      providerName: "stale-direct",
      label: "stale-direct",
      url: `https://cdn.example/video.m3u8?expires=${pastSec}`,
      kind: "hls",
      via: "direct",
    };
    const { session } = make(
      [
        provider("vidrock", "external", [direct("vidrock")], 25),
        provider("stale-direct", "external", [expiredCand], 24),
        provider("e1", "embed", [embed("e1")]),
      ],
      {
        vidrock: { ms: 10 },
        "stale-direct": { ms: 20 },
        e1: { ms: 30, ok: false },
      },
    );
    session.start(3);
    await tick(500);
    const pick = session.getSnapshot().pick!;
    expect(pick.providerId).toBe("vidrock");

    // Force failover when stale-direct has an expired token and e1 fails: failover skips expired and returns null.
    session.report(candKey(pick), false, { error: "403" });
    const failedOver = session.failover(candKey(pick));
    await tick(500);
    expect(await failedOver).toBeNull();

    // Two captures resolving to the exact same CDN URL count as 1 unique stream in readyCount(),
    // so start(2) continues searching and discovers a distinct 3rd backup instead of stopping early.
    const dupSession = new SourceSession(request("tmdb:movie:99"), {
      providers: [
        provider("e1", "embed", [embed("e1")]),
        provider("e2", "embed", [embed("e2")]),
        provider("e3", "embed", [embed("e3")]),
      ],
      settings: getSettings(),
      probe: async (c) => ({
        ...c,
        url: c.providerId === "e3" ? "https://cdn.example/distinct.m3u8" : "https://cdn.example/identical.m3u8",
        kind: "hls",
        via: "sniffed",
        probe: { ok: true, latencyMs: 10 },
      }),
      capture: async (c) => ({
        ...c,
        url: c.providerId === "e3" ? "https://cdn.example/distinct.m3u8" : "https://cdn.example/identical.m3u8",
        kind: "hls",
        via: "sniffed",
        probe: { ok: true, latencyMs: 10 },
      }),
      confirm: async () => ({ ok: true }),
    });
    dupSession.start(2);
    await tick(6000);
    const firstPick = dupSession.getSnapshot().pick!;
    const failoverProm = dupSession.failover(candKey(firstPick));
    await tick(500);
    expect((await failoverProm)?.providerId).toBe("e3");
  });
});

