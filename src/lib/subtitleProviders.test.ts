import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpFetch, proxyUrl } from "../sources/native";
import {
  clearSubtitleSearchCache,
  fetchAndParseSubtitle,
  normalizeLangCode,
  searchOnlineSubtitles,
} from "./subtitleProviders";

vi.mock("../sources/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/native")>();
  return {
    ...actual,
    httpFetch: vi.fn(),
  };
});

const mockHttpFetch = vi.mocked(httpFetch);

beforeEach(() => {
  clearSubtitleSearchCache();
  mockHttpFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("queries Wyzie and OpenSubtitles in parallel, ranks, and deduplicates results", async () => {
    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.ru/search")) {
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

  it("queries OpenSubtitles movie endpoint for anime movies and survives partial failures", async () => {
    mockHttpFetch.mockImplementation(async (url) => {
      if (url.startsWith("https://sub.wyzie.ru/")) {
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
    mockHttpFetch.mockResolvedValueOnce({ status: 200, url: "x", body: "{broken json" });

    const first = await searchOnlineSubtitles({ tmdbId: 550, imdbId: "tt0137523" });
    expect(first).toEqual([]);

    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://sub.wyzie.ru/search?id=550",
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
  it("fetches remote HTTPS subtitles via httpFetch and parses them", async () => {
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://sub.example/movie.srt",
      body: "1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i> world\n",
    });

    const parsed = await fetchAndParseSubtitle("https://sub.example/movie.srt");
    expect(mockHttpFetch).toHaveBeenCalledWith("https://sub.example/movie.srt", undefined);
    expect(parsed.format).toBe("srt");
    expect(parsed.raw).toContain("<i>Hello</i> world");
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0].spans).toEqual([
      { text: "Hello", italic: true },
      { text: " world" },
    ]);
  });

  it("fetches proxy/blob/local URLs via fetch and decodes legacy encodings", async () => {
    const assUrl = proxyUrl("https://cdn.example/subs/anime.ass", { referer: "https://embed.example/" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]).buffer, { status: 200 }),
    );
    const parsedWin1252 = await fetchAndParseSubtitle("blob:https://app.local/1234", { formatHint: "srt" });
    expect(fetchSpy).toHaveBeenCalled();
    expect(mockHttpFetch).not.toHaveBeenCalled();
    expect(parsedWin1252.format).toBe("srt");

    const assBody = "[Script Info]\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Proxy ASS";
    fetchSpy.mockResolvedValueOnce(new Response(new TextEncoder().encode(assBody), { status: 200 }));
    const parsedProxy = await fetchAndParseSubtitle(assUrl);
    expect(parsedProxy.format).toBe("ass");
    expect(parsedProxy.cues[0].text).toBe("Proxy ASS");
  });

  it("rejects on HTTP error or aborted signal", async () => {
    mockHttpFetch.mockResolvedValueOnce({ status: 404, url: "https://sub.example/404.srt", body: "" });
    await expect(fetchAndParseSubtitle("https://sub.example/404.srt")).rejects.toThrow("HTTP 404");

    const ctl = new AbortController();
    ctl.abort();
    await expect(fetchAndParseSubtitle("https://sub.example/a.srt", { signal: ctl.signal })).rejects.toThrow();
  });
});
