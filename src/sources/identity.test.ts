import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardRows } from "../components/SourceBoard";
import { getSettings } from "../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { getHealth, recordLookupFailure, reliability, resetHealth } from "./health";
import {
  checkStreamIdentity,
  dashManifestDuration,
  expectedRuntime,
  hlsPlaylistDuration,
  identityApplies,
  judgeRuntime,
  measureStreamDuration,
} from "./identity";
import { candKey, candLine, score } from "./registry";
import { invalidateSessions, SourceSession, type SessionDeps } from "./session";
import type { SourceProvider, StreamCandidate, StreamIdentity } from "./types";

vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  native: true,
}));

/**
 * The defensive check behind "some servers return the wrong movie": a server can answer for a new
 * film with a different file that plays perfectly. Its length gives it away.
 */

const odyssey = (over: Partial<MediaDetail> = {}): MediaDetail => ({
  key: "tmdb:movie:1368337",
  kind: "movie",
  title: "The Odyssey",
  overview: "",
  year: 2026,
  runtime: 150,
  genres: [],
  cast: [],
  crew: [],
  related: [],
  ...over,
});

const FILM = { seconds: 150 * 60, episode: false };
const EPISODE = { seconds: 45 * 60, episode: true };

function playlist(segments: number, seg = 6, end = true) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${seg}`];
  for (let i = 0; i < segments; i++) lines.push(`#EXTINF:${seg.toFixed(3)},`, `seg${i}.ts`);
  if (end) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

describe("reading a stream's length", () => {
  it("sums an HLS media playlist and refuses live or unfinished ones", () => {
    expect(hlsPlaylistDuration(playlist(1500))).toBe(9000);
    expect(hlsPlaylistDuration(playlist(10, 6, false))).toBeNull();
    expect(hlsPlaylistDuration("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:10,\na.ts\n#EXTINF:5.5,\nb.ts")).toBe(15.5);
    expect(hlsPlaylistDuration("<html>nope</html>")).toBeNull();
  });

  it("reads a DASH manifest's duration and refuses live manifests", () => {
    expect(dashManifestDuration('<MPD type="static" mediaPresentationDuration="PT2H30M5.5S">')).toBe(9005.5);
    expect(dashManifestDuration('<MPD mediaPresentationDuration="PT48M">')).toBe(2880);
    expect(dashManifestDuration('<MPD type="dynamic" mediaPresentationDuration="PT2H">')).toBeNull();
  });

  it("follows a master playlist to its first variant", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/master.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n720/index.m3u8\n", { status: 200 });
      if (url.endsWith("/720/index.m3u8")) return new Response(playlist(950), { status: 200 });
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const c: StreamCandidate = { providerId: "x", providerName: "x", label: "x", url: "https://cdn.example/v/master.m3u8", kind: "hls", via: "sniffed" };
      expect(await measureStreamDuration(c)).toBe(5700);
      expect(await checkStreamIdentity(c, FILM)).toMatchObject({ status: "mismatch", off: "short", durationSec: 5700, expectedSec: 9000 });
      expect(await measureStreamDuration({ ...c, kind: "file" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("judging a stream's length against the catalog runtime", () => {
  it("accepts the film give or take credits, logos and a prepended ad", () => {
    expect(judgeRuntime(148 * 60, FILM).status).toBe("match");
    expect(judgeRuntime(150 * 60 + 90, FILM).status).toBe("match"); // 90 s ad up front
    expect(judgeRuntime(165 * 60, FILM).status).toBe("match"); // 15 min of extras
    expect(judgeRuntime(175 * 60, FILM).status).toBe("match"); // an extended cut
  });

  it("flags a different film, the 88-minute part of a miniseries, and a trailer", () => {
    expect(judgeRuntime(95 * 60, FILM)).toMatchObject({ status: "mismatch", off: "short" });
    expect(judgeRuntime(88 * 60, FILM)).toMatchObject({ status: "mismatch", off: "short" });
    expect(judgeRuntime(150, FILM)).toMatchObject({ status: "mismatch", off: "short" });
    expect(judgeRuntime(260 * 60, FILM)).toMatchObject({ status: "mismatch", off: "long" });
  });

  it("is tighter in absolute terms for episodes", () => {
    expect(judgeRuntime(43 * 60, EPISODE).status).toBe("match");
    expect(judgeRuntime(22 * 60, EPISODE)).toMatchObject({ status: "mismatch", off: "short" });
    expect(judgeRuntime(120 * 60, EPISODE)).toMatchObject({ status: "mismatch", off: "long" });
  });

  it("never calls a stream a mismatch without a length or a runtime", () => {
    expect(judgeRuntime(0, FILM).status).toBe("unknown");
    expect(judgeRuntime(5000, { seconds: 0, episode: false }).status).toBe("unknown");
  });

  it("only applies when the runtime can be known, without any network", async () => {
    expect(identityApplies({ media: odyssey() })).toBe(true);
    expect(identityApplies({ media: odyssey({ runtime: undefined }) })).toBe(false);
    expect(identityApplies({ media: odyssey({ key: "anilist:1", kind: "anime", runtime: 24 }), episode: 3 })).toBe(true);
    expect(await expectedRuntime({ media: odyssey() })).toEqual(FILM);
    expect(await expectedRuntime({ media: odyssey({ key: "anilist:1", kind: "anime", runtime: 24 }), episode: 3 })).toEqual({ seconds: 1440, episode: true });
  });
});

describe("ranking and the server list", () => {
  const ready = (pid: string, identity?: StreamIdentity): StreamCandidate => ({
    providerId: pid,
    providerName: pid,
    label: pid,
    url: `https://${pid}.example/master.m3u8`,
    kind: "hls",
    via: "sniffed",
    probe: { ok: true, latencyMs: 400, quality: 1080 },
    ...(identity ? { identity } : {}),
  });

  it("ranks a probable different title below every stream that isn't, whatever its quality", () => {
    const req: PlaybackRequest = { media: odyssey() };
    const wrong = score(ready("fast-wrong", { status: "mismatch", durationSec: 5280, expectedSec: 9000, off: "short" }), 1080, 30, req);
    const right = score({ ...ready("slow-right"), probe: { ok: true, latencyMs: 9000, quality: 480 } }, 1080, 0, req);
    expect(wrong.score!).toBeLessThan(right.score!);
    expect(wrong.why).toContain("might be a different title");
  });

  it("warns on the row, says how far off it is, and shows what a search found", () => {
    const suspect = { ...ready("castle", { status: "mismatch", durationSec: 5280, expectedSec: 9000, off: "short" }), matched: { title: "The Odyssey", year: 1997 } };
    const fine = { ...ready("vidfast", { status: "match", durationSec: 9050, expectedSec: 9000 }), matched: { title: "The Odyssey", year: 2026 } };
    const snap = {
      req: { media: odyssey() },
      phase: "racing" as const,
      candidates: [fine, suspect],
      checking: new Set<string>(),
      verifying: new Set<string>(),
      lanes: [],
      ready: 1,
      suspect: 1,
      waiting: 0,
      failed: 0,
      busy: false,
    };
    const rows = boardRows(snap);
    const bad = rows.find((r) => r.c?.providerId === "castle")!;
    expect(bad.suspect).toBe(true);
    expect(bad.note).toContain("Might be a different title");
    expect(bad.note).toContain("runs 1 h 28 min, should be 2 h 30 min");
    expect(bad.note).toContain("“The Odyssey” (1997)");
    const good = rows.find((r) => r.c?.providerId === "vidfast")!;
    expect(good.suspect).toBeUndefined();
    expect(good.note.startsWith("“The Odyssey” (2026)")).toBe(true);
  });

  it("explains check failures in words", () => {
    const failed = (error: string) => candLine({ ...ready("x"), probe: { ok: false, latencyMs: 1, error } });
    expect(failed("segments aren't video")).toBe("not a real video stream");
    expect(failed("HTML or captcha response")).toBe("blocked by a browser check");
    expect(failed("variant HTTP 403")).toBe("stream parts refused (HTTP 403)");
    expect(failed("token expired")).toBe("link expired");
    expect(failed("HTTP 403")).toBe("HTTP 403");
  });
});

/* ------------------------------------------------------------------ session */

const direct = (pid: string, n = 1): StreamCandidate => ({
  providerId: pid,
  providerName: pid,
  label: pid,
  url: `https://${pid}.example/${n}.m3u8`,
  kind: "hls",
  via: "direct",
});

const provider = (id: string, found: StreamCandidate[], priority = 24): SourceProvider => ({
  id,
  name: id,
  category: "external",
  priority,
  isEnabled: () => true,
  find: () => Promise.resolve(found),
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
  });

/** Probe: each provider answers after `ms`. Identity: each provider's stream runs `runs` seconds. */
function make(
  providers: SourceProvider[],
  plan: Record<string, { ms?: number; runs?: number; identityMs?: number }>,
  extra: Partial<SessionDeps> = {},
  media = odyssey(),
) {
  const identityCalls: string[] = [];
  const session = new SourceSession(
    { media },
    {
      providers,
      settings: getSettings(),
      probe: async (c, signal) => {
        try {
          await sleep(plan[c.providerId]?.ms ?? 10, signal);
        } catch {
          return { ...c, probe: { ok: false, latencyMs: 0, error: "AbortError" } };
        }
        return { ...c, probe: { ok: true, latencyMs: plan[c.providerId]?.ms ?? 10, quality: 1080 } };
      },
      capture: async (c) => c,
      confirm: async () => ({ ok: true }),
      identity: async (c, signal) => {
        identityCalls.push(c.providerId);
        await sleep(plan[c.providerId]?.identityMs ?? 20, signal).catch(() => {});
        const runs = plan[c.providerId]?.runs;
        return runs == null ? null : judgeRuntime(runs, FILM);
      },
      ...extra,
    },
  );
  return { session, identityCalls };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("source session: a stream that is probably another title", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    invalidateSessions();
    resetHealth();
    localStorage.clear();
  });

  it("skips it when picking automatically, even though it answered first and ranks higher", async () => {
    const { session } = make(
      [provider("wrong-host", [direct("wrong-host")], 30), provider("right-host", [direct("right-host")], 20)],
      { "wrong-host": { ms: 50, runs: 88 * 60 }, "right-host": { ms: 600, runs: 151 * 60 } },
    );
    session.start(1);
    await tick(400);
    // The wrong one is ready, but it is not the pick, and doesn't count as ready.
    let snap = session.getSnapshot();
    expect(snap.pick).toBeUndefined();
    expect(snap.suspect).toBe(1);
    expect(snap.ready).toBe(0);
    await tick(1500);
    snap = session.getSnapshot();
    expect(snap.pick?.providerId).toBe("right-host");
    expect(snap.ready).toBe(1);
    const wrong = snap.candidates.find((c) => c.providerId === "wrong-host")!;
    expect(wrong.identity).toMatchObject({ status: "mismatch", off: "short" });
    expect(wrong.score!).toBeLessThan(snap.pick!.score!);
    // Listed after the real one.
    expect(snap.candidates[0].providerId).toBe("right-host");
  });

  it("with nothing else, finds no stream for the title, and plays it only when asked to", async () => {
    const { session } = make([provider("wrong-host", [direct("wrong-host")])], { "wrong-host": { ms: 50, runs: 150 } });
    session.start(1);
    await tick(2000);
    let snap = session.getSnapshot();
    expect(snap.pick).toBeUndefined();
    expect(snap.phase).toBe("empty");
    expect(snap.suspect).toBe(1);
    session.pickNow();
    await tick(10);
    snap = session.getSnapshot();
    expect(snap.pick?.providerId).toBe("wrong-host");
  });

  it("waits for the would-be pick's runtime check before committing", async () => {
    const { session } = make([provider("slow-check", [direct("slow-check")])], { "slow-check": { ms: 20, runs: 150 * 60, identityMs: 1200 } });
    session.start(1);
    await tick(500);
    expect(session.getSnapshot().pick).toBeUndefined();
    expect(session.getSnapshot().verifying.size).toBe(1);
    await tick(1000);
    expect(session.getSnapshot().pick?.providerId).toBe("slow-check");
    expect(session.getSnapshot().verifying.size).toBe(0);
  });

  it("gives up on a runtime check that hangs and picks anyway", async () => {
    const { session } = make([provider("hangs", [direct("hangs")])], { hangs: { ms: 20, runs: 150 * 60, identityMs: 60_000 } });
    session.start(1);
    await tick(3000);
    expect(session.getSnapshot().pick).toBeUndefined();
    await tick(2000);
    expect(session.getSnapshot().pick?.providerId).toBe("hangs");
  });

  it("never runs when the runtime is unknown (sessions behave exactly as before)", async () => {
    const calls: string[] = [];
    const session = new SourceSession(
      { media: odyssey({ runtime: undefined }) },
      {
        providers: [provider("a", [direct("a")])],
        settings: getSettings(),
        probe: async (c) => ({ ...c, probe: { ok: true, latencyMs: 5 } }),
        capture: async (c) => c,
        confirm: async () => ({ ok: true }),
      },
    );
    const fetchSpy = vi.fn(async () => {
      calls.push("fetch");
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      session.start(1);
      await tick(1000);
      expect(session.getSnapshot().pick?.providerId).toBe("a");
      expect(calls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("failover skips a probable different title and a twin of the stream that died", async () => {
    // Two embed servers that captured the very same CDN playlist.
    const shared = "https://cdn.example/same/master.m3u8";
    const twin = (pid: string): StreamCandidate => ({ ...direct(pid), url: shared, via: "sniffed", pageUrl: `https://${pid}.example/embed` });
    const { session } = make(
      [
        provider("twin-a", [twin("twin-a")], 40),
        provider("twin-b", [twin("twin-b")], 30),
        provider("suspect", [direct("suspect")], 35),
        provider("backup", [direct("backup")], 10),
      ],
      { "twin-a": { ms: 10, runs: 150 * 60 }, "twin-b": { ms: 10, runs: 150 * 60 }, suspect: { ms: 10, runs: 30 * 60 }, backup: { ms: 10, runs: 149 * 60 } },
    );
    session.start(4);
    await tick(2000);
    const snap = session.getSnapshot();
    expect(snap.pick?.providerId).toBe("twin-a");
    expect(snap.candidates.find((c) => c.providerId === "suspect")?.identity?.status).toBe("mismatch");
    // twin-a dies: twin-b plays the same dead stream, the suspect is probably another film.
    const dead = candKey(snap.pick!);
    session.report(dead, false, { error: "stalled" });
    const next = await session.failover(dead);
    expect(next?.providerId).toBe("backup");
  });

  it("the player's own duration can flag what is playing", async () => {
    const { session } = make([provider("a", [direct("a")])], { a: { ms: 10 } });
    session.start(1);
    await tick(500);
    const pick = session.getSnapshot().pick!;
    expect(pick.identity?.status).toBe("unknown");
    session.report(candKey(pick), true, { durationSec: 52 * 60 });
    await tick(10);
    expect(session.get(candKey(pick))?.identity).toMatchObject({ status: "mismatch", off: "short" });
  });

  it("a check that never settles times out instead of staying 'Checking…' forever", async () => {
    const session = new SourceSession(
      { media: odyssey({ runtime: undefined }) },
      {
        providers: [provider("stuck", [direct("stuck")])],
        settings: getSettings(),
        probe: () => new Promise<StreamCandidate>(() => {}),
        capture: async (c) => c,
        confirm: async () => ({ ok: true }),
      },
    );
    session.start(1);
    await tick(5000);
    expect(session.getSnapshot().busy).toBe(true);
    await tick(20_000);
    const snap = session.getSnapshot();
    expect(snap.busy).toBe(false);
    expect(snap.phase).toBe("empty");
    expect(snap.candidates[0].probe).toMatchObject({ ok: false, error: "timeout" });
  });
});

describe("health: a provider that stopped being tried recovers", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetHealth();
  });

  it("drifts back toward neutral over days without new results", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    for (let i = 0; i < 12; i++) recordLookupFailure("long-dead", 9000);
    const low = reliability("long-dead");
    expect(low).toBeLessThan(0.15);
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    const later = reliability("long-dead");
    expect(later).toBeGreaterThan(0.4);
    expect(later).toBeLessThan(0.5);
    // The stored counts themselves are untouched; only their weight fades.
    expect(getHealth("long-dead").fail).toBeGreaterThan(5);
  });
});
