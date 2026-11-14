import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackRequest } from "../lib/types";
import { getEntry, saveProgress } from "../lib/progress";
import { applyRemoteSettings, getSettings, updateSettings } from "../lib/settings";
import { animeDirectProvider } from "./anime-direct";
import { buildAnimeUrl, buildEmbedUrl, resolveTmdbId } from "./embeds";
import {
  badUrl,
  CIRCUIT_STREAK_THRESHOLD,
  circuitRemainingMs,
  getHealth,
  isCircuitHalfOpen,
  isCircuitOpen,
  lastPick,
  recordLookupFailure,
  recordPlayback,
  recordProbe,
  resetHealth,
  serverHealthScore,
} from "./health";
import { DIRECT_EXTRACTORS } from "./extractors";
import { jellyfinProvider } from "./jellyfin";
import { kisskhProvider, decryptKisskhSubtitle } from "./kisskh";
import { localProvider, sidecarTrack } from "./local";
import {
  availableSources,
  candLine,
  DIRECT_SOURCES,
  embedProviders,
  initialCandidateIndex,
  playCheck,
  probeHedged,
  PROVIDERS,
  quickCheck,
  score,
  validateManifest,
  verifyEmbed,
} from "./registry";
import { invalidateSessions, SourceSession } from "./session";
import { isUrlTokenExpired, normalizeHeaders, proxyUrl, unwrapProxyUrl, type Sniffed } from "./native";
import { clearPlugins, installPlugin, pluginProvidersSource, PLUGINS_STORAGE_KEY, togglePlugin } from "./pluginRunner";
import { saveStremioAddons, STREMIO_STORAGE_KEY, stremioProvider } from "./stremio";
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
  invalidateSessions();
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

describe("health recovery, incremental resolve cache & embed hardening", () => {
  it("supports selective resetHealth(providerId) vs full reset and clears badUrls for both url and pageUrl on playback success", () => {
    const reqA = request("test:selective-a");
    const reqB = request("test:selective-b");
    const candA = candidate("srv-a");
    const candB: StreamCandidate = {
      ...candidate("srv-b"),
      url: "https://cdn.example/b-stream.m3u8",
      pageUrl: "https://srv-b.example/embed/1",
    };

    recordPlayback(reqA, candA, true);
    for (let i = 0; i < CIRCUIT_STREAK_THRESHOLD; i++) recordLookupFailure("srv-a", 5000);
    expect(isCircuitOpen("srv-a")).toBe(true);
    expect(circuitRemainingMs("srv-a")).toBeGreaterThan(0);

    recordPlayback(reqB, { ...candB, url: candB.pageUrl! }, false);
    recordPlayback(reqB, candB, false);
    expect(badUrl(candB.url)).toBe(true);
    expect(badUrl(candB.pageUrl!)).toBe(true);
    expect(getHealth("srv-b").fail).toBeGreaterThan(0);

    // Selective reset clears only srv-a without erasing srv-b health or badUrls
    resetHealth("srv-a");
    expect(getHealth("srv-a")).toEqual({ ok: 0, fail: 0 });
    expect(isCircuitOpen("srv-a")).toBe(false);
    expect(circuitRemainingMs("srv-a")).toBe(0);
    expect(lastPick(reqA)).toBeUndefined();
    expect(getHealth("srv-b").fail).toBeGreaterThan(0);
    expect(badUrl(candB.url)).toBe(true);

    // Playback success clears badUrls for both url and pageUrl, resets streak/circuit, and records valid latency when absent
    recordPlayback(reqB, { ...candB, url: "https://cdn.example/b-fresh.m3u8" }, true);
    expect(badUrl("https://cdn.example/b-fresh.m3u8")).toBe(false);
    expect(badUrl(candB.pageUrl!)).toBe(false);
    expect(getHealth("srv-b").streak).toBe(0);
    expect(getHealth("srv-b").circuitUntil).toBeUndefined();
    expect(getHealth("srv-b").latencyMs).toBeGreaterThanOrEqual(0);

    // Fresh provider playback without probe latency still populates valid latency
    recordPlayback(reqA, candidate("srv-fresh"), true);
    expect(getHealth("srv-fresh").latencyMs).toBeGreaterThan(0);

    // Full reset clears everything including badUrls
    recordPlayback(reqB, candB, false);
    expect(badUrl(candB.url)).toBe(true);
    resetHealth();
    expect(getHealth("srv-b")).toEqual({ ok: 0, fail: 0 });
    expect(badUrl(candB.url)).toBe(false);
  });

  it("transitions expired circuits to half-open with smooth decay and trial bonus, re-trips on failure, and closes on playback success", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    try {
      const req = request("test:half-open");
      for (let i = 0; i < CIRCUIT_STREAK_THRESHOLD; i++) {
        recordLookupFailure("flaky-srv", 8000);
      }
      expect(isCircuitOpen("flaky-srv")).toBe(true);
      expect(isCircuitHalfOpen("flaky-srv")).toBe(false);
      expect(isCircuitHalfOpen(undefined)).toBe(false);
      const openScore = serverHealthScore("flaky-srv", 15);

      // Still open at 60s
      vi.advanceTimersByTime(60_000);
      expect(isCircuitOpen("flaky-srv")).toBe(true);
      expect(isCircuitHalfOpen("flaky-srv")).toBe(false);
      expect(circuitRemainingMs("flaky-srv")).toBeGreaterThan(0);

      // Cooldown expires after 2m -> half-open with trial bonus + decayed penalty
      vi.advanceTimersByTime(61_000);
      expect(isCircuitOpen("flaky-srv")).toBe(false);
      expect(isCircuitHalfOpen("flaky-srv")).toBe(true);
      expect(circuitRemainingMs("flaky-srv")).toBe(0);
      const halfOpenAt2m = serverHealthScore("flaky-srv", 15);
      expect(halfOpenAt2m).toBeGreaterThan(openScore + 40);

      // Smooth decay reduces penalty further as time passes
      vi.advanceTimersByTime(4 * 60_000);
      expect(serverHealthScore("flaky-srv", 15)).toBeGreaterThan(halfOpenAt2m);

      // A failure during half-open re-opens the circuit with doubled cooldown (4m)
      recordLookupFailure("flaky-srv", 8000);
      expect(isCircuitOpen("flaky-srv")).toBe(true);
      expect(isCircuitHalfOpen("flaky-srv")).toBe(false);
      expect(circuitRemainingMs("flaky-srv")).toBeGreaterThan(3 * 60_000);

      // After 4m cooldown expires again, playback success closes circuit cleanly
      vi.advanceTimersByTime(4 * 60_000 + 1000);
      expect(isCircuitHalfOpen("flaky-srv")).toBe(true);
      recordPlayback(req, { ...candidate("flaky-srv"), probe: { ok: true, latencyMs: 180 } }, true);
      expect(isCircuitOpen("flaky-srv")).toBe(false);
      expect(isCircuitHalfOpen("flaky-srv")).toBe(false);
      expect(getHealth("flaky-srv").streak).toBe(0);
      expect(getHealth("flaky-srv").circuitUntil).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hardens buildEmbedUrl / buildAnimeUrl against missing templates and keeps resolveTmdbId cache clean on failures and aborts", async () => {
    expect(buildEmbedUrl(undefined, "603")).toBe("");
    expect(buildEmbedUrl("", "603")).toBe("");
    expect(buildEmbedUrl("https://vidfast.vc/tv/{id}/{season}/{episode}", "1399", 2, 5)).toBe(
      "https://vidfast.vc/tv/1399/2/5",
    );

    expect(buildAnimeUrl(undefined, "21", 21, 1, "sub")).toBeNull();
    expect(buildAnimeUrl("https://vidlink.pro/anime/{mal}/{episode}/{audio}", "21", undefined, 1, "sub")).toBeNull();
    expect(buildAnimeUrl("https://vidnest.fun/anime/{anilist}/{episode}/{audio}", "21", undefined, 3, "dub")).toBe(
      "https://vidnest.fun/anime/21/3/dub",
    );

    updateSettings({ tmdbKey: "test-tmdb-key" });
    try {
      // 1. Transient failure does not poison LRU cache
      const transientReq: PlaybackRequest = {
        media: { key: "anilist:999101", kind: "anime", title: "TransientLookupUniqueTitle", overview: "", genres: [] },
      };
      const fetchTransient = vi
        .fn()
        .mockResolvedValueOnce(new Response("error", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ results: [{ id: 77101, media_type: "tv", name: "TransientLookupUniqueTitle" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      vi.stubGlobal("fetch", fetchTransient);

      expect(await resolveTmdbId(transientReq)).toBeNull();
      expect(await resolveTmdbId(transientReq)).toBe("77101");
      expect(fetchTransient).toHaveBeenCalledTimes(2);

      // 2. Pre-aborted and mid-flight aborted calls never cache
      const abortedReq: PlaybackRequest = {
        media: { key: "anilist:999102", kind: "anime", title: "AbortedLookupUniqueTitleA", overview: "", genres: [] },
      };
      const retryReqSameKey: PlaybackRequest = {
        media: { key: "anilist:999102", kind: "anime", title: "AbortedLookupUniqueTitleB", overview: "", genres: [] },
      };
      let releaseFirst!: (r: Response) => void;
      const fetchAborted = vi
        .fn()
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ results: [{ id: 88202, media_type: "tv", name: "AbortedLookupUniqueTitleB" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      vi.stubGlobal("fetch", fetchAborted);

      const preAborted = new AbortController();
      preAborted.abort();
      expect(await resolveTmdbId(abortedReq, preAborted.signal)).toBeNull();
      expect(fetchAborted).toHaveBeenCalledTimes(0);

      const inflightCtl = new AbortController();
      const firstCall = resolveTmdbId(abortedReq, inflightCtl.signal);
      inflightCtl.abort();
      expect(await firstCall).toBeNull();

      // Even if the aborted background fetch resolves with an ID, it must not be cached for that key
      releaseFirst(
        new Response(JSON.stringify({ results: [{ id: 11111, media_type: "tv", name: "AbortedLookupUniqueTitleA" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      // Subsequent lookup on the same media key runs fresh instead of returning cached 11111
      expect(await resolveTmdbId(retryReqSameKey)).toBe("88202");
      expect(fetchAborted).toHaveBeenCalledTimes(2);
    } finally {
      localStorage.removeItem("abx.settings.v1");
    }
  });

  it("decrypts KissKH AES-128-CBC .txt/.txt1 subtitles into playable data: URLs", async () => {
    const encKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("8056483646328763"),
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    );
    const iv = new TextEncoder().encode("6852612370185273");
    const encryptLine = async (plain: string) => {
      const cipher = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, encKey, new TextEncoder().encode(plain));
      return btoa(String.fromCharCode(...new Uint8Array(cipher)));
    };

    const c1 = await encryptLine("Hello from Seoul!");
    const c2 = await encryptLine("Line one\nLine two");
    const encryptedSrt = `1\n00:00:01,000 --> 00:00:03,000\n${c1}\n\n2\n00:00:04,000 --> 00:00:06,500\n${c2}\n`;

    const dec = await decryptKisskhSubtitle(encryptedSrt);
    expect(dec.decrypted).toBe(true);
    expect(dec.text).toContain("Hello from Seoul!");
    expect(dec.text).toContain("Line one\nLine two");

    // Unencrypted SRT passes through unchanged
    const plainSrt = "1\n00:00:01,000 --> 00:00:02,000\nAlready plain\n";
    const passthrough = await decryptKisskhSubtitle(plainSrt);
    expect(passthrough.decrypted).toBe(false);
    expect(passthrough.text).toBe(plainSrt);

    // End-to-end kisskhProvider.find with encrypted .txt1 subtitle from /api/Sub/{epId}
    mockSniff.mockResolvedValueOnce({
      url: "https://media.example/kisskh-master.m3u8",
      kind: "hls",
      headers: { referer: "https://kisskh.co/" },
      subtitles: [],
      verified: true,
      quality: 1080,
    });
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.includes("/Search")) {
        return { status: 200, url, body: JSON.stringify([{ id: 88, title: "Encrypted Drama", episodesCount: 8 }]) };
      }
      if (url.includes("/Drama/")) {
        return { status: 200, url, body: JSON.stringify({ id: 88, title: "Encrypted Drama", episodes: [{ id: 901, number: 1 }] }) };
      }
      if (url.includes("/api/Sub/901")) {
        return {
          status: 200,
          url,
          body: JSON.stringify([{ src: "https://cdn.kisskh.example/901/en.txt1", label: "English", land: "en", default: true }]),
        };
      }
      if (url === "https://cdn.kisskh.example/901/en.txt1") {
        return { status: 200, url, body: encryptedSrt };
      }
      return { status: 404, url, body: "" };
    });

    const found = await kisskhProvider.find(
      {
        media: { key: "tmdb:tv:8800", kind: "tv", title: "Encrypted Drama", overview: "", genres: [], originalLanguage: "ko" },
        season: 1,
        episode: 1,
      },
      getSettings(),
      new AbortController().signal,
    );
    expect(found).toHaveLength(1);
    expect(found[0].subtitles).toHaveLength(1);
    const track = found[0].subtitles![0];
    expect(track.lang).toBe("en");
    expect(track.format).toBe("srt");
    expect(track.isDefault).toBe(true);
    expect(track.url).toMatch(/^data:text\/plain;charset=utf-8;base64,/);

    const fetched = await fetch(track.url).then((r) => r.text());
    expect(fetched).toContain("Hello from Seoul!");
    expect(fetched).toContain("Line one\nLine two");
  });
});

describe("Phase 2 direct extractor wiring", () => {
  it("registers all DIRECT_EXTRACTORS in PROVIDERS and DIRECT_SOURCES with unique IDs", () => {
    expect(DIRECT_EXTRACTORS.length).toBeGreaterThanOrEqual(10);
    const providerIds = PROVIDERS.map((p) => p.id);
    const directSourceIds = DIRECT_SOURCES.map((d) => d.id);

    expect(new Set(providerIds).size).toBe(providerIds.length);
    expect(new Set(directSourceIds).size).toBe(directSourceIds.length);

    expect(directSourceIds).toContain("hianime");
    expect(directSourceIds).toContain("kisskh");

    for (const extractor of DIRECT_EXTRACTORS) {
      expect(providerIds).toContain(extractor.id);
      const entry = DIRECT_SOURCES.find((d) => d.id === extractor.id);
      expect(entry).toBeDefined();
      expect(entry?.name).toBeTruthy();
      expect(entry?.note).toBeTruthy();
    }
  });

  it("assigns direct extractors higher base priority than all sniffed embedProviders", () => {
    const maxEmbedPriority = Math.max(...embedProviders.map((p) => p.priority));
    const minDirectPriority = Math.min(...DIRECT_EXTRACTORS.map((p) => p.priority));
    expect(minDirectPriority).toBeGreaterThan(maxEmbedPriority);

    const firstEmbedIdx = PROVIDERS.findIndex((p) => p.id === embedProviders[0].id);
    for (const extractor of DIRECT_EXTRACTORS) {
      expect(extractor.priority).toBeGreaterThan(maxEmbedPriority);
      expect(PROVIDERS.findIndex((p) => p.id === extractor.id)).toBeLessThan(firstEmbedIdx);
    }

    const req = request("test:direct-over-embed");
    const vidlinkDirect = PROVIDERS.find((p) => p.id === "vidlink-direct")!;
    const vidfastEmbed = PROVIDERS.find((p) => p.id === "vidfast")!;
    const directScored = score(
      {
        providerId: vidlinkDirect.id,
        providerName: vidlinkDirect.name,
        label: "VidLink",
        url: "https://cdn.example/direct.m3u8",
        kind: "hls",
        via: "direct",
        probe: { ok: true, latencyMs: 250, quality: 1080 },
      },
      1080,
      vidlinkDirect.priority,
      req,
    );
    const sniffedScored = score(
      {
        providerId: vidfastEmbed.id,
        providerName: vidfastEmbed.name,
        label: "VidFast",
        url: "https://cdn.example/sniffed.m3u8",
        pageUrl: "https://vidfast.vc/movie/603",
        kind: "hls",
        via: "sniffed",
        probe: { ok: true, latencyMs: 250, quality: 1080 },
      },
      1080,
      vidfastEmbed.priority,
      req,
    );
    expect(directScored.score).toBeGreaterThan(sniffedScored.score!);
  });

  it("toggles direct extractors via disabledSources without breaking fallback embeds", async () => {
    const baseSettings = getSettings();
    for (const extractor of DIRECT_EXTRACTORS) {
      expect(extractor.isEnabled(baseSettings)).toBe(true);
    }

    // Disabling a direct extractor ID disables only that extractor
    const toggledOff = { ...baseSettings, disabledSources: ["vidrock", "anizone"] };
    expect(PROVIDERS.find((p) => p.id === "vidrock")!.isEnabled(toggledOff)).toBe(false);
    expect(PROVIDERS.find((p) => p.id === "anizone")!.isEnabled(toggledOff)).toBe(false);
    expect(PROVIDERS.find((p) => p.id === "zxcstreams")!.isEnabled(toggledOff)).toBe(true);
    expect(PROVIDERS.find((p) => p.id === "vidlink-direct")!.isEnabled(toggledOff)).toBe(true);

    // Disabling vidlink-direct leaves the vidlink embed fallback enabled; disabling vidlink disables both
    const directOnlyDisabled = { ...baseSettings, disabledSources: ["vidlink-direct"] };
    expect(PROVIDERS.find((p) => p.id === "vidlink-direct")!.isEnabled(directOnlyDisabled)).toBe(false);
    expect(PROVIDERS.find((p) => p.id === "vidlink")!.isEnabled(directOnlyDisabled)).toBe(true);

    const embedDisabled = { ...baseSettings, disabledSources: ["vidlink"] };
    expect(PROVIDERS.find((p) => p.id === "vidlink-direct")!.isEnabled(embedDisabled)).toBe(false);
    expect(PROVIDERS.find((p) => p.id === "vidlink")!.isEnabled(embedDisabled)).toBe(false);

    // A source session respects disabledSources for direct extractors
    const original = [...PROVIDERS];
    const vidrock = PROVIDERS.find((p) => p.id === "vidrock")!;
    const zxc = PROVIDERS.find((p) => p.id === "zxcstreams")!;
    const vidrockSpy = vi.spyOn(vidrock, "find").mockResolvedValue([]);
    const zxcSpy = vi.spyOn(zxc, "find").mockResolvedValue([]);
    PROVIDERS.splice(0, PROVIDERS.length, vidrock, zxc);
    updateSettings({ disabledSources: ["vidrock"] });

    try {
      await new SourceSession(request("test:disabled-direct")).start().picked();
      expect(vidrockSpy).not.toHaveBeenCalled();
      expect(zxcSpy).toHaveBeenCalledTimes(1);
    } finally {
      vidrockSpy.mockRestore();
      zxcSpy.mockRestore();
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
      localStorage.removeItem("abx.settings.v1");
    }
  });
});

describe("Phase 3 Stremio & JS plugin registry wiring", () => {
  afterEach(() => {
    localStorage.removeItem(STREMIO_STORAGE_KEY);
    localStorage.removeItem(PLUGINS_STORAGE_KEY);
    localStorage.removeItem("abx.settings.v1");
    clearPlugins();
    invalidateSessions();
    vi.restoreAllMocks();
  });

  it("registers stremioProvider and pluginProvidersSource in PROVIDERS and DIRECT_SOURCES", () => {
    expect(PROVIDERS.some((p) => p.id === "stremio")).toBe(true);
    expect(PROVIDERS.some((p) => p.id === "plugins")).toBe(true);
    expect(DIRECT_SOURCES.some((s) => s.id === "stremio")).toBe(true);
    expect(DIRECT_SOURCES.some((s) => s.id === "plugins")).toBe(true);
    expect(stremioProvider.category).toBe("external");
    expect(pluginProvidersSource.category).toBe("external");
  });

  it("keeps stremioProvider and pluginProvidersSource safe and empty when unconfigured", async () => {
    const settings = getSettings();
    const signal = new AbortController().signal;
    expect(stremioProvider.isEnabled(settings)).toBe(false);
    expect(pluginProvidersSource.isEnabled(settings)).toBe(false);
    await expect(stremioProvider.find(request("test:unconfigured-stremio"), settings, signal)).resolves.toEqual([]);
    await expect(pluginProvidersSource.find(request("test:unconfigured-plugins"), settings, signal)).resolves.toEqual([]);
  });

  it("toggles stremio and plugins cleanly via addon/plugin state and disabledSources", async () => {
    saveStremioAddons([
      {
        id: "com.example.torrentio",
        name: "Example Stremio",
        version: "1.0.0",
        manifestUrl: "https://addon.example.com/manifest.json",
        baseUrl: "https://addon.example.com",
        resources: ["stream"],
        types: ["movie", "series"],
        enabled: true,
      },
    ]);
    installPlugin({
      id: "test-plugin",
      name: "Test JS Plugin",
      version: "1.0.0",
      mediaTypes: ["movie", "tv", "anime"],
      allowedHosts: [],
      script: "return [];",
      enabled: true,
      priority: 30,
    });

    expect(stremioProvider.isEnabled(getSettings())).toBe(true);
    expect(pluginProvidersSource.isEnabled(getSettings())).toBe(true);

    updateSettings({ disabledSources: ["stremio", "plugins"] });
    expect(stremioProvider.isEnabled(getSettings())).toBe(false);
    expect(pluginProvidersSource.isEnabled(getSettings())).toBe(false);

    const stremioSpy = vi.spyOn(stremioProvider, "find").mockResolvedValue([]);
    const pluginSpy = vi.spyOn(pluginProvidersSource, "find").mockResolvedValue([]);
    const fakeDirect: SourceProvider = {
      id: "fake-direct",
      name: "FakeDirect",
      priority: 1,
      category: "external",
      isEnabled: () => true,
      find: async () => [],
    };
    const original = [...PROVIDERS];
    PROVIDERS.splice(0, PROVIDERS.length, stremioProvider, pluginProvidersSource, fakeDirect);
    try {
      await new SourceSession(request("test:phase3-disabled")).start().picked();
      expect(stremioSpy).not.toHaveBeenCalled();
      expect(pluginSpy).not.toHaveBeenCalled();

      updateSettings({ disabledSources: [] });
      invalidateSessions();
      togglePlugin("test-plugin", false);
      expect(pluginProvidersSource.isEnabled(getSettings())).toBe(false);
      await new SourceSession(request("test:phase3-stremio-only")).start().picked();
      expect(stremioSpy).toHaveBeenCalledTimes(1);
      expect(pluginSpy).not.toHaveBeenCalled();
    } finally {
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("treats magnet: torrent candidates as valid in quickCheck and playCheck", async () => {
    const magnetCandidate: StreamCandidate = {
      url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Sample",
      kind: "file",
      label: "Sample 1080p",
      providerId: "stremio",
      providerName: "Stremio",
      via: "direct",
    };
    await expect(quickCheck(magnetCandidate)).resolves.toEqual({ ok: true });
    await expect(playCheck(magnetCandidate)).resolves.toEqual({ ok: true });
  });

  it("keeps subdlApiKey local-only and preserves it across applyRemoteSettings", () => {
    updateSettings({ subdlApiKey: "subdl-local-secret" });
    expect(getSettings().subdlApiKey).toBe("subdl-local-secret");

    applyRemoteSettings({ preferredQuality: "720p", subdlApiKey: "should-not-sync" } as Record<string, unknown>);
    expect(getSettings().preferredQuality).toBe("720p");
    expect(getSettings().subdlApiKey).toBe("subdl-local-secret");
  });
});
