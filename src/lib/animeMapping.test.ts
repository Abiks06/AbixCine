import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANIBRIDGE_MAPPINGS_URL,
  clearAnimeMappingCache,
  compactAnibridgeMappings,
  compactFribbEntries,
  FRIBB_MINI_URL,
  loadAnimeMappings,
  mapEpisodeByAnibridgeRanges,
  resolveAnimeIds,
  resolveAnimeIdsSync,
  resolveCourEpisodeMapping,
  seedAnimeMappings,
  type RawAnibridgeMappings,
  type RawFribbEntry,
} from "./animeMapping";
import { animeDirectProvider, malIdFor } from "../sources/anime-direct";
import { getSettings } from "./settings";

const SAMPLE_FRIBB: RawFribbEntry[] = [
  {
    type: "MOVIE",
    anilist_id: 164,
    mal_id: 164,
    imdb_id: ["tt0119698"],
    themoviedb_id: { movie: [128] },
  },
  {
    type: "TV",
    anilist_id: 140960,
    mal_id: 50265,
    imdb_id: ["tt13706018"],
    themoviedb_id: { tv: 120089 },
    season: { tmdb: 1, tvdb: 1 },
  },
  {
    type: "TV",
    anilist_id: 142838,
    mal_id: 50602,
    imdb_id: ["tt13706018"],
    themoviedb_id: { tv: 120089 },
    season: { tmdb: 1, tvdb: 1 },
    episode_offset: { tmdb: 12, tvdb: 12 },
  },
  {
    type: "TV",
    anilist_id: 158927,
    mal_id: 53887,
    imdb_id: ["tt13706018"],
    themoviedb_id: { tv: 120089 },
    season: { tmdb: 2, tvdb: 2 },
  },
  {
    type: "TV",
    anilist_id: 154587,
    mal_id: 52991,
    imdb_id: ["tt22248376"],
    themoviedb_id: { tv: 209867 },
    season: { tmdb: 1, tvdb: 1 },
  },
  {
    type: "TV",
    anilist_id: 182255,
    mal_id: 59978,
    imdb_id: ["tt22248376"],
    themoviedb_id: { tv: 209867 },
    season: { tmdb: 1, tvdb: 2 },
    episode_offset: { tmdb: 28 },
  },
];

const SAMPLE_ANIBRIDGE: RawAnibridgeMappings = {
  $meta: { schema_version: "3.0.3" },
  "tmdb_show:120089:s1": {
    "anilist:140960": { "1-12": "1-12" },
    "mal:50265": { "1-12": "1-12" },
    "anilist:142838": { "13-25": "1-13" },
    "mal:50602": { "13-25": "1-13" },
    "tvdb_show:405920:s1": { "1-25": "1-25" },
  },
  "tmdb_show:209867:s1": {
    "anilist:154587": { "1-28": "1-28" },
    "mal:52991": { "1-28": "1-28" },
    "anilist:182255": { "29-": "1-" },
    "mal:59978": { "29-": "1-" },
  },
  "tmdb_movie:128": {
    "anilist:164": {},
    "mal:164": {},
    "imdb_movie:tt0119698": {},
  },
  "anidb:1:R": {
    "tvdb_show:72025:s1": { "1-13": "1-13" },
  },
};

beforeEach(() => {
  clearAnimeMappingCache();
  localStorage.clear();
});

afterEach(() => {
  clearAnimeMappingCache();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("animeMapping compaction and Anibridge range parser", () => {
  it("compacts Fribb entries and filters Anibridge to relevant providers", () => {
    const fribbRows = compactFribbEntries(SAMPLE_FRIBB);
    expect(fribbRows).toHaveLength(6);
    expect(fribbRows[0]).toEqual([164, 164, -128, -1, 0, "tt0119698"]);
    expect(fribbRows[2]).toEqual([142838, 50602, 120089, 1, 12, "tt13706018"]);

    const compactAb = compactAnibridgeMappings(SAMPLE_ANIBRIDGE);
    expect(compactAb["$meta"]).toBeUndefined();
    expect(compactAb["anidb:1:R"]).toBeUndefined();
    expect(compactAb["tmdb_show:120089:s1"]["tvdb_show:405920:s1"]).toBeUndefined();
    expect(compactAb["tmdb_show:120089:s1"]["anilist:142838"]).toEqual({ "13-25": "1-13" });
  });

  it("maps contiguous, open-ended, non-contiguous, ratio, empty, and unmapped ranges", () => {
    expect(mapEpisodeByAnibridgeRanges({}, 4)).toBe(4);
    expect(mapEpisodeByAnibridgeRanges({ "13-25": "1-13" }, 15)).toBe(3);
    expect(mapEpisodeByAnibridgeRanges({ "13-25": "1-13" }, 12)).toBeNull();
    expect(mapEpisodeByAnibridgeRanges({ "29-": "1-" }, 30)).toBe(2);
    expect(mapEpisodeByAnibridgeRanges({ "1-5": "1-2,4-6" }, 3)).toBe(4);
    expect(mapEpisodeByAnibridgeRanges({ "1-5": "1-2,4-6" }, 4)).toBe(5);
    expect(mapEpisodeByAnibridgeRanges({ "1-4": "1-8|2" }, 3)).toBe(5);
    expect(mapEpisodeByAnibridgeRanges({ "1-4": "1-2|-2" }, 3)).toBe(2);
    expect(mapEpisodeByAnibridgeRanges({ "1-3": null, "4-6": "1-3" }, 2)).toBeNull();
    expect(mapEpisodeByAnibridgeRanges({ "1-3": null, "4-6": "1-3" }, 5)).toBe(2);
  });
});

describe("animeMapping ID resolution, caching, and offline fallback", () => {
  it("resolves 1:1 TMDB TV & Movie -> MAL/AniList/IMDB and bidirectional lookups", async () => {
    seedAnimeMappings({ fribb: SAMPLE_FRIBB, anibridge: SAMPLE_ANIBRIDGE });

    const tv = await resolveAnimeIds({ key: "tmdb:tv:209867", kind: "anime", season: 1, episode: 5 });
    expect(tv).toMatchObject({ malId: 52991, anilistId: 154587, tmdbId: 209867, tmdbKind: "tv", courEpisode: 5 });

    const movie = await resolveAnimeIds({ key: "tmdb:movie:128", kind: "movie" });
    expect(movie).toMatchObject({ malId: 164, anilistId: 164, tmdbId: 128, tmdbKind: "movie", imdbId: "tt0119698" });

    const byAl = resolveAnimeIdsSync({ anilistId: 158927 });
    expect(byAl).toMatchObject({ malId: 53887, tmdbId: 120089, tmdbKind: "tv", tmdbSeason: 2, imdbId: "tt13706018" });

    const byMal = resolveAnimeIdsSync({ malId: 50602 });
    expect(byMal).toMatchObject({ anilistId: 142838, tmdbId: 120089, imdbId: "tt13706018" });

    const byImdb = resolveAnimeIdsSync({ imdbId: "tt22248376", season: 1, episode: 29 });
    expect(byImdb).toMatchObject({ anilistId: 182255, malId: 59978, tmdbId: 209867, courEpisode: 1 });
  });

  it("resolves split-cour TMDB season/episode mappings accurately via Anibridge and Fribb", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));

    // Anibridge only
    seedAnimeMappings({ anibridge: SAMPLE_ANIBRIDGE });
    const abCour1 = await resolveCourEpisodeMapping({ tmdbId: 120089, season: 1, episode: 12 });
    expect(abCour1).toMatchObject({ malId: 50265, anilistId: 140960, courEpisode: 12 });

    const abCour2 = await resolveCourEpisodeMapping({ tmdbId: 120089, season: 1, episode: 15 });
    expect(abCour2).toMatchObject({ malId: 50602, anilistId: 142838, courEpisode: 3 });

    const abFrierenS2 = await resolveCourEpisodeMapping({ tmdbId: 209867, season: 1, episode: 30 });
    expect(abFrierenS2).toMatchObject({ malId: 59978, anilistId: 182255, courEpisode: 2 });

    // Fribb only (when Anibridge unavailable)
    clearAnimeMappingCache();
    seedAnimeMappings({ fribb: SAMPLE_FRIBB });
    const frCour2 = await resolveCourEpisodeMapping({ tmdbId: 120089, season: 1, episode: 15 });
    expect(frCour2).toMatchObject({ malId: 50602, anilistId: 142838, courEpisode: 3, source: "fribb" });

    const frFrierenS2 = await resolveCourEpisodeMapping({ tmdbId: 209867, season: 1, episode: 30 });
    expect(frFrierenS2).toMatchObject({ malId: 59978, anilistId: 182255, courEpisode: 2, source: "fribb" });
  });

  it("fetches, compacts into localStorage with TTL, and reuses cached data without refetching", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === FRIBB_MINI_URL) return new Response(JSON.stringify(SAMPLE_FRIBB), { status: 200 });
      if (url === ANIBRIDGE_MAPPINGS_URL) return new Response(JSON.stringify(SAMPLE_ANIBRIDGE), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveAnimeIds({ key: "tmdb:tv:120089", kind: "anime", season: 1, episode: 15 });
    expect(first).toMatchObject({ malId: 50602, anilistId: 142838, courEpisode: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Clear in-memory index only, keeping localStorage intact, and verify zero network calls on reload
    fetchMock.mockClear();
    const rawFribb = localStorage.getItem("abx.animeMapping.fribb.v1");
    const rawAb = localStorage.getItem("abx.animeMapping.anibridge.v1");
    expect(rawFribb).toBeTruthy();
    expect(rawAb).toBeTruthy();

    // Simulate fresh session by clearing in-memory cache while preserving localStorage
    clearAnimeMappingCache();
    localStorage.setItem("abx.animeMapping.fribb.v1", rawFribb!);
    localStorage.setItem("abx.animeMapping.anibridge.v1", rawAb!);

    const second = await resolveAnimeIds({ key: "tmdb:tv:120089", kind: "anime", season: 1, episode: 15 });
    expect(second).toMatchObject({ malId: 50602, anilistId: 142838, courEpisode: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back gracefully without throwing when offline, fetch fails, or localStorage quota throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    // Offline / network error
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network offline");
      }),
    );

    const offlineRes = await resolveAnimeIds({ key: "tmdb:tv:120089", kind: "anime", season: 1, episode: 15 });
    expect(offlineRes.malId).toBeUndefined();
    expect(offlineRes.anilistId).toBeUndefined();

    // Even when setItem throws quota errors, in-memory seeding/loading still resolves cleanly
    clearAnimeMappingCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === FRIBB_MINI_URL) return new Response(JSON.stringify(SAMPLE_FRIBB), { status: 200 });
        return new Response("down", { status: 503 });
      }),
    );
    const partialRes = await resolveAnimeIds({ key: "tmdb:tv:120089", kind: "anime", season: 1, episode: 15 });
    expect(partialRes).toMatchObject({ malId: 50602, anilistId: 142838, courEpisode: 3 });
  });

  it("respects AbortSignal without firing network requests when already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    ac.abort();

    const abortedIdx = await loadAnimeMappings(ac.signal);
    expect(abortedIdx.fribbByAnilist.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const abortedIds = await resolveAnimeIds({ key: "tmdb:tv:120089", kind: "anime" }, ac.signal);
    expect(abortedIds.malId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("malIdFor and animeDirectProvider mapping integration", () => {
  it("uses animeMapping before AniList GraphQL and falls back to AniList GraphQL only on miss", async () => {
    seedAnimeMappings({ fribb: SAMPLE_FRIBB, anibridge: SAMPLE_ANIBRIDGE });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { Page: { media: [{ idMal: 99999, format: "TV", seasonYear: 2024 }] } },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Hit via mapping -> zero GraphQL requests
    const mappedMal = await malIdFor({
      media: { key: "tmdb:tv:120089", kind: "anime", title: "SPY x FAMILY", overview: "", genres: [] },
      season: 1,
      episode: 15,
    });
    expect(mappedMal).toBe(50602);
    expect(fetchMock).not.toHaveBeenCalled();

    // Miss -> falls back to AniList GraphQL search
    const fallbackMal = await malIdFor({
      media: { key: "tmdb:tv:9999999", kind: "anime", title: "Unmapped Show", overview: "", genres: [], year: 2024 },
      season: 1,
      episode: 1,
    });
    expect(fallbackMal).toBe(99999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null cleanly in animeDirectProvider when offline/aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const out = await animeDirectProvider.find(
      {
        media: { key: "tmdb:tv:120089", kind: "anime", title: "SPY x FAMILY", overview: "", genres: [] },
        season: 1,
        episode: 15,
      },
      getSettings(),
      new AbortController().signal,
    );
    expect(out).toEqual([]);
  });
});
