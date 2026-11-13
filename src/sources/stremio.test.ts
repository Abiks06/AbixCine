import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { httpFetch, unwrapProxyUrl } from "./native";
import {
  addStremioAddon,
  fetchStremioManifest,
  fetchStremioSubtitles,
  getStremioConfig,
  listStremioAddons,
  removeStremioAddon,
  resolveStremioStreams,
  STREMIO_STORAGE_KEY,
  stremioProvider,
  toggleStremioAddon,
  type StremioAddonConfig,
} from "./stremio";

vi.mock("./native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native")>();
  return {
    ...actual,
    httpFetch: vi.fn(),
  };
});

const mockHttpFetch = vi.mocked(httpFetch);

const HASH_CACHED = "c".repeat(40);
const HASH_UNCACHED = "d".repeat(40);

function makeAddon(overrides: Partial<StremioAddonConfig> = {}): StremioAddonConfig {
  return {
    id: "com.test.addon",
    name: "TestAddon",
    manifestUrl: "https://addon.example/manifest.json",
    baseUrl: "https://addon.example",
    enabled: true,
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    ...overrides,
  };
}

function makeReq(overrides: Partial<MediaDetail> = {}, season?: number, episode?: number): PlaybackRequest {
  return {
    media: {
      key: "tmdb:movie:603",
      kind: "movie",
      title: "The Matrix",
      overview: "",
      genres: [],
      imdbId: "tt0133093",
      ...overrides,
    } as MediaDetail,
    season,
    episode,
  };
}

beforeEach(() => {
  mockHttpFetch.mockReset();
  localStorage.removeItem(STREMIO_STORAGE_KEY);
  localStorage.removeItem("abx.debrid.v1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchStremioManifest & addon storage", () => {
  it("normalizes stremio:// URLs, preserves config path prefixes, and validates manifest", async () => {
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://torrentio.example/providers=yts/manifest.json",
      body: JSON.stringify({
        id: "com.stremio.torrentio.addon",
        name: "Torrentio",
        version: "0.0.15",
        description: "Torrent streams",
        resources: ["stream"],
        types: ["movie", "series", "anime"],
        idPrefixes: ["tt", "kitsu"],
      }),
    });

    const addon = await fetchStremioManifest("stremio://torrentio.example/providers=yts/manifest.json");
    expect(mockHttpFetch).toHaveBeenCalledWith(
      "https://torrentio.example/providers=yts/manifest.json",
      { Accept: "application/json" },
    );
    expect(addon).toMatchObject({
      id: "com.stremio.torrentio.addon",
      name: "Torrentio",
      manifestUrl: "https://torrentio.example/providers=yts/manifest.json",
      baseUrl: "https://torrentio.example/providers=yts",
      enabled: true,
      types: ["movie", "series", "anime"],
    });
  });

  it("rejects invalid manifests and respects AbortSignal", async () => {
    mockHttpFetch.mockResolvedValueOnce({ status: 404, url: "x", body: "" });
    await expect(fetchStremioManifest("https://bad.example/manifest.json")).rejects.toThrow("HTTP 404");

    mockHttpFetch.mockResolvedValueOnce({ status: 200, url: "x", body: JSON.stringify({ name: "NoId" }) });
    await expect(fetchStremioManifest("https://bad.example")).rejects.toThrow("missing a valid 'id'");

    const ctl = new AbortController();
    ctl.abort();
    await expect(fetchStremioManifest("https://bad.example/manifest.json", ctl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("persists addons in abx.stremio.v1 and supports settings override", async () => {
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://one.example/manifest.json",
      body: JSON.stringify({ id: "one", name: "One", version: "1.0.0", resources: ["stream"], types: ["movie"] }),
    });

    await addStremioAddon("https://one.example/manifest.json");
    expect(listStremioAddons()).toHaveLength(1);
    expect(stremioProvider.isEnabled(getSettings())).toBe(true);

    toggleStremioAddon("one", false);
    expect(listStremioAddons()[0].enabled).toBe(false);
    expect(stremioProvider.isEnabled(getSettings())).toBe(false);

    const overrideAddon = makeAddon({ id: "override", name: "Override" });
    const overridden = getStremioConfig({ stremio: { addons: [overrideAddon], torrentMode: true } });
    expect(overridden.addons).toHaveLength(1);
    expect(overridden.addons[0].id).toBe("override");
    expect(overridden.torrentMode).toBe(true);

    removeStremioAddon("one");
    expect(listStremioAddons()).toHaveLength(0);
  });
});

describe("stremioProvider & resolveStremioStreams", () => {
  it("queries enabled addons in parallel, isolates failures, and maps direct HTTP(S) streams with proxyHeaders", async () => {
    const addonA = makeAddon({ id: "a", name: "AddonA", baseUrl: "https://a.example", manifestUrl: "https://a.example/manifest.json" });
    const addonB = makeAddon({ id: "b", name: "AddonB", baseUrl: "https://b.example", manifestUrl: "https://b.example/manifest.json" });

    mockHttpFetch.mockImplementation(async (url) => {
      if (url === "https://a.example/stream/movie/tt0133093.json") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            streams: [
              {
                name: "AddonA 1080p",
                title: "The.Matrix.1999.1080p.m3u8",
                url: "https://cdn.a.example/matrix/master.m3u8",
                behaviorHints: {
                  proxyHeaders: {
                    request: {
                      Referer: "https://player.a.example/watch",
                      "User-Agent": "CustomUA/1.0",
                    },
                  },
                },
                subtitles: [
                  { url: "https://cdn.a.example/subs/en.vtt", lang: "eng" },
                  { url: "https://cdn.a.example/thumbnails.vtt", lang: "en" },
                ],
              },
              {
                name: "AddonA DASH",
                url: "https://cdn.a.example/matrix/manifest.mpd",
              },
              {
                name: "AddonA MKV",
                url: "https://cdn.a.example/matrix/movie.mkv",
                behaviorHints: { notWebReady: true, videoSize: 2_500_000_000 },
              },
            ],
          }),
        };
      }
      if (url === "https://b.example/stream/movie/tt0133093.json") {
        return { status: 502, url, body: "bad gateway" };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const out = await resolveStremioStreams(makeReq(), { addons: [addonA, addonB] });
    expect(out).toHaveLength(3);

    const hls = out[0];
    expect(hls.providerId).toBe("stremio");
    expect(hls.kind).toBe("hls");
    expect(hls.quality).toBe(1080);
    expect(hls.headers).toEqual({
      referer: "https://player.a.example/watch",
      origin: "https://player.a.example",
      ua: "CustomUA/1.0",
    });
    const unwrapped = unwrapProxyUrl(hls.url);
    expect(unwrapped.proxied).toBe(true);
    expect(unwrapped.url).toBe("https://cdn.a.example/matrix/master.m3u8");
    expect(unwrapped.headers.referer).toBe("https://player.a.example/watch");
    expect(hls.subtitles).toHaveLength(1);
    expect(hls.subtitles![0].lang).toBe("en");
    expect(unwrapProxyUrl(hls.subtitles![0].url).url).toBe("https://cdn.a.example/subs/en.vtt");

    expect(out[1].kind).toBe("dash");
    expect(out[1].url).toBe("https://cdn.a.example/matrix/manifest.mpd");

    expect(out[2].kind).toBe("file");
    expect(out[2].notWebReady).toBe(true);
    expect(out[2].sizeBytes).toBe(2_500_000_000);
  });

  it("queries series/anime as /stream/series/{imdbId}:{season}:{episode}.json and resolves cached torrents via debrid", async () => {
    const addon = makeAddon({
      id: "torrentio",
      name: "Torrentio",
      baseUrl: "https://torrentio.example",
      manifestUrl: "https://torrentio.example/manifest.json",
    });

    mockHttpFetch.mockImplementation(async (url, _headers, init) => {
      if (url === "https://torrentio.example/stream/series/tt0944947:1:2.json") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            streams: [
              {
                name: "Torrentio\n1080p",
                title: "Show.S01E02.1080p.WEB-DL.mkv",
                infoHash: HASH_CACHED,
                fileIdx: 1,
                sources: ["tracker:udp://tracker.opentrackr.org:1337/announce", "dht:1234"],
                behaviorHints: { filename: "Show.S01E02.1080p.WEB-DL.mkv" },
              },
              {
                name: "Torrentio\n720p",
                title: "Show.S01E02.720p.Uncached.mkv",
                infoHash: HASH_UNCACHED,
                fileIdx: 0,
              },
            ],
          }),
        };
      }
      if (url === `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${HASH_CACHED}/${HASH_UNCACHED}`) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            [HASH_CACHED]: { rd: [{ "2": { filename: "Show.S01E02.1080p.WEB-DL.mkv", filesize: 1_800_000_000 } }] },
            [HASH_UNCACHED]: [],
          }),
        };
      }
      if (url === "https://api.real-debrid.com/rest/1.0/torrents/addMagnet") {
        expect(init?.body).toContain(HASH_CACHED);
        expect(init?.body).toContain("tracker.opentrackr.org");
        return { status: 201, url, body: JSON.stringify({ id: "RD1" }) };
      }
      if (url === "https://api.real-debrid.com/rest/1.0/torrents/info/RD1") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            id: "RD1",
            status: "downloaded",
            links: ["https://real-debrid.com/d/FILE1"],
          }),
        };
      }
      if (url === "https://api.real-debrid.com/rest/1.0/unrestrict/link") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            download: "https://s2.real-debrid.com/d/PLAY/Show.S01E02.1080p.WEB-DL.mkv",
            filename: "Show.S01E02.1080p.WEB-DL.mkv",
            filesize: 1_800_000_000,
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const req = makeReq({ key: "anilist:154587", kind: "anime", title: "Frieren", imdbId: "tt0944947" }, 1, 2);
    const out = await resolveStremioStreams(req, {
      addons: [addon],
      debrid: { provider: "realdebrid", apiKey: "rd-secret" },
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      providerId: "stremio",
      providerName: "Torrentio",
      url: "https://s2.real-debrid.com/d/PLAY/Show.S01E02.1080p.WEB-DL.mkv",
      kind: "file",
      via: "direct",
      debridProvider: "realdebrid",
      infoHash: HASH_CACHED,
      fileIdx: 1,
      quality: 1080,
      sizeBytes: 1_800_000_000,
    });
    expect(out[0].label).toContain("RD");
  });

  it("emits magnet metadata cleanly when torrentMode is enabled without Debrid", async () => {
    const addon = makeAddon({ id: "torrentio", name: "Torrentio", baseUrl: "https://torrentio.example" });
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://torrentio.example/stream/movie/tt0133093.json",
      body: JSON.stringify({
        streams: [
          {
            name: "Torrentio 2160p",
            title: "The.Matrix.1999.4K.mkv",
            infoHash: HASH_CACHED,
            fileIdx: 0,
            sources: ["tracker:udp://tracker.example:6969/announce"],
            behaviorHints: { filename: "The.Matrix.1999.4K.mkv", videoSize: 8_000_000_000 },
          },
        ],
      }),
    });

    const disabledOut = await resolveStremioStreams(makeReq(), { addons: [addon], debrid: null, torrentMode: false });
    expect(disabledOut).toEqual([]);

    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://torrentio.example/stream/movie/tt0133093.json",
      body: JSON.stringify({
        streams: [
          {
            name: "Torrentio 2160p",
            title: "The.Matrix.1999.4K.mkv",
            infoHash: HASH_CACHED,
            fileIdx: 0,
            sources: ["tracker:udp://tracker.example:6969/announce"],
            behaviorHints: { filename: "The.Matrix.1999.4K.mkv", videoSize: 8_000_000_000 },
          },
        ],
      }),
    });

    const torrentOut = await resolveStremioStreams(makeReq(), { addons: [addon], debrid: null, torrentMode: true });
    expect(torrentOut).toHaveLength(1);
    expect(torrentOut[0]).toMatchObject({
      providerId: "stremio",
      kind: "file",
      infoHash: HASH_CACHED,
      fileIdx: 0,
      trackers: ["udp://tracker.example:6969/announce"],
      notWebReady: true,
      quality: 2160,
      sizeBytes: 8_000_000_000,
    });
    expect(torrentOut[0].magnet).toContain(`magnet:?xt=urn:btih:${HASH_CACHED}`);
    expect(torrentOut[0].url).toBe(torrentOut[0].magnet);
  });

  it("returns empty array when imdbId is unavailable or AbortSignal is aborted", async () => {
    const addon = makeAddon();
    const noImdbReq = makeReq({ imdbId: undefined, key: "tmdb:movie:999" });
    expect(await resolveStremioStreams(noImdbReq, { addons: [addon] })).toEqual([]);
    expect(mockHttpFetch).not.toHaveBeenCalled();

    const ctl = new AbortController();
    ctl.abort();
    expect(await stremioProvider.find(makeReq(), getSettings(), ctl.signal)).toEqual([]);
  });
});

describe("fetchStremioSubtitles", () => {
  it("queries /subtitles/{type}/{id}.json across subtitle-capable addons and normalizes tracks", async () => {
    const subAddon = makeAddon({
      id: "os-addon",
      name: "OpenSubtitles",
      baseUrl: "https://os.example",
      resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    const streamOnlyAddon = makeAddon({
      id: "stream-only",
      name: "StreamOnly",
      baseUrl: "https://stream.example",
      resources: ["stream"],
    });

    mockHttpFetch.mockImplementation(async (url) => {
      if (url === "https://os.example/subtitles/series/tt0944947:1:3/videoHash=0123456789abcdef.json") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            subtitles: [
              { id: "1", url: "https://os.example/dl/en.srt", lang: "eng", SubFileName: "Show.S01E03.SDH.srt" },
              { id: "2", url: "https://os.example/dl/pt.vtt", lang: "pob" },
              { id: "3", url: "javascript:alert(1)", lang: "eng" },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const subs = await fetchStremioSubtitles([subAddon, streamOnlyAddon], {
      imdbId: "tt0944947",
      kind: "tv",
      season: 1,
      episode: 3,
      videoHash: "0123456789abcdef",
    });

    expect(mockHttpFetch).toHaveBeenCalledTimes(1);
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      addonId: "os-addon",
      addonName: "OpenSubtitles",
      lang: "en",
      langName: "English",
      format: "srt",
      isHearingImpaired: true,
      url: "https://os.example/dl/en.srt",
      source: "online",
    });
    expect(subs[1]).toMatchObject({
      lang: "pt-br",
      langName: "Portuguese (Brazil)",
      format: "vtt",
    });
  });

  it("handles AbortSignal and addon failures gracefully", async () => {
    const subAddon = makeAddon({ id: "sub", resources: ["subtitles"] });
    mockHttpFetch.mockRejectedValueOnce(new Error("network down"));
    expect(await fetchStremioSubtitles([subAddon], { imdbId: "tt0133093", kind: "movie" })).toEqual([]);

    const ctl = new AbortController();
    ctl.abort();
    expect(await fetchStremioSubtitles([subAddon], { imdbId: "tt0133093" }, ctl.signal)).toEqual([]);
  });
});
