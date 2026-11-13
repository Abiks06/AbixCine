import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpFetch, httpFetchBytes, proxyUrl } from "../sources/native";
import {
  clearSubtitleSearchCache,
  fetchAndParseSubtitle,
  normalizeLangCode,
  searchOnlineSubtitles,
} from "./subtitleProviders";

const { mockInvoke, mockIsTauri } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  isTauri: mockIsTauri,
}));

vi.mock("../sources/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/native")>();
  return {
    ...actual,
    httpFetch: vi.fn(),
    httpFetchBytes: vi.fn(),
  };
});

const mockHttpFetch = vi.mocked(httpFetch);
const mockHttpFetchBytes = vi.mocked(httpFetchBytes);

beforeEach(() => {
  clearSubtitleSearchCache();
  mockHttpFetch.mockReset();
  mockHttpFetchBytes.mockReset();
  mockInvoke.mockReset();
  mockIsTauri.mockReturnValue(false);
  localStorage.removeItem("abx.subdl.apiKey");
  localStorage.removeItem("abx.settings.v1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeZipBuffer(entries: { name: string; content: Uint8Array; deflate?: boolean }[], compressedPayloads?: Uint8Array[]): ArrayBuffer {
  const te = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  entries.forEach((entry, idx) => {
    const nameBytes = te.encode(entry.name);
    const payload = compressedPayloads?.[idx] ?? entry.content;
    const method = entry.deflate ? 8 : 0;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.content.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, payload);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.content.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length + payload.length;
  });

  const cdSize = cdParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...localParts, ...cdParts, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out.buffer;
}

describe("normalizeLangCode", () => {
  it("normalizes ISO-639-1/2/3 codes and regional tags", () => {
    expect(normalizeLangCode("eng")).toBe("en");
    expect(normalizeLangCode("spa")).toBe("es");
    expect(normalizeLangCode("jpn")).toBe("ja");
    expect(normalizeLangCode("fre")).toBe("fr");
    expect(normalizeLangCode("fra")).toBe("fr");
    expect(normalizeLangCode("ger")).toBe("de");
    expect(normalizeLangCode("deu")).toBe("de");
    expect(normalizeLangCode("por")).toBe("pt");
    expect(normalizeLangCode("pob")).toBe("pt-br");
    expect(normalizeLangCode("pt-BR")).toBe("pt-br");
    expect(normalizeLangCode("kor")).toBe("ko");
    expect(normalizeLangCode("zho")).toBe("zh");
    expect(normalizeLangCode("chi")).toBe("zh");
    expect(normalizeLangCode("ara")).toBe("ar");
    expect(normalizeLangCode("hin")).toBe("hi");
    expect(normalizeLangCode("rus")).toBe("ru");
    expect(normalizeLangCode("ita")).toBe("it");
    expect(normalizeLangCode("")).toBe("und");
  });
});

describe("searchOnlineSubtitles", () => {
  it("queries Wyzie (sub.wyzie.io) and OpenSubtitles in parallel, ranks, and deduplicates results", async () => {
    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.io/search")) {
        expect(url).toContain("id=1399");
        expect(url).toContain("season=1");
        expect(url).toContain("episode=2");
        return {
          status: 200,
          url,
          body: JSON.stringify([
            {
              id: "w1",
              url: "https://cdn.wyzie.example/sub1.ass",
              language: "en",
              display: "English",
              format: "ass",
              release: "Show.S01E02.1080p.WEB-DL",
              isHearingImpaired: false,
              downloads: 1200,
            },
            {
              id: "w2",
              url: "https://cdn.wyzie.example/sub2.srt",
              language: "es",
              format: "srt",
              release: "Show.S01E02.Spanish.SDH",
              isHearingImpaired: true,
              downloads: 400,
            },
          ]),
        };
      }
      if (url.startsWith("https://opensubtitles-v3.strem.io/subtitles/series/tt0944947:1:2.json")) {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            subtitles: [
              // Cross-provider duplicate release of w1 -> should deduplicate cleanly
              {
                id: "os1",
                url: "https://dl.opensubtitles.example/mirror1.ass",
                lang: "eng",
                SubFileName: "Show.S01E02.1080p.WEB-DL.ass",
              },
              {
                id: "os2",
                url: "https://dl.opensubtitles.example/pob.srt",
                lang: "pob",
                SubFileName: "Show.S01E02.PTBR.srt",
                downloads: 800,
              },
              {
                id: "os3",
                url: "https://dl.opensubtitles.example/forced.srt",
                lang: "eng",
                SubFileName: "Show.S01E02.Forced.srt",
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const results = await searchOnlineSubtitles({
      tmdbId: 1399,
      imdbId: "tt0944947",
      kind: "tv",
      season: 1,
      episode: 2,
      languages: ["pt-br", "en"],
      preferHearingImpaired: "avoid",
    });

    expect(mockHttpFetch).toHaveBeenCalledTimes(2);
    // Preferred language pt-br comes first, then full English ASS (deduplicated), then Forced English, then Spanish SDH
    expect(results.map((r) => r.lang)).toEqual(["pt-br", "en", "en", "es"]);
    expect(results[0].langName).toBe("Portuguese (Brazil)");
    expect(results[1].format).toBe("ass");
    expect(results[2].forced).toBe(true);
    expect(results[3].hearingImpaired).toBe(true);

    // Second identical search hits LRU cache without issuing new httpFetch calls
    const cached = await searchOnlineSubtitles({
      tmdbId: 1399,
      imdbId: "tt0944947",
      kind: "tv",
      season: 1,
      episode: 2,
      languages: ["pt-br", "en"],
      preferHearingImpaired: "avoid",
    });
    expect(cached).toHaveLength(4);
    expect(mockHttpFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back from sub.wyzie.io to sub.wyzie.ru on failure", async () => {
    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.io/")) {
        return { status: 503, url, body: "upstream down" };
      }
      if (url.startsWith("https://sub.wyzie.ru/search")) {
        return {
          status: 200,
          url,
          body: JSON.stringify([{ id: "ru1", url: "https://cdn.wyzie.example/fallback.srt", language: "en", format: "srt" }]),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const results = await searchOnlineSubtitles({ tmdbId: 550, languages: ["en"] });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("wyzie-ru1");
    expect(results[0].provider).toBe("wyzie");
  });

  it("queries OpenSubtitles v3 with videoHash/videoSize/filename and boosts hash-matched results", async () => {
    mockIsTauri.mockReturnValue(true);
    mockInvoke.mockResolvedValue("8e245d9679d31e12");

    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.")) {
        return { status: 200, url, body: "[]" };
      }
      if (url.startsWith("https://opensubtitles-v3.strem.io/subtitles/movie/tt0137523/")) {
        expect(url).toContain("videoHash=8e245d9679d31e12");
        expect(url).toContain("videoSize=12909756");
        expect(url).toContain("filename=Fight.Club.1999.mkv");
        return {
          status: 200,
          url,
          body: JSON.stringify({
            subtitles: [
              {
                id: "imdb-only",
                url: "https://os.example/imdb.srt",
                lang: "eng",
                m: "i",
                subtitleFileName: "Fight.Club.Random.srt",
              },
              {
                id: "hash-hit",
                url: "https://os.example/hash.srt",
                lang: "eng",
                m: "h",
                subtitleFileName: "Fight.Club.ExactHash.srt",
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const results = await searchOnlineSubtitles({
      imdbId: "tt0137523",
      kind: "movie",
      localPath: "D:/Movies/Fight.Club.1999.mkv",
      fileSize: 12909756,
      languages: ["en"],
    });

    expect(mockInvoke).toHaveBeenCalledWith("compute_oshash", { path: "D:/Movies/Fight.Club.1999.mkv" });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("os-hash-hit");
    expect(results[0].hashMatched).toBe(true);
    expect(results[0].release).toBe("Fight.Club.ExactHash.srt");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("queries SubDL when subdlApiKey is supplied and resolves unpacked or zip URLs", async () => {
    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.")) return { status: 200, url, body: "[]" };
      if (url.startsWith("https://opensubtitles-v3.strem.io/")) return { status: 200, url, body: JSON.stringify({ subtitles: [] }) };
      if (url.startsWith("https://api.subdl.com/api/v1/subtitles")) {
        expect(url).toContain("api_key=test-subdl-key");
        expect(url).toContain("imdb_id=tt0944947");
        expect(url).toContain("season_number=1");
        expect(url).toContain("episode_number=3");
        return {
          status: 200,
          url,
          body: JSON.stringify({
            status: true,
            subtitles: [
              {
                subtitle_id: 3213944,
                language: "EN",
                release_name: "Show.S01E03.1080p.BluRay",
                url: "/subtitle/3197651-3213944.zip",
                fmt: "srt",
                hi: false,
                download_count: 2500,
              },
              {
                subtitle_id: 3213945,
                language: "FR",
                release_name: "Show.Season1.Pack",
                url: "/subtitle/3197651-3213945.zip",
                unpack_files: [
                  { name: "Show.S01E02.fr.srt", season: 1, episode: 2, format: "srt", url: "https://dl.subdl.com/subtitle/1/2" },
                  { name: "Show.S01E03.fr.ass", season: 1, episode: 3, format: "ass", url: "https://dl.subdl.com/subtitle/1/3" },
                ],
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const results = await searchOnlineSubtitles({
      imdbId: "tt0944947",
      kind: "tv",
      season: 1,
      episode: 3,
      languages: ["en"],
      subdlApiKey: "test-subdl-key",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "subdl-3213944",
      provider: "subdl",
      lang: "en",
      url: "https://dl.subdl.com/subtitle/3197651-3213944.zip",
      downloads: 2500,
    });
    expect(results[1]).toMatchObject({
      id: "subdl-3213945",
      provider: "subdl",
      lang: "fr",
      format: "ass",
      release: "Show.S01E03.fr.ass",
      url: "https://dl.subdl.com/subtitle/1/3",
    });
  });

  it("queries OpenSubtitles movie endpoint for anime movies and survives partial failures", async () => {
    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.")) {
        return { status: 503, url, body: "not json" };
      }
      if (url === "https://opensubtitles-v3.strem.io/subtitles/movie/tt0245429.json") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            subtitles: [
              { id: "1", url: "https://os.example/en.vtt", lang: "eng", SubFileName: "Spirited.Away.vtt" },
              { id: "2", url: "javascript:alert(1)", lang: "eng", SubFileName: "Bad" },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const results = await searchOnlineSubtitles({
      imdbId: "tt0245429",
      kind: "anime",
      languages: ["en"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://os.example/en.vtt");
    expect(results[0].format).toBe("vtt");
  });

  it("never throws on malformed JSON or total failure and does not cache failed searches", async () => {
    mockHttpFetch.mockRejectedValueOnce(new Error("network down"));
    mockHttpFetch.mockRejectedValueOnce(new Error("wyzie fallback down"));
    mockHttpFetch.mockResolvedValueOnce({ status: 200, url: "x", body: "{broken json" });

    const first = await searchOnlineSubtitles({ tmdbId: 550, imdbId: "tt0137523" });
    expect(first).toEqual([]);

    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://sub.wyzie.io/search?id=550",
      body: JSON.stringify([{ id: "1", url: "https://cdn.example/fc.srt", language: "en", format: "srt" }]),
    });

    const retry = await searchOnlineSubtitles({ tmdbId: 550, imdbId: "tt0137523" });
    expect(retry).toHaveLength(1);
  });

  it("respects AbortSignal before and during search", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const res1 = await searchOnlineSubtitles({ tmdbId: 10 }, preAborted.signal);
    expect(res1).toEqual([]);
    expect(mockHttpFetch).not.toHaveBeenCalled();

    const ctl = new AbortController();
    mockHttpFetch.mockImplementation(() => new Promise(() => {}));
    const pending = searchOnlineSubtitles({ tmdbId: 11 }, ctl.signal);
    ctl.abort();
    const res2 = await pending;
    expect(res2).toEqual([]);
  });
});

describe("fetchAndParseSubtitle", () => {
  it("fetches remote HTTPS subtitles via httpFetchBytes and parses them", async () => {
    const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i> world\n").buffer;
    mockHttpFetchBytes.mockResolvedValueOnce({
      status: 200,
      url: "https://sub.example/movie.srt",
      bytes,
    });

    const parsed = await fetchAndParseSubtitle("https://sub.example/movie.srt");
    expect(mockHttpFetchBytes).toHaveBeenCalledWith("https://sub.example/movie.srt", undefined, { signal: undefined });
    expect(mockHttpFetch).not.toHaveBeenCalled();
    expect(parsed.format).toBe("srt");
    expect(parsed.raw).toContain("<i>Hello</i> world");
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0].spans).toEqual([
      { text: "Hello", italic: true },
      { text: " world" },
    ]);
  });

  it("extracts and parses subtitle files from SubDL ZIP archives (store and deflate)", async () => {
    const srtContent = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nZip Store Sub\n");
    const zipStored = makeZipBuffer([
      { name: "__MACOSX/._movie.srt", content: new Uint8Array([0, 1]) },
      { name: "movie.srt", content: srtContent },
    ]);
    mockHttpFetchBytes.mockResolvedValueOnce({
      status: 200,
      url: "https://dl.subdl.com/subtitle/123.zip",
      bytes: zipStored,
    });
    const parsedStore = await fetchAndParseSubtitle("https://dl.subdl.com/subtitle/123.zip");
    expect(parsedStore.format).toBe("srt");
    expect(parsedStore.cues[0].text).toBe("Zip Store Sub");

    const assText = "[Script Info]\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Zip Deflate ASS";
    const assRaw = new TextEncoder().encode(assText);
    const compressed = new Uint8Array(
      await new Response(new Blob([assRaw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
    );
    const zipDeflated = makeZipBuffer([{ name: "movie.ass", content: assRaw, deflate: true }], [compressed]);
    mockHttpFetchBytes.mockResolvedValueOnce({
      status: 200,
      url: "https://dl.subdl.com/subtitle/456.zip",
      bytes: zipDeflated,
    });
    const parsedDeflate = await fetchAndParseSubtitle("https://dl.subdl.com/subtitle/456.zip");
    expect(parsedDeflate.format).toBe("ass");
    expect(parsedDeflate.cues[0].text).toBe("Zip Deflate ASS");
  });

  it("preserves raw Windows-1252 and UTF-16LE bytes through httpFetchBytes", async () => {
    // "1\n00:00:01,000 --> 00:00:02,000\ncafé" with Windows-1252 byte 0xe9
    const prefix = Array.from(new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\ncaf"));
    const win1252Bytes = Uint8Array.from([...prefix, 0xe9, 0x0a]).buffer;
    mockHttpFetchBytes.mockResolvedValueOnce({
      status: 200,
      url: "https://sub.example/fr.srt",
      bytes: win1252Bytes,
    });

    const parsed = await fetchAndParseSubtitle("https://sub.example/fr.srt");
    expect(parsed.cues[0].text).toBe("café");
    expect(parsed.raw).toContain("café");

    // UTF-16LE BOM + SRT text
    const src = "1\n00:00:01,000 --> 00:00:02,000\nUTF-16";
    const utf16 = new Uint8Array(2 + src.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < src.length; i++) {
      utf16[2 + i * 2] = src.charCodeAt(i);
      utf16[3 + i * 2] = 0;
    }
    mockHttpFetchBytes.mockResolvedValueOnce({
      status: 200,
      url: "https://sub.example/utf16.srt",
      bytes: utf16.buffer,
    });
    const parsed16 = await fetchAndParseSubtitle("https://sub.example/utf16.srt");
    expect(parsed16.cues[0].text).toBe("UTF-16");
  });

  it("fetches proxy/blob/local URLs via fetch and decodes legacy encodings", async () => {
    const assUrl = proxyUrl("https://cdn.example/subs/anime.ass", { referer: "https://embed.example/" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]).buffer, { status: 200 }),
    );
    const parsedWin1252 = await fetchAndParseSubtitle("blob:https://app.local/1234", { formatHint: "srt" });
    expect(fetchSpy).toHaveBeenCalled();
    expect(mockHttpFetchBytes).not.toHaveBeenCalled();
    expect(parsedWin1252.format).toBe("srt");

    const assBody = "[Script Info]\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Proxy ASS";
    fetchSpy.mockResolvedValueOnce(new Response(new TextEncoder().encode(assBody), { status: 200 }));
    const parsedProxy = await fetchAndParseSubtitle(assUrl);
    expect(parsedProxy.format).toBe("ass");
    expect(parsedProxy.cues[0].text).toBe("Proxy ASS");
  });

  it("rejects on HTTP error or aborted signal", async () => {
    mockHttpFetchBytes.mockResolvedValueOnce({ status: 404, url: "https://sub.example/404.srt", bytes: new ArrayBuffer(0) });
    await expect(fetchAndParseSubtitle("https://sub.example/404.srt")).rejects.toThrow("HTTP 404");

    const ctl = new AbortController();
    ctl.abort();
    await expect(fetchAndParseSubtitle("https://sub.example/a.srt", { signal: ctl.signal })).rejects.toThrow();
  });
});
