import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../../lib/types";

const { mockHttpFetch } = vi.hoisted(() => ({
  mockHttpFetch: vi.fn(),
}));

vi.mock("../native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native")>();
  return {
    ...actual,
    native: true,
    httpFetch: mockHttpFetch,
  };
});

import { unwrapProxyUrl } from "../native";
import {
  base64ToBytes,
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchWithAbort,
  inferStreamKind,
  normalizeQuality,
  xsalsa20Poly1305Seal,
} from "./common";
import { primesrcProvider } from "./primesrc";
import { vaplayerProvider } from "./vaplayer";
import { encryptVidLinkToken, vidlinkProvider } from "./vidlink";
import { decryptVidrockUrl, vidrockProvider } from "./vidrock";
import { buildVixMasterUrl, extractVixTokenData, parseVixMasterPlaylist, vixsrcProvider } from "./vixsrc";
import { clearZxcBaseCache, generateZxcFrontendToken, zxcstreamsProvider } from "./zxcstreams";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    tmdbKey: "",
    libraryPaths: [],
    jellyfin: { url: "", apiKey: "", enabled: false },
    preferredQuality: 1080,
    autoplayNext: true,
    reduceMotion: false,
    animeAudio: "sub",
    audioByTitle: {},
    disabledSources: [],
    enabledExtras: [],
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaDetail> = {}): MediaDetail {
  return {
    key: "tmdb:movie:550",
    kind: "movie",
    title: "Fight Club",
    originalTitle: "Fight Club",
    overview: "An insomniac office worker forms an underground fight club.",
    year: 1999,
    releaseDate: "1999-10-15",
    imdbId: "tt0137523",
    genres: ["Drama"],
    cast: [],
    crew: [],
    related: [],
    ...overrides,
  };
}

function makeReq(overrides: Partial<PlaybackRequest> = {}): PlaybackRequest {
  return {
    media: makeMedia(),
    audio: "sub",
    ...overrides,
  };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

beforeEach(() => {
  mockHttpFetch.mockReset();
  clearZxcBaseCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("extractors/common crypto & helpers", () => {
  it("matches official TweetNaCl crypto_secretbox test vectors", () => {
    // Vectors from dchest/tweetnacl-js test/data/secretbox.random.js: [key, nonce, msg, box]
    const vectors: Array<[string, string, string, string]> = [
      [
        "givKPH4F/eDcIEUZcws1+BIWqcnx35Ul4qkA7Ilxj1c=",
        "crkCCNKADjatFscwlBoDjXw62dhwMNMp",
        "",
        "ebNFUe0iT6F8tkYMy5Cg2Q==",
      ],
      [
        "hHMQ5Z8jKNzdADMt+jxhYF5437On2tZcokdNX4h5nxI=",
        "qem0uDdL2JT2ObMjonw0UUqOfWTMg7le",
        "1Q==",
        "VJViVugBhKeaOvfSlHkTzUQ=",
      ],
      [
        "fOQduIEEVx7+SPsa33RZhuZXna+J3edbNU/EY+jKcts=",
        "pH0ac45hX1u8fN7xT8L9xdLF9nq3IGyw",
        "4aknivBxlrpQ",
        "qtdSSkeprYxLDft/tU1IebcGbCa31IHKnA==",
      ],
    ];

    for (const [keyB64, nonceB64, msgB64, expectedBoxB64] of vectors) {
      const sealed = xsalsa20Poly1305Seal(b64ToBytes(keyB64), b64ToBytes(nonceB64), b64ToBytes(msgB64));
      expect(bytesToB64(sealed)).toBe(expectedBoxB64);
    }
  });

  it("handles pre-aborted and mid-flight aborts in fetchWithAbort", async () => {
    const preAc = new AbortController();
    preAc.abort();
    await expect(fetchWithAbort("https://example.com", undefined, undefined, preAc.signal)).rejects.toThrow();
    expect(mockHttpFetch).not.toHaveBeenCalled();

    const midAc = new AbortController();
    mockHttpFetch.mockImplementation(() => new Promise(() => {}));
    const p = fetchWithAbort("https://example.com", undefined, undefined, midAc.signal, 5_000);
    midAc.abort();
    await expect(p).rejects.toThrow();
  });

  it("filters thumbnail sprites, deduplicates, and resolves relative subtitles", () => {
    const headers = buildStreamHeaders("https://player.example/embed/1", "https://player.example");
    const tracks = buildSubtitleTracks(
      [
        { url: "/subs/en.vtt", lang: "en", label: "English", isDefault: true },
        { url: "https://player.example/subs/en.vtt", lang: "en", label: "Duplicate" },
        { url: "https://cdn.example/thumbs/sprite-vtt-01.vtt", lang: "en", label: "Thumbnails" },
        { url: "https://cdn.example/sub.srt", lang: "Spanish", label: "Spanish" },
      ],
      headers,
      "https://player.example/embed/1",
    );

    expect(tracks).toHaveLength(2);
    expect(unwrapProxyUrl(tracks[0].url).url).toBe("https://player.example/subs/en.vtt");
    expect(tracks[0].lang).toBe("en");
    expect(tracks[0].isDefault).toBe(true);
    expect(tracks[1].lang).toBe("es");
  });

  it("infers stream kinds and normalizes quality codes", () => {
    expect(inferStreamKind("https://cdn.example/master.m3u8?token=1")).toBe("hls");
    expect(inferStreamKind("https://cdn.example/stream", "mp4")).toBe("file");
    expect(inferStreamKind("https://cdn.example/manifest.mpd")).toBe("dash");
    expect(normalizeQuality(3)).toBe(1080);
    expect(normalizeQuality("4K UHD")).toBe(2160);
    expect(normalizeQuality("720p")).toBe(720);
    expect(normalizeQuality("auto")).toBeUndefined();
  });
});

describe("zxcstreamsProvider", () => {
  it("generates a 64-char SHA-512 frontend token slice", async () => {
    const tok = await generateZxcFrontendToken("550", 1_700_000_000_000);
    expect(tok.rt).toBe(1_700_000_000_000);
    expect(tok.xt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("discovers base via portal redirect, fetches token, and extracts all 4 servers", async () => {
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url === "https://zxcstream.xyz") {
        return { status: 200, url: "https://r7.zxcstream.xyz/", body: "" };
      }
      if (url === "https://zxcprime.xyz") {
        return { status: 200, url: "https://zxcprime.xyz/", body: "" };
      }
      if (url === "https://r7.zxcstream.xyz/backend/token") {
        return {
          status: 200,
          url,
          body: JSON.stringify({ ZDDVHJFGHYRHG: "srv-tok", rdghhdghhfssft: "1700000001" }),
        };
      }
      if (url.includes("/backend_/servers/icarus?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            success: true,
            links: [{ link: "https://cdn.example/icarus/master.m3u8", type: "hls", resolution: 1080, size: 1_500_000_000 }],
          }),
        };
      }
      if (url.includes("/backend_/servers/berkas?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            success: true,
            links: [{ link: "https://cdn.example/berkas/720.mp4", type: "mp4", resolution: "720p" }],
          }),
        };
      }
      if (url.includes("/backend_/servers/orion?")) {
        return { status: 500, url, body: "err" };
      }
      if (url.includes("/backend_/servers/athena?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            success: true,
            links: [{ link: "https://cdn.example/athena/index.m3u8", resolution: 2160 }],
          }),
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await zxcstreamsProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(3);
    expect(out.map((c) => unwrapProxyUrl(c.url).url)).toEqual([
      "https://cdn.example/athena/index.m3u8",
      "https://cdn.example/icarus/master.m3u8",
      "https://cdn.example/berkas/720.mp4",
    ]);
    expect(out[0].quality).toBe(2160);
    expect(out[1].label).toContain("Icarus");
    expect(out[1].label).toContain("1.50 GB");
    expect(out[2].kind).toBe("file");
    expect(out[0].headers?.referer).toBe("https://r7.zxcstream.xyz/player/movie/550");
  });

  it("retries discovery once when cached token fails and respects disabledSources", async () => {
    expect(zxcstreamsProvider.isEnabled?.(makeSettings({ disabledSources: ["zxcstreams"] }))).toBe(false);
    expect(zxcstreamsProvider.isEnabled?.(makeSettings())).toBe(true);

    let failFirstToken = true;
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url === "https://zxcstream.xyz") return { status: 200, url: "https://zxcstream.xyz/", body: "" };
      if (url === "https://zxcprime.xyz") return { status: 200, url: "https://zxcprime.xyz/", body: "" };
      if (url.startsWith("https://r2.zxcstream.xyz/backend/token")) {
        if (failFirstToken) {
          failFirstToken = false;
          return { status: 503, url, body: "" };
        }
        return {
          status: 200,
          url,
          body: JSON.stringify({ ZDDVHJFGHYRHG: "tok2", rdghhdghhfssft: "1700000002" }),
        };
      }
      if (url.includes("/backend_/servers/icarus?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({ success: true, links: [{ link: "https://cdn.example/r2.m3u8", resolution: 1080 }] }),
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await zxcstreamsProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://cdn.example/r2.m3u8");
  });
});

describe("vaplayerProvider", () => {
  it("extracts IMDb TV streams and subtitles", async () => {
    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://streamdata.vaplayer.ru/api.php",
      body: JSON.stringify({
        status_code: 200,
        data: { stream_urls: ["https://cdn.va.example/s1e2/master.m3u8"] },
        default_subs: [
          { url: "https://cdn.va.example/subs/en.vtt", lang: "en", label: "English", default: true },
        ],
      }),
    });

    const req = makeReq({
      media: makeMedia({ key: "tmdb:tv:1399", kind: "tv", title: "Game of Thrones", imdbId: "tt0944947" }),
      season: 1,
      episode: 2,
    });
    const out = await vaplayerProvider.find(req, makeSettings(), new AbortController().signal);
    expect(mockHttpFetch).toHaveBeenCalledWith(
      expect.stringContaining("imdb=tt0944947&type=tv&season=1&episode=2"),
      expect.objectContaining({ Referer: "https://nextgencloudfabric.com/embed/tv/tt0944947/1/2" }),
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("hls");
    expect(out[0].subtitles).toHaveLength(1);
    expect(out[0].subtitles?.[0]?.isDefault).toBe(true);
  });

  it("returns [] on non-200 status_code or anime dub", async () => {
    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://streamdata.vaplayer.ru/api.php",
      body: JSON.stringify({ status_code: 404, error: "Not found" }),
    });
    expect(await vaplayerProvider.find(makeReq(), makeSettings(), new AbortController().signal)).toEqual([]);

    const dubReq = makeReq({ media: makeMedia({ kind: "anime" }), audio: "dub" });
    expect(await vaplayerProvider.find(dubReq, makeSettings(), new AbortController().signal)).toEqual([]);
  });
});

describe("primesrcProvider", () => {
  it("resolves multi-server IMDb links and survives partial server failure", async () => {
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/s?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            servers: [
              { key: "k1", name: "Filemoon", quality: "1080p" },
              { key: "k2", name: "Broken", quality: "720p" },
              { key: "k3", name: "Direct", quality: "4K" },
            ],
          }),
        };
      }
      if (url.includes("key=k1")) return { status: 200, url, body: JSON.stringify({ link: "https://cdn.p/1080.m3u8" }) };
      if (url.includes("key=k2")) return { status: 500, url, body: "" };
      if (url.includes("key=k3")) return { status: 200, url, body: JSON.stringify({ link: "https://cdn.p/movie.mp4" }) };
      return { status: 404, url, body: "" };
    });

    const out = await primesrcProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(2);
    expect(out[0].quality).toBe(2160);
    expect(out[0].kind).toBe("file");
    expect(out[1].quality).toBe(1080);
    expect(out[1].kind).toBe("hls");
  });
});

describe("vixsrcProvider", () => {
  it("parses token HTML, builds master URL, and rejects expired tokens", () => {
    const html = `
      <script>
        window.masterPlaylist = {
          params: { 'token': 'abc123', 'expires': '4102444800' },
          url: 'https://vixcloud.co/playlist/98765?b=1'
        };
        window.canPlayFHD = true;
      </script>
    `;
    const parsed = extractVixTokenData(html, 1_700_000_000_000);
    expect(parsed).toEqual({
      token: "abc123",
      expires: "4102444800",
      playlist: "https://vixcloud.co/playlist/98765?b=1",
      canPlayFhd: true,
    });
    expect(buildVixMasterUrl(parsed!)).toBe(
      "https://vixcloud.co/playlist/98765.m3u8?b=1&token=abc123&expires=4102444800&h=1",
    );

    const expiredHtml = html.replace("4102444800", "1600000000");
    expect(extractVixTokenData(expiredHtml, 1_700_000_000_000)).toBeNull();
  });

  it("extracts VixSrc master playlist quality, audio langs, and softsubs", async () => {
    const futureExp = String(Math.floor(Date.now() / 1000) + 3600);
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url === "https://vixsrc.to/api/movie/550") {
        return { status: 200, url, body: JSON.stringify({ src: "/movie/550" }) };
      }
      if (url === "https://vixsrc.to/movie/550") {
        return {
          status: 200,
          url,
          body: `window.canPlayFHD = true; params: { 'token': 'tok9', 'expires': '${futureExp}' }, url: 'https://vixcloud.co/playlist/550'`,
        };
      }
      if (url.startsWith("https://vixcloud.co/playlist/550.m3u8")) {
        return {
          status: 200,
          url,
          body: [
            "#EXTM3U",
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="a.m3u8"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="https://vixcloud.co/sub/en.vtt"',
            '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
            "1080.m3u8",
          ].join("\n"),
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await vixsrcProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(out[0].quality).toBe(1080);
    expect(out[0].label).toContain("EN");
    expect(out[0].subtitles).toHaveLength(1);
    expect(unwrapProxyUrl(out[0].subtitles![0].url).url).toBe("https://vixcloud.co/sub/en.vtt");

    const parsed = parseVixMasterPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n720.m3u8", "https://x/m.m3u8");
    expect(parsed.quality).toBe(720);
  });
});

describe("vidlinkProvider", () => {
  it("encrypts deterministic XSalsa20-Poly1305 tokens with 24 zero-nonce prefix", () => {
    const t1 = encryptVidLinkToken("550", 1_700_000_000_000);
    const t2 = encryptVidLinkToken("550", 1_700_000_000_000);
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
    const raw = base64ToBytes(t1);
    // 24-byte zero nonce + 16-byte MAC + (3 bytes "550" + 8 bytes uint64) = 51 bytes
    expect(raw.length).toBe(51);
    expect(Array.from(raw.subarray(0, 24)).every((b) => b === 0)).toBe(true);
  });

  it("extracts qualities, fallback playlist, captions, and respects vidlink alias disable", async () => {
    expect(vidlinkProvider.isEnabled?.(makeSettings({ disabledSources: ["vidlink"] }))).toBe(false);
    expect(vidlinkProvider.isEnabled?.(makeSettings())).toBe(true);

    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://vidlink.pro/api/b/movie/tok",
      body: JSON.stringify({
        stream: {
          playlist: "https://cdn.vl.example/master.m3u8",
          type: "hls",
          qualities: {
            "1080": { url: "https://cdn.vl.example/1080.mp4", type: "mp4" },
            "720": { url: "https://cdn.vl.example/720.mp4", type: "mp4" },
          },
          captions: [
            { url: "https://cdn.vl.example/en.vtt", language: "English", default: true },
          ],
        },
      }),
    });

    const out = await vidlinkProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(3);
    expect(out[0].quality).toBe(1080);
    expect(out[0].kind).toBe("file");
    expect(out[2].label).toContain("Auto");
    expect(out[0].subtitles).toHaveLength(1);
    expect(out[0].subtitles?.[0]?.lang).toBe("en");
  });
});

describe("vidrockProvider", () => {
  it("decrypts AES-256-GCM server payloads and rejects tampered bytes", async () => {
    const keyHex = "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
    const keyBytes = new Uint8Array(keyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const nonce = new Uint8Array(12).fill(7);
    const pt = new TextEncoder().encode("https://cdn.vr.example/stream/1080p.m3u8");
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, pt));
    const combined = new Uint8Array(nonce.length + ct.length);
    combined.set(nonce, 0);
    combined.set(ct, nonce.length);
    const b64url = bytesToB64(combined).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(await decryptVidrockUrl(b64url)).toBe("https://cdn.vr.example/stream/1080p.m3u8");
    expect(await decryptVidrockUrl("invalid")).toBeNull();

    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://vidrock.ru/api/movie/550/",
      body: JSON.stringify({
        alpha: b64url,
        broken: "bad-payload",
      }),
    });

    const out = await vidrockProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(out[0].label).toContain("alpha");
    expect(out[0].quality).toBe(1080);
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://cdn.vr.example/stream/1080p.m3u8");
  });
});
