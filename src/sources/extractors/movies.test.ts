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
import { castleProvider, clearCastleKeyCache, decryptCastlePayload } from "./castle";
import {
  base64ToBytes,
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchWithAbort,
  inferStreamKind,
  md5Bytes,
  normalizeQuality,
  xsalsa20Poly1305Seal,
} from "./common";
import { primesrcProvider } from "./primesrc";
import { vaplayerProvider } from "./vaplayer";
import { encryptVidLinkToken, vidlinkProvider } from "./vidlink";
import { decryptVidrockUrl, vidrockProvider } from "./vidrock";
import { buildVixMasterUrl, extractVixTokenData, parseVixMasterPlaylist, vixsrcProvider } from "./vixsrc";
import { clearZxcBaseCache, decryptZxcLink, zxcstreamsProvider } from "./zxcstreams";

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
  clearCastleKeyCache();
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
  it("decrypts OpenSSL Salted__ AES-256-CBC stream links", async () => {
    const md5Hex = (s: string) =>
      Array.from(md5Bytes(new TextEncoder().encode(s)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");

    const pass = new TextEncoder().encode("7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c");
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const derived = new Uint8Array(48);
    let filled = 0;
    let prev: Uint8Array = new Uint8Array(0);
    while (filled < 48) {
      const buf = new Uint8Array(prev.length + pass.length + salt.length);
      buf.set(prev, 0);
      buf.set(pass, prev.length);
      buf.set(salt, prev.length + pass.length);
      prev = md5Bytes(buf);
      const take = Math.min(prev.length, 48 - filled);
      derived.set(prev.subarray(0, take), filled);
      filled += take;
    }

    const key = await crypto.subtle.importKey("raw", derived.subarray(0, 32), { name: "AES-CBC" }, false, ["encrypt"]);
    const cipherBuf = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: derived.subarray(32, 48) },
        key,
        new TextEncoder().encode("https://vidstuck.cc/master.m3u8"),
      ),
    );
    const header = new TextEncoder().encode("Salted__");
    const full = new Uint8Array(header.length + salt.length + cipherBuf.length);
    full.set(header, 0);
    full.set(salt, header.length);
    full.set(cipherBuf, header.length + salt.length);

    expect(await decryptZxcLink(bytesToB64(full))).toBe("https://vidstuck.cc/master.m3u8");
    expect(await decryptZxcLink("https://cdn.example/direct.m3u8")).toBe("https://cdn.example/direct.m3u8");
    expect(await decryptZxcLink("not-encrypted")).toBeNull();
  });

  it("requests per-server andromeda tokens, extracts all servers, and strips Referer for hakunaymatata", async () => {
    mockHttpFetch.mockImplementation(async (url: string, _headers?: Record<string, string>, opts?: { body?: string }) => {
      if (url === "https://zxcstream.cc/backend/andromeda") {
        const body = JSON.parse(opts?.body ?? "{}");
        const srv = body["6b491e258392e7561a9384c"];
        return {
          status: 200,
          url,
          body: JSON.stringify({ ts: 1700000001, token: `tok-${srv}` }),
        };
      }
      if (url.includes("/backend_/sources/ursa?")) {
        expect(url).toContain("tok-ursa");
        return {
          status: 200,
          url,
          body: JSON.stringify({
            success: true,
            links: [{ link: "https://vidstuck.cc/ursa/master.m3u8", type: "hls", resolution: 1080, size: 1_500_000_000 }],
          }),
        };
      }
      if (url.includes("/backend_/sources/alatreon?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            success: true,
            links: [{ link: "https://vidstuck.cc/alatreon/2160.m3u8", resolution: 2160 }],
          }),
        };
      }
      if (url.includes("/backend_/sources/valstrax?")) {
        return { status: 500, url, body: "err" };
      }
      if (url.includes("/backend_/sources/orion?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            success: true,
            links: [{ link: "https://bcdnt.hakunaymatata.com/720.mp4", type: "mp4", resolution: "720p" }],
          }),
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await zxcstreamsProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(3);
    expect(out.map((c) => unwrapProxyUrl(c.url).url)).toEqual([
      "https://vidstuck.cc/alatreon/2160.m3u8",
      "https://vidstuck.cc/ursa/master.m3u8",
      "https://bcdnt.hakunaymatata.com/720.mp4",
    ]);
    expect(out[0].quality).toBe(2160);
    expect(out[1].label).toContain("Ursa");
    expect(out[1].label).toContain("1.50 GB");
    expect(out[0].headers?.referer).toBe("https://zxcstream.cc/");
    // hakunaymatata.com must NOT receive Referer or Origin and must use a non-browser UA
    expect(out[2].kind).toBe("file");
    expect(out[2].headers?.referer).toBeUndefined();
    expect(out[2].headers?.origin).toBeUndefined();
    expect(out[2].headers?.ua).toBe("Lavf/60.3.100");
    expect(unwrapProxyUrl(out[2].url).headers.referer).toBeUndefined();
    expect(unwrapProxyUrl(out[2].url).headers.ua).toBe("Lavf/60.3.100");
  });

  it("falls back to secondary domain zxcstream.com when primary fails and respects disabledSources", async () => {
    expect(zxcstreamsProvider.isEnabled?.(makeSettings({ disabledSources: ["zxcstreams"] }))).toBe(false);
    expect(zxcstreamsProvider.isEnabled?.(makeSettings())).toBe(true);

    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://zxcstream.cc/")) return { status: 503, url, body: "" };
      if (url === "https://zxcstream.com/backend/andromeda") {
        return { status: 200, url, body: JSON.stringify({ ts: 1700000002, token: "tok2" }) };
      }
      if (url.startsWith("https://zxcstream.com/backend_/sources/ursa?")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({ success: true, links: [{ link: "https://vidstuck.cc/r2.m3u8", resolution: 1080 }] }),
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await zxcstreamsProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://vidstuck.cc/r2.m3u8");
    expect(out[0].headers?.referer).toBe("https://zxcstream.com/");
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
  it("encrypts XSalsa20-Poly1305 tokens with unique 24-byte random nonce prefixes", () => {
    const t1 = encryptVidLinkToken("550", 1_700_000_000_000);
    const t2 = encryptVidLinkToken("550", 1_700_000_000_000);
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t2).toMatch(/^[A-Za-z0-9_-]+$/);
    const raw = base64ToBytes(t1);
    // 24-byte random nonce + 16-byte MAC + (3 bytes "550" + 8 bytes uint64) = 51 bytes
    expect(raw.length).toBe(51);
    expect(Array.from(raw.subarray(0, 24)).some((b) => b !== 0)).toBe(true);
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

  it("falls back to enc-vidlink when local token returns empty and strips Referer/Chrome UA on hakunaymatata", async () => {
    const requestedHeaders: Record<string, string>[] = [];
    mockHttpFetch.mockImplementation(async (url: string, headers: Record<string, string> = {}) => {
      requestedHeaders.push(headers);
      if (url.startsWith("https://vidlink.pro/api/b/movie/enc-tok-550")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            stream: {
              qualities: {
                "720": { url: "https://bcdn.hakunaymatata.com/video/550.mp4", type: "mp4" },
              },
            },
          }),
        };
      }
      if (url.startsWith("https://vidlink.pro/api/b/movie/")) {
        return { status: 200, url, body: "null" };
      }
      if (url === "https://enc-dec.app/api/enc-vidlink?text=550") {
        return { status: 200, url, body: JSON.stringify({ status: 200, result: "enc-tok-550" }) };
      }
      return { status: 404, url, body: "" };
    });

    const out = await vidlinkProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(requestedHeaders[0]["X-Playback-Environment"]).toBe("standard");
    expect(out[0].pageUrl).toBeUndefined();
    expect(out[0].headers?.referer).toBeUndefined();
    expect(out[0].headers?.origin).toBeUndefined();
    expect(out[0].headers?.ua).toBe("Lavf/60.3.100");
    expect(unwrapProxyUrl(out[0].url).headers).toEqual({ ua: "Lavf/60.3.100" });
  });
});

describe("castleProvider", () => {
  const secKeyB64 = bytesToB64(new TextEncoder().encode("fjATm*kgfJ"));

  async function encryptCastle(payload: unknown): Promise<string> {
    const rawKey = new Uint8Array([...b64ToBytes(secKeyB64), ...new TextEncoder().encode("T!BgJB")]).subarray(0, 16);
    const cryptoKey = await crypto.subtle.importKey("raw", rawKey, "AES-CBC", false, ["encrypt"]);
    const pt = new TextEncoder().encode(JSON.stringify({ code: 200, data: payload }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: rawKey }, cryptoKey, pt));
    return bytesToB64(ct);
  }

  it("decrypts raw base64 and JSON-wrapped Castle AES-128-CBC responses", async () => {
    const rawCipher = await encryptCastle({ hello: "world" });
    expect(await decryptCastlePayload(rawCipher, secKeyB64)).toEqual({ hello: "world" });
    expect(await decryptCastlePayload(JSON.stringify({ code: 200, data: rawCipher }), secKeyB64)).toEqual({ hello: "world" });
    expect(await decryptCastlePayload("{bad-json", secKeyB64)).toBeNull();
  });

  it("prioritizes OST/English tracks, switches TV seasons, and resolves Castle HLS streams", async () => {
    const secResp = JSON.stringify({ code: 200, data: secKeyB64 });
    const searchCipher = await encryptCastle({
      rows: [{ id: "root-got", title: "Game of Thrones", publishTime: "2011-04-17" }],
    });
    const rootDetailCipher = await encryptCastle({
      id: "root-got",
      seasons: [
        { number: 1, movieId: "got-s1" },
        { number: 2, movieId: "got-s2" },
      ],
      episodes: [{ id: "wrong-ep", number: 1, tracks: [] }],
    });
    const s1DetailCipher = await encryptCastle({
      id: "got-s1",
      episodes: [
        {
          id: "ep1-id",
          number: 1,
          tracks: [
            { languageId: 1018, abbreviate: "hi", languageName: "Hindi", isDefault: true },
            { languageId: 1003, abbreviate: "en", languageName: "English", isDefault: false },
          ],
        },
      ],
    });
    const videoCipher = await encryptCastle({
      videoUrl: "https://img1.hscow.com/hls_mps/got_s1e1/720/index_287.m3u8",
      videos: [
        { resolution: 1, resolutionDescription: "SD 480P", premiumProPermission: false },
        { resolution: 2, resolutionDescription: "HD 720P", premiumProPermission: false },
        { resolution: 3, resolutionDescription: "FHD 1080P", premiumProPermission: true },
      ],
      subtitles: [
        {
          languageId: 1003,
          abbreviate: "en",
          title: "English",
          url: "https://img1.fodcyy.com/subtitle/got/English_1.vtt",
          isDefault: true,
        },
      ],
    });

    let postedLanguageId: string | undefined;
    const postedResolutions: string[] = [];
    mockHttpFetch.mockImplementation(async (url: string, _headers, init?: { method?: string; body?: string }) => {
      if (url.includes("/getSecurityKey/")) return { status: 200, url, body: secResp };
      if (url.includes("/searchByKeyword")) return { status: 200, url, body: searchCipher };
      if (url.includes("movieId=root-got")) return { status: 200, url, body: rootDetailCipher };
      if (url.includes("movieId=got-s1")) return { status: 200, url, body: s1DetailCipher };
      if (init?.method === "POST" && url.includes("/getVideo2") && init.body) {
        const parsed = JSON.parse(init.body) as {
          languageId?: string;
          movieId?: string;
          episodeId?: string;
          resolution?: string;
        };
        postedLanguageId = parsed.languageId;
        if (parsed.resolution) postedResolutions.push(parsed.resolution);
        expect(parsed.movieId).toBe("got-s1");
        expect(parsed.episodeId).toBe("ep1-id");
        return { status: 200, url, body: videoCipher };
      }
      return { status: 404, url, body: "" };
    });

    const tvReq = makeReq({
      media: makeMedia({
        key: "tmdb:tv:1399",
        kind: "tv",
        title: "Game of Thrones",
        originalTitle: "Game of Thrones",
        year: 2011,
      }),
      season: 1,
      episode: 1,
    });
    const out = await castleProvider.find(tvReq, makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(postedLanguageId).toBe("1003");
    expect(postedResolutions).toEqual(["2"]);
    expect(out[0].quality).toBe(720);
    expect(out[0].pageUrl).toBeUndefined();
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://img1.hscow.com/hls_mps/got_s1e1/720/index_287.m3u8");
    expect(out[0].subtitles).toHaveLength(1);
    expect(out[0].subtitles?.[0].lang).toBe("en");
    expect(out[0].subtitles?.[0].label).toBe("English");
    expect(unwrapProxyUrl(out[0].subtitles![0].url).url).toBe(
      "https://img1.fodcyy.com/subtitle/got/English_1.vtt",
    );
  });

  it("falls back from gated 720p to 480p and upgrades to 1080p when unlocked", async () => {
    const secResp = JSON.stringify({ code: 200, data: secKeyB64 });
    const searchCipher = await encryptCastle({
      rows: [{ id: "m-550", title: "Fight Club", publishTime: "1999-10-15" }],
    });
    const detailCipher = await encryptCastle({
      id: "m-550",
      episodes: [{ id: "ep-550", number: 1, tracks: [{ languageId: 1003, abbreviate: "en", languageName: "English" }] }],
    });

    const deniedRes2 = await encryptCastle({ permissionDenied: true, expireTime: 1790000000 });
    const allowedRes1 = await encryptCastle({
      videoUrl: "https://img1.hscow.com/hls/fc/480/index.m3u8",
      permissionDenied: false,
    });
    const unlockedRes2 = await encryptCastle({
      videoUrl: "https://img1.hscow.com/hls/fc/720/index.m3u8",
      permissionDenied: false,
      videos: [
        { resolution: 2, resolutionDescription: "HD 720P", premiumProPermission: false },
        { resolution: 3, resolutionDescription: "FHD 1080P", premiumProPermission: false },
      ],
    });
    const unlockedRes3 = await encryptCastle({
      videoUrl: "https://img1.hscow.com/hls/fc/1080/index.m3u8",
      permissionDenied: false,
    });

    let mode: "fallback" | "upgrade" = "fallback";
    mockHttpFetch.mockImplementation(async (url: string, _headers, init?: { method?: string; body?: string }) => {
      if (url.includes("/getSecurityKey/")) return { status: 200, url, body: secResp };
      if (url.includes("/searchByKeyword")) return { status: 200, url, body: searchCipher };
      if (url.includes("movieId=m-550")) return { status: 200, url, body: detailCipher };
      if (init?.method === "POST" && url.includes("/getVideo2") && init.body) {
        const parsed = JSON.parse(init.body) as { resolution?: string };
        if (mode === "fallback") {
          return { status: 200, url, body: parsed.resolution === "2" ? deniedRes2 : allowedRes1 };
        }
        return { status: 200, url, body: parsed.resolution === "3" ? unlockedRes3 : unlockedRes2 };
      }
      return { status: 404, url, body: "" };
    });

    const outFallback = await castleProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(outFallback).toHaveLength(1);
    expect(outFallback[0].quality).toBe(480);

    mode = "upgrade";
    const outUpgrade = await castleProvider.find(makeReq(), makeSettings(), new AbortController().signal);
    expect(outUpgrade.map((c) => c.quality)).toEqual([1080, 720]);
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
