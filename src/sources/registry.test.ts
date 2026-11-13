import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackRequest } from "../lib/types";
import { getEntry, saveProgress } from "../lib/progress";
import { applyRemoteSettings, getSettings, updateSettings } from "../lib/settings";
import { animeDirectProvider } from "./anime-direct";
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
import { jellyfinProvider } from "./jellyfin";
import { kisskhProvider } from "./kisskh";
import { localProvider, sidecarTrack } from "./local";
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
  verifyEmbed,
} from "./registry";
import { isUrlTokenExpired, normalizeHeaders, proxyUrl, unwrapProxyUrl, type Sniffed } from "./native";
import { inferSubtitleMeta, isThumbnailSubtitleUrl, type SourceProvider, type StreamCandidate } from "./types";

const { mockSniff, mockHttpFetch, mockInvoke, mockIsTauri } = vi.hoisted(() => ({
  mockSniff: vi.fn(),
  mockHttpFetch: vi.fn(),
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(() => false),
}));
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  native: true,
  sniff: mockSniff,
  httpFetch: mockHttpFetch,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  isTauri: mockIsTauri,
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
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
  mockHttpFetch.mockReset();
  mockInvoke.mockReset();
  mockIsTauri.mockReturnValue(false);
  vi.unstubAllGlobals();
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

describe("subtitle metadata inference & source providers", () => {
  it("filters thumbnail, sprite, storyboard, preview VTT and BIF URLs", () => {
    expect(isThumbnailSubtitleUrl("https://cdn.example/sub.vtt", "thumbnails")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example/thumbnails.vtt?token=1")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example/thumbs/sprite.vtt")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example/storyboard.vtt")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example/preview.vtt")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example/bif/12345")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example/video.bif?sig=1")).toBe(true);
    expect(isThumbnailSubtitleUrl(proxyUrl("https://cdn.example/thumbnails.vtt"))).toBe(true);

    expect(isThumbnailSubtitleUrl("https://cdn.example/subs/en.vtt")).toBe(false);
    expect(isThumbnailSubtitleUrl("https://cdn.example/subs/ja.ass?token=abc")).toBe(false);
    expect(isThumbnailSubtitleUrl("https://cdn.example/subs/es.srt", "captions")).toBe(false);
  });

  it("infers format, language codes, locales, and tags across URLs and filenames", () => {
    expect(inferSubtitleMeta("https://cdn.example/subs/en.vtt?expires=123")).toMatchObject({
      lang: "en",
      label: "English",
      format: "vtt",
      isDefault: false,
      isForced: false,
      isHearingImpaired: false,
    });
    expect(inferSubtitleMeta("https://cdn.example/subs/pt-br/movie.forced.ass?tok=1")).toMatchObject({
      lang: "pt-br",
      format: "ass",
      isForced: true,
    });
    expect(inferSubtitleMeta("https://cdn.example/ja/ep_01_signs.ssa")).toMatchObject({
      lang: "ja",
      format: "ssa",
      isForced: true,
    });
    expect(inferSubtitleMeta("https://cdn.example/drama/ep1_english.srt")).toMatchObject({
      lang: "en",
      label: "English",
      format: "srt",
    });
    expect(inferSubtitleMeta("https://cdn.example/id/98765/fr.vtt")).toMatchObject({
      lang: "fr",
      label: "French",
      format: "vtt",
    });
    expect(inferSubtitleMeta("https://cdn.example/subs/id.vtt")).toMatchObject({
      lang: "id",
      label: "Indonesian",
      format: "vtt",
    });
    expect(inferSubtitleMeta("Movie.2024.spa.sdh.default.srt")).toMatchObject({
      lang: "es",
      format: "srt",
      isDefault: true,
      isHearingImpaired: true,
    });
    expect(inferSubtitleMeta("Movie.eng.hi.cc.vtt")).toMatchObject({
      lang: "en",
      format: "vtt",
      isHearingImpaired: true,
    });
    expect(inferSubtitleMeta("https://cdn.example/subs/de.vtt").lang).toBe("de");
    expect(inferSubtitleMeta("https://cdn.example/subs/ger.vtt").lang).toBe("de");
    expect(inferSubtitleMeta("https://cdn.example/subs/ar.vtt").lang).toBe("ar");
    expect(inferSubtitleMeta("https://cdn.example/subs/ko.vtt").lang).toBe("ko");
    expect(inferSubtitleMeta("https://cdn.example/subs/zh.vtt").lang).toBe("zh");
    expect(inferSubtitleMeta("https://cdn.example/subs/12345.vtt")).toMatchObject({
      lang: "und",
      label: "Subtitles",
      format: "vtt",
    });
  });

  it("extracts sidecar metadata and probes embedded text subtitles in localProvider", async () => {
    expect(sidecarTrack("D:/Movies/The.English.Patient.1996.fr.forced.ass", "The.English.Patient.1996")).toMatchObject({
      lang: "fr",
      format: "ass",
      isForced: true,
      source: "sidecar",
    });

    mockIsTauri.mockReturnValue(true);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "scan_library") {
        return {
          files: [
            {
              path: "D:/Anime/Frieren/Frieren - 01.mkv",
              name: "Frieren - 01",
              size: 500_000_000,
              subs: ["D:/Anime/Frieren/Subs/Frieren - 01.en.forced.ass"],
            },
          ],
          errors: [],
        };
      }
      if (cmd === "probe_local_subtitles") {
        return [
          { index: 2, codec: "ass", lang: "eng", title: "Full Subtitles", isDefault: true, isForced: false, isHearingImpaired: false, isText: true },
          { index: 3, codec: "hdmv_pgs_subtitle", lang: "jpn", title: "PGS", isDefault: false, isForced: false, isHearingImpaired: false, isText: false },
        ];
      }
      return [];
    });

    const settings = { ...getSettings(), libraryPaths: ["D:/Anime"] };
    const req: PlaybackRequest = {
      media: { key: "anilist:154587", kind: "anime", title: "Frieren", overview: "", genres: [] },
      episode: 1,
      audio: "sub",
    };
    const res = await localProvider.find(req, settings, new AbortController().signal);
    expect(res).toHaveLength(1);
    expect(res[0].subtitles).toEqual([
      expect.objectContaining({ lang: "en", format: "ass", isForced: true, source: "sidecar" }),
      expect.objectContaining({
        lang: "en",
        url: "embedded://2",
        streamIndex: 2,
        format: "ass",
        isDefault: true,
        source: "embedded",
      }),
    ]);

    // Defensive handling when probe_local_subtitles throws
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "scan_library") {
        return {
          files: [{ path: "D:/Anime/Frieren/Frieren - 02.mkv", name: "Frieren - 02", size: 500_000_000, subs: [] }],
          errors: [],
        };
      }
      throw new Error("ffprobe missing");
    });
    const resErr = await localProvider.find(
      { ...req, episode: 2 },
      { ...settings, libraryPaths: ["D:/Anime2"] },
      new AbortController().signal,
    );
    expect(resErr).toHaveLength(1);
    expect(resErr[0].subtitles).toEqual([]);
  });

  it("infers sniffed subtitle metadata and filters thumbnails in verifyEmbed and kisskhProvider", async () => {
    mockSniff.mockResolvedValue({
      url: "https://media.example/master.m3u8",
      kind: "hls",
      headers: { referer: "https://embed.example/" },
      subtitles: [
        "https://cdn.example/thumbs/thumbnails.vtt",
        "https://cdn.example/subs/es.forced.srt?v=2",
        "https://cdn.example/subs/pt-br/track.ass",
      ],
      verified: true,
      quality: 1080,
    });

    const verified = await verifyEmbed(candidate("vidfast"));
    expect(verified.subtitles).toHaveLength(2);
    expect(verified.subtitles?.[0]).toMatchObject({
      lang: "es",
      format: "srt",
      isForced: true,
      source: "stream",
    });
    expect(verified.subtitles?.[1]).toMatchObject({
      lang: "pt-br",
      format: "ass",
      source: "stream",
    });

    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.includes("/Search")) {
        return { status: 200, url, body: JSON.stringify([{ id: 77, title: "My Drama", episodesCount: 16 }]) };
      }
      return { status: 200, url, body: JSON.stringify({ id: 77, title: "My Drama", episodes: [{ id: 501, number: 1 }] }) };
    });
    const kissRes = await kisskhProvider.find(
      {
        media: { key: "tmdb:tv:999", kind: "tv", title: "My Drama", overview: "", genres: [], originalLanguage: "ko" },
        season: 1,
        episode: 1,
      },
      getSettings(),
      new AbortController().signal,
    );
    expect(kissRes).toHaveLength(1);
    expect(kissRes[0].subtitles).toHaveLength(2);
    expect(kissRes[0].subtitles?.[0]).toMatchObject({ lang: "es", format: "srt", source: "stream" });
  });

  it("filters thumbnails and preserves ASS/default metadata in animeDirectProvider", async () => {
    const cfg = {
      src: "https://cdn.example/master.m3u8",
      subtitles: [
        { src: "https://cdn.example/thumbnails.vtt", kind: "thumbnails", label: "Thumbnails" },
        { src: "https://cdn.example/ara.ass?tok=1", lang: "en", label: "Arabic (-)", default: true },
        { src: "https://cdn.example/eng.vtt", lang: "en", label: "English" },
      ],
    };
    const key = new TextEncoder().encode("otaku-embed-v1");
    const jsonBytes = new TextEncoder().encode(JSON.stringify(cfg));
    const xored = jsonBytes.map((b, i) => b ^ key[i % key.length]);
    const b64 = btoa(String.fromCharCode(...xored));
    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://zokoanime.video/stream/mal/21/1/sub",
      body: `<script>window.__P="${b64}"</script>`,
    });

    const out = await animeDirectProvider.find(
      {
        media: { key: "anilist:21", kind: "anime", title: "One Piece", overview: "", genres: [], malId: 21 },
        episode: 1,
        audio: "sub",
      },
      getSettings(),
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0].subtitles).toHaveLength(2);
    expect(out[0].subtitles?.[0]).toMatchObject({
      lang: "ar",
      label: "Arabic",
      format: "ass",
      isDefault: true,
      source: "stream",
    });
    expect(out[0].subtitles?.[1]).toMatchObject({
      lang: "en",
      label: "English",
      format: "vtt",
      isDefault: false,
      source: "stream",
    });
  });

  it("preserves ASS codec URLs and subtitle metadata flags in jellyfinProvider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            Items: [
              {
                Id: "item-1",
                Name: "Test Film",
                ProductionYear: 2024,
                Height: 1080,
                MediaSources: [
                  {
                    Id: "src-1",
                    MediaStreams: [
                      { Type: "Subtitle", Index: 2, Codec: "ass", Language: "eng", DisplayTitle: "English ASS", IsDefault: true, IsForced: false, IsHearingImpaired: false, IsTextSubtitleStream: true },
                      { Type: "Subtitle", Index: 3, Codec: "subrip", Language: "spa", DisplayTitle: "Spanish SDH", IsDefault: false, IsForced: false, IsHearingImpaired: true, IsTextSubtitleStream: true },
                      { Type: "Subtitle", Index: 4, Codec: "pgssub", Language: "jpn", IsTextSubtitleStream: false },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const jfSettings = {
      ...getSettings(),
      jellyfin: { enabled: true, url: "http://localhost:8096", apiKey: "secret" },
    };
    const res = await jellyfinProvider.find(
      { media: { key: "tmdb:movie:1", kind: "movie", title: "Test Film", year: 2024, overview: "", genres: [] } },
      jfSettings,
      new AbortController().signal,
    );
    expect(res).toHaveLength(1);
    expect(res[0].subtitles).toHaveLength(2);
    expect(res[0].subtitles?.[0]).toMatchObject({
      lang: "en",
      format: "ass",
      isDefault: true,
      isForced: false,
      isHearingImpaired: false,
      source: "stream",
    });
    expect(res[0].subtitles?.[0].url).toContain("/Subtitles/2/0/Stream.ass?");
    expect(res[0].subtitles?.[1]).toMatchObject({
      lang: "es",
      format: "vtt",
      isHearingImpaired: true,
      source: "stream",
    });
    expect(res[0].subtitles?.[1].url).toContain("/Subtitles/3/0/Stream.vtt?");
  });

  it("syncs subtitlePref cleanly and mirrors to abx.subs.v1 without wiping existing defaults", () => {
    localStorage.setItem("abx.subs.v1", JSON.stringify({ size: "m", lang: "en", bgOpacity: 0.72 }));
    const events: unknown[] = [];
    const onSubPref = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("abx:subpref", onSubPref);

    try {
      applyRemoteSettings({ subtitlePref: { size: "l", font: "mono" } });
      expect(getSettings().subtitlePref).toEqual({ size: "l", lang: "en", bgOpacity: 0.72, font: "mono" });
      expect(JSON.parse(localStorage.getItem("abx.subs.v1")!)).toEqual({
        size: "l",
        lang: "en",
        bgOpacity: 0.72,
        font: "mono",
      });
      expect(events).toHaveLength(1);

      updateSettings({ subtitlePref: { size: "xl", lang: "ja", bgOpacity: 0.72, font: "mono" } });
      expect(getSettings().subtitlePref).toMatchObject({ size: "xl", lang: "ja", font: "mono" });
    } finally {
      window.removeEventListener("abx:subpref", onSubPref);
      localStorage.removeItem("abx.subs.v1");
      localStorage.removeItem("abx.settings.v1");
    }
  });
});
