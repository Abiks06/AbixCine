import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSkipSegmentsCache,
  fetchSkipSegments,
  mergeSkipRanges,
} from "./skipSegments";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  clearSkipSegmentsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mergeSkipRanges", () => {
  it("keeps existing candidate ranges and fills only missing ones", () => {
    expect(
      mergeSkipRanges(
        { intro: [10, 90] },
        { intro: [5, 80], outro: [1300, 1420], source: "aniskip" },
      ),
    ).toEqual({ intro: [10, 90], outro: [1300, 1420] });

    expect(
      mergeSkipRanges(
        { intro: [10, 90], outro: [1200, 1300] },
        { intro: [1, 2], outro: [2, 3], source: "theintrodb" },
      ),
    ).toEqual({ intro: [10, 90], outro: [1200, 1300] });
  });

  it("ignores invalid existing ranges and falls back to fetched ones", () => {
    expect(
      mergeSkipRanges(
        { intro: [90, 90], outro: [-5, 10] },
        { intro: [12, 85], outro: [1300, Number.POSITIVE_INFINITY] },
      ),
    ).toEqual({ intro: [12, 85], outro: [1300, Number.POSITIVE_INFINITY] });
  });

  it("returns undefined when neither side has valid segments", () => {
    expect(mergeSkipRanges(undefined, {})).toBeUndefined();
  });
});

describe("fetchSkipSegments - TheIntroDB v4", () => {
  it("queries movie endpoints by tmdb_id without season/episode and maps null bounds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        tvdb_id: 169,
        type: "movie",
        intro: [{ start_ms: null, end_ms: 23000 }],
        credits: [{ start_ms: 5801000, end_ms: null }],
        recap: [{ start_ms: 25000, end_ms: 134000 }],
        preview: [{ start_ms: 1680000, end_ms: 1740000 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchSkipSegments({
      kind: "movie",
      tmdbId: 603,
      imdbId: "tt0133093",
      durationSec: 6000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe("https://api.theintrodb.org/v4/media");
    expect(calledUrl.searchParams.get("tmdb_id")).toBe("603");
    expect(calledUrl.searchParams.get("imdb_id")).toBeNull();
    expect(calledUrl.searchParams.get("season")).toBeNull();
    expect(calledUrl.searchParams.get("episode")).toBeNull();
    expect(calledUrl.searchParams.get("duration_ms")).toBe("6000000");

    expect(res).toEqual({
      intro: [0, 23],
      outro: [5801, Number.POSITIVE_INFINITY],
      recap: [25, 134],
      preview: [1680, 1740],
      source: "theintrodb",
    });
  });

  it("queries TV episodes using imdb_id fallback and season=0 specials", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        tvdb_id: 71663,
        type: "tv",
        season: 0,
        episode: 1,
        intro: [{ start_ms: 15000, end_ms: 45000 }],
        credits: [{ start_ms: 1320000, end_ms: 1410000 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchSkipSegments({
      kind: "tv",
      imdbId: "TT0096697",
      season: 0,
      episode: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("imdb_id")).toBe("tt0096697");
    expect(calledUrl.searchParams.get("season")).toBe("0");
    expect(calledUrl.searchParams.get("episode")).toBe("1");
    expect(res).toEqual({
      intro: [15, 45],
      outro: [1320, 1410],
      source: "theintrodb",
    });
  });

  it("does not query TheIntroDB for TV without both season and episode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchSkipSegments({
      kind: "tv",
      tmdbId: 1399,
      episode: 1,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({});
  });

  it("ignores open-ended intro segments while allowing open-ended credits", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        tvdb_id: 100,
        intro: [{ start_ms: 1000, end_ms: null }],
        credits: [{ start_ms: 1200000, end_ms: null }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchSkipSegments({ kind: "movie", tvdbId: 100 });
    expect(res).toEqual({
      outro: [1200, Number.POSITIVE_INFINITY],
      source: "theintrodb",
    });
  });
});

describe("fetchSkipSegments - AniSkip v2", () => {
  it("queries AniSkip for anime with malId and episode and maps op/ed/recap", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        found: true,
        results: [
          { skipType: "recap", interval: { startTime: 0, endTime: 40 } },
          { skipType: "op", interval: { startTime: 57.4, endTime: 145.7 } },
          { skipType: "ed", interval: { startTime: 1357.9, endTime: 1480 } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchSkipSegments({
      kind: "anime",
      malId: 1,
      episode: 1,
      durationSec: 1491.5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe("https://api.aniskip.com/v2/skip-times/1/1");
    expect(calledUrl.searchParams.getAll("types[]")).toEqual(["op", "ed", "recap"]);
    expect(calledUrl.searchParams.get("episodeLength")).toBe("1492");

    expect(res).toEqual({
      intro: [57.4, 145.7],
      outro: [1357.9, 1480],
      recap: [0, 40],
      source: "aniskip",
    });
  });

  it("falls back to TheIntroDB when AniSkip misses or only returns partial segments", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.aniskip.com")) {
        return jsonResponse({
          found: true,
          results: [{ skipType: "op", interval: { startTime: 85, endTime: 175 } }],
        });
      }
      return jsonResponse({
        tvdb_id: 999,
        credits: [{ start_ms: 1300000, end_ms: 1390000 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchSkipSegments({
      kind: "anime",
      malId: 154587,
      tmdbId: 209867,
      season: 1,
      episode: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).toEqual({
      intro: [85, 175],
      outro: [1300, 1390],
      source: "mixed",
    });
  });
});

describe("fetchSkipSegments - caching, errors, timeout, and abort", () => {
  it("caches 200 and 404 results, but does not cache transient 500 errors", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: "upstream" }, 500);
      if (calls === 2) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ intro: [{ start_ms: 1000, end_ms: 5000 }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    // 1st call: 500 -> returns {}, not cached
    expect(await fetchSkipSegments({ kind: "movie", tmdbId: 550 })).toEqual({});
    // 2nd call: 404 -> returns {}, cached
    expect(await fetchSkipSegments({ kind: "movie", tmdbId: 550 })).toEqual({});
    // 3rd call: hits cache -> still 2 total fetches
    expect(await fetchSkipSegments({ kind: "movie", tmdbId: 550 })).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Different ID fetches fresh
    expect(await fetchSkipSegments({ kind: "movie", tmdbId: 551 })).toEqual({
      intro: [1, 5],
      source: "theintrodb",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts cleanly when AbortSignal fires and rejects with AbortError", async () => {
    const ctl = new AbortController();
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchSkipSegments({ kind: "movie", tmdbId: 123 }, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns {} on timeout without throwing", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchSkipSegments({ kind: "movie", tmdbId: 456 }, { timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toEqual({});
  });
});
