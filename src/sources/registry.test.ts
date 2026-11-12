import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackRequest } from "../lib/types";
import { getEntry, saveProgress } from "../lib/progress";
import { getSettings } from "../lib/settings";
import {
  CIRCUIT_STREAK_THRESHOLD,
  isCircuitOpen,
  lastPick,
  recordLookupFailure,
  recordPlayback,
  recordProbe,
  resetHealth,
  serverHealthScore,
} from "./health";
import {
  availableSources,
  candLine,
  clearResolveCache,
  initialCandidateIndex,
  probeHedged,
  PROVIDERS,
  quickCheck,
  resolveSources,
  score,
  validateManifest,
} from "./registry";
import { isUrlTokenExpired, normalizeHeaders, proxyUrl, unwrapProxyUrl, type Sniffed } from "./native";
import type { SourceProvider, StreamCandidate } from "./types";

const { mockSniff } = vi.hoisted(() => ({ mockSniff: vi.fn() }));
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  native: true,
  sniff: mockSniff,
}));

const request = (key: string): PlaybackRequest => ({
  media: { key, kind: "movie", title: "Test", overview: "", genres: [] },
});

const candidate = (providerId: string): StreamCandidate => ({
  providerId,
  providerName: providerId,
  label: providerId,
  url: `https://${providerId}.example/stream`,
  pageUrl: `https://${providerId}.example/stream`,
  kind: "embed",
  via: "embed",
});

beforeEach(() => {
  mockSniff.mockReset();
  mockSniff.mockResolvedValue({
    url: "https://media.example/master.m3u8",
    kind: "hls",
    headers: {},
    subtitles: [],
    verified: true,
    quality: 1080,
  });
});

afterEach(() => {
  clearResolveCache();
  resetHealth();
});

describe("source ranking", () => {
  it("starts from the explicitly chosen source even when its preflight failed", () => {
    const candidates = [
      { ...candidate("checked"), probe: { ok: true, latencyMs: 10 } },
      { ...candidate("chosen"), probe: { ok: false, latencyMs: 20, error: "timeout" } },
    ];

    expect(initialCandidateIndex(candidates, candidates[1].url)).toBe(1);
    expect(initialCandidateIndex(candidates)).toBe(0);
  });

  it("shows a preflight failure reason instead of a generic won't-play label", () => {
    expect(candLine({ ...candidate("denied"), probe: { ok: false, latencyMs: 1, error: "HTTP 403" } })).toBe("HTTP 403");
    expect(candLine({ ...candidate("timeout"), probe: { ok: false, latencyMs: 1, error: "timeout" } })).toBe("timed out");
  });

  it("uses lookup time as well as probe time when ranking time-to-play", () => {
    const req = request("test:lookup-ranking");
    const fast = score({ ...candidate("fast"), lookupMs: 100, probe: { ok: true, latencyMs: 500 } }, 1080, 0, req);
    const slow = score({ ...candidate("slow"), lookupMs: 3000, probe: { ok: true, latencyMs: 500 } }, 1080, 0, req);

    expect(fast.score).toBeGreaterThan(slow.score!);
  });

  it("ranks a known French source lower for a non-French original", () => {
    const req = request("test:french-source");
    Object.assign(req.media, { originalLanguage: "en" });
    const probe = { ok: true, latencyMs: 200, quality: 1080 };
    const french = score({ ...candidate("french"), label: "Frembed · French", probe }, 1080, 15, req);
    const neutral = score({ ...candidate("neutral"), label: "VidFast", probe }, 1080, 15, req);

    expect(french.score).toBeLessThan(neutral.score!);
    expect(french.why).toContain("French source for non-French title");
  });

  it("checks more standby embeds when the requested verification budget increases", async () => {
    const original = [...PROVIDERS];
    const providers: SourceProvider[] = ["first", "second", "third", "fourth", "fifth"].map((id, i) => ({
      id,
      name: id,
      category: "embed",
      priority: 20 - i,
      isEnabled: () => true,
      find: async () => [candidate(id)],
    }));
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);

    try {
      const req = request("test:verification-budget");
      const initial = await resolveSources(req, undefined, { verifyBudget: 1, record: false });
      const initiallyVerified = initial.filter((c) => c.probe?.ok).length;
      expect(initiallyVerified).toBeGreaterThan(0);
      expect(initiallyVerified).toBeLessThan(providers.length);
      expect(initial.some((c) => !c.probe)).toBe(true);

      const expanded = await resolveSources(req, undefined, { verifyBudget: 4, record: false });
      expect(expanded.filter((c) => c.probe?.ok).length).toBeGreaterThan(initiallyVerified);
    } finally {
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("starts from the first verified source without waiting for slower lookups", async () => {
    const original = [...PROVIDERS];
    let releaseDirect!: (response: Response) => void;
    let releaseSlow!: (candidates: StreamCandidate[]) => void;
    const directProbe = new Promise<Response>((resolve) => {
      releaseDirect = resolve;
    });
    const slowLookup = new Promise<StreamCandidate[]>((resolve) => {
      releaseSlow = resolve;
    });
    const providers: SourceProvider[] = [
      {
        id: "fast",
        name: "Fast",
        category: "embed",
        priority: 20,
        isEnabled: () => true,
        find: async () => [
          { ...candidate("fast"), url: "https://fast.example/master.m3u8", kind: "hls", via: "direct", pageUrl: undefined },
          candidate("fast"),
        ],
      },
      {
        id: "slow",
        name: "Slow",
        category: "embed",
        priority: 10,
        isEnabled: () => true,
        find: () => slowLookup,
      },
    ];
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);
    vi.stubGlobal("fetch", () => directProbe);
    vi.useFakeTimers();

    try {
      const pending = resolveSources(request("test:fast-first-source"), undefined, { early: true, record: false });
      await vi.advanceTimersByTimeAsync(300);
      const selected = await pending;

      expect(selected.some((c) => c.providerId === "fast" && c.probe?.ok)).toBe(true);

      releaseSlow([candidate("slow")]);
      releaseDirect(new Response("#EXTM3U\n#EXTINF:6,\nsegment.ts", { status: 200 }));
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("keeps checking later embeds when earlier captures don't find a stream", async () => {
    const original = [...PROVIDERS];
    const ids = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"];
    const providers: SourceProvider[] = ids.map((id, i) => ({
      id,
      name: id,
      category: "embed",
      priority: 20 - i,
      isEnabled: () => true,
      find: async () => [candidate(id)],
    }));
    const last = candidate("seventh");
    mockSniff.mockImplementation(async (url: string) => url === last.url ? {
      url: "https://media.example/master.m3u8",
      kind: "hls",
      headers: {},
      subtitles: [],
      verified: true,
      quality: 1080,
    } : null);
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);

    try {
      const result = await resolveSources(request("test:later-embed"), undefined, { verifyBudget: 2, record: false });

      expect(result.find((c) => c.providerId === "seventh")?.probe?.ok).toBe(true);
      // Failed embeds are explicitly marked probe.ok === false instead of left as standby
      expect(result.find((c) => c.providerId === "first")?.probe?.ok).toBe(false);
    } finally {
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("tries the last working source first among queued embeds", async () => {
    const original = [...PROVIDERS];
    const req = request("test:last-picked-source");
    const active = new Set(["first", "second", "third"]);
    const pending: Record<string, (result: Sniffed | null) => void> = {};
    const stream: Sniffed = {
      url: "https://media.example/master.m3u8",
      kind: "hls",
      headers: {},
      subtitles: [],
      verified: true,
      quality: 1080,
    };
    const providers: SourceProvider[] = ["first", "second", "third", "fourth", "fifth"].map((id, i) => ({
      id,
      name: id,
      category: "embed",
      priority: 20 - i,
      isEnabled: () => true,
      find: async () => [candidate(id)],
    }));
    mockSniff.mockImplementation((url: string) => {
      const id = new URL(url).hostname.split(".")[0];
      if (active.has(id)) return new Promise<Sniffed | null>((resolve) => { pending[id] = resolve; });
      return Promise.resolve(id === "fifth" ? stream : null);
    });
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);
    resetHealth();
    recordPlayback(req, candidate("fifth"), true);

    try {
      const race = resolveSources(req, undefined, { verifyBudget: 1, record: false });
      await vi.waitFor(() => expect(mockSniff).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 0));
      pending.first(null);
      await vi.waitFor(() => expect(mockSniff).toHaveBeenCalledTimes(4));

      expect(new URL(mockSniff.mock.calls[3][0]).hostname).toBe("fifth.example");

      pending.second(null);
      pending.third(null);
      const result = await race;
      expect(result.find((c) => c.providerId === "fifth")?.probe?.ok).toBe(true);
    } finally {
      resetHealth();
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });
});

describe("true stream readiness validation", () => {
  it("rejects HTTP 200 HTML error / Cloudflare captcha pages and empty playlists", () => {
    expect(validateManifest("<!DOCTYPE html><html><body>Attention Required! | Cloudflare</body></html>", "https://cdn.example/master.m3u8").ok).toBe(false);
    expect(validateManifest("#EXTM3U\n#EXT-X-VERSION:3\n", "https://cdn.example/master.m3u8").ok).toBe(false);
    expect(validateManifest("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\n", "https://cdn.example/master.m3u8").ok).toBe(false);
    expect(validateManifest("#EXTM3U\n#EXTINF:6.0,\nerror.ts", "https://cdn.example/master.m3u8").ok).toBe(false);
  });

  it("validates genuine HLS master/media playlists and DASH .mpd manifests", () => {
    const hlsMaster = validateManifest(
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n1080p/index.m3u8\n",
      "https://cdn.example/master.m3u8",
    );
    expect(hlsMaster.ok).toBe(true);
    expect(hlsMaster.quality).toBe(1080);
    expect(hlsMaster.hasVariants).toBe(true);

    const dashMpd = validateManifest(
      `<?xml version="1.0"?><MPD><Period><AdaptationSet><Representation height="720"><SegmentTemplate media="seg-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`,
      "https://cdn.example/manifest.mpd",
      "application/dash+xml",
    );
    expect(dashMpd.ok).toBe(true);
    expect(dashMpd.kind).toBe("dash");
    expect(dashMpd.quality).toBe(720);
  });

  it("detects expired token timestamps on raw and proxied stream URLs", async () => {
    const now = Date.now();
    const pastSec = Math.floor((now - 60_000) / 1000);
    const futureSec = Math.floor((now + 3600_000) / 1000);

    const expiredRaw = `https://cdn.example/hls/master.m3u8?token=abc&expires=${pastSec}`;
    const validRaw = `https://cdn.example/hls/master.m3u8?token=abc&expires=${futureSec}`;
    const expiredProxied = proxyUrl(expiredRaw, { referer: "https://vidfast.vc/" });

    expect(isUrlTokenExpired(expiredRaw, now)).toBe(true);
    expect(isUrlTokenExpired(expiredProxied, now)).toBe(true);
    expect(isUrlTokenExpired(validRaw, now)).toBe(false);

    const check = await quickCheck({
      ...candidate("vidfast"),
      url: expiredProxied,
      kind: "hls",
      via: "sniffed",
    });
    expect(check.ok).toBe(false);
    expect(check.error).toBe("token expired");
  });
});

describe("header, proxy & watch-history hygiene", () => {
  it("configures all 14 embed servers with normalized Referer, Origin, and User-Agent headers", () => {
    expect(availableSources).toHaveLength(14);
    const s = getSettings();
    for (const src of availableSources) {
      expect(src.headers?.referer).toMatch(/^https:\/\/[^/]+\/$/);
      expect(src.headers?.origin).toMatch(/^https:\/\/[^/]+$/);
      expect(src.headers?.ua).toContain("Mozilla/5.0");
      const provider = PROVIDERS.find((p) => p.id === src.id);
      expect(provider?.isEnabled(s)).toBe(true);
    }
  });

  it("prevents double-proxying and derives Origin from Referer automatically", () => {
    const h = normalizeHeaders({ referer: "https://vidlink.pro/movie/603" });
    expect(h.origin).toBe("https://vidlink.pro");
    expect(h.ua).toContain("Mozilla/5.0");

    const once = proxyUrl("https://cdn.example/master.m3u8", { referer: "https://vidlink.pro/" });
    const twice = proxyUrl(once, { origin: "https://vidlink.pro" });
    const unwrapped = unwrapProxyUrl(twice);
    expect(unwrapped.proxied).toBe(true);
    expect(unwrapped.url).toBe("https://cdn.example/master.m3u8");
    expect(unwrapped.headers.referer).toBe("https://vidlink.pro/");
    expect(unwrapped.headers.origin).toBe("https://vidlink.pro");
  });

  it("clears stale provider picks when a previously watched show's provider fails on a new URL", () => {
    const req1: PlaybackRequest = {
      media: { key: "tmdb:tv:1399", kind: "tv", title: "Show", overview: "", genres: [] },
      season: 1,
      episode: 1,
    };
    const req2: PlaybackRequest = { ...req1, episode: 2 };
    recordPlayback(req1, { ...candidate("vidfast"), url: "https://cdn.example/ep1-token1.m3u8" }, true);
    expect(lastPick(req2)?.providerId).toBe("vidfast");

    // When vidfast fails on episode 2 with a different URL, the stale show-level pick is cleared
    recordPlayback(req2, { ...candidate("vidfast"), url: "https://cdn.example/ep2-token2.m3u8" }, false);
    expect(lastPick(req2)).toBeUndefined();
  });

  it("preserves malId and originalLanguage in watch-history progress entries", () => {
    saveProgress({
      media: {
        key: "anilist:21",
        kind: "anime",
        title: "One Piece",
        overview: "Long overview",
        genres: ["Action"],
        malId: 21,
        ...({ originalLanguage: "ja" } as any),
      },
      episode: 5,
      position: 120,
      duration: 1400,
    });
    const entry = getEntry("anilist:21");
    expect(entry?.media.malId).toBe(21);
    expect((entry?.media as any)?.originalLanguage).toBe("ja");
  });
});

describe("hedged probing & circuit breaker", () => {
  it("trips the circuit breaker after consecutive failures and recovers on success without breaking manual selection", () => {
    for (let i = 0; i < CIRCUIT_STREAK_THRESHOLD; i++) {
      recordLookupFailure("dead-srv", 8000);
    }
    expect(isCircuitOpen("dead-srv")).toBe(true);
    expect(serverHealthScore("dead-srv", 15)).toBeLessThan(serverHealthScore("healthy-srv", 15) - 30);

    // Manual selection in the UI still works even when circuit is open
    const cands = [
      { ...candidate("healthy-srv"), probe: { ok: true, latencyMs: 100 } },
      { ...candidate("dead-srv"), probe: { ok: false, latencyMs: 8000, error: "timeout" } },
    ];
    expect(initialCandidateIndex(cands, "dead-srv")).toBe(1);

    // A single successful probe closes the circuit breaker immediately
    recordProbe({ ...candidate("dead-srv"), probe: { ok: true, latencyMs: 250 } });
    expect(isCircuitOpen("dead-srv")).toBe(false);
  });

  it("cancels losing concurrent probes immediately via AbortController once a winner resolves", async () => {
    const aborted: string[] = [];
    mockSniff.mockImplementation((url: string, _timeout?: number, signal?: AbortSignal) => {
      const id = new URL(url).hostname.split(".")[0];
      if (id === "winner") {
        return Promise.resolve({
          url: "https://media.example/master.m3u8",
          kind: "hls",
          headers: {},
          subtitles: [],
          verified: true,
          quality: 1080,
        });
      }
      return new Promise<Sniffed | null>((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted.push(id);
          resolve(null);
        }, { once: true });
      });
    });

    const batch = [candidate("slow1"), candidate("winner"), candidate("slow2")];
    const out = await probeHedged(batch, { concurrency: 3, maxWinners: 1 });
    expect(out.find((c) => c.providerId === "winner")?.probe?.ok).toBe(true);
    expect(aborted).toEqual(expect.arrayContaining(["slow1", "slow2"]));
  });
});
