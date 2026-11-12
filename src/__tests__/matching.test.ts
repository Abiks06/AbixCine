import { describe, expect, it } from "vitest";
import { episodeMatches, parseEpisode, titleMatches } from "../sources/local";
import { parseName } from "../lib/library";
import {
  clampEpisode,
  clampSeason,
  normalizeTmdbSeasons,
  parseSeasonEpisodeParams,
  reconcileAnimeSeasons,
  resolveNextEpisode,
  resolvePlaybackRequest,
  stitchCourEpisodes,
  type RawAnilistNode,
} from "../lib/normalizer";
import { isDone } from "../lib/progress";
import type { Episode, Media, MediaDetail } from "../lib/types";

const media = (title: string, year?: number): Media => ({ key: "x", kind: "movie", title, overview: "", genres: [], year });

describe("parseEpisode", () => {
  it.each([
    ["Show.S01E02.1080p.mkv", { season: 1, episode: 2 }],
    ["Show S01E01E02.mkv", { season: 1, episode: 1, last: 2 }],
    ["Show.S01E01-E03.mkv", { season: 1, episode: 1, last: 3 }],
    ["Show 2x03.mkv", { season: 2, episode: 3 }],
    ["[SubsPlease] Frieren - 02 (1080p) [ABCD].mkv", { episode: 2 }],
    ["Show_-_02_[720p].mkv", { episode: 2 }],
    ["Show Ep 12.mp4", { episode: 12 }],
  ])("%s", (name, want) => expect(parseEpisode(name)).toEqual(want));

  it("reads the season from a Season folder for bare numbers", () => {
    expect(parseEpisode("01.mkv", "D:/TV/Show/Season 2/01.mkv")).toEqual({ season: 2, episode: 1 });
    expect(parseEpisode("01.mkv")).toEqual({ episode: 1 });
  });

  it.each(["Stargate.1994.1080p.mkv", "Mortal Engine 2018.mkv", "Code 8 (2019).mkv", "Movie.1080p.x264.mkv", "1917.mkv"])(
    "does not treat the film %s as an episode",
    (name) => expect(parseEpisode(name).episode).toBeUndefined(),
  );
});

describe("titleMatches", () => {
  it("needs whole words", () => {
    expect(titleMatches("Upgrade (2018).mkv", { media: media("Up") })).toBe(false);
    expect(titleMatches("D:/Backup/Movies/x.mkv", { media: media("Up") })).toBe(false);
    expect(titleMatches("Kitchen Nightmares S01E01", { media: media("It") })).toBe(false);
    expect(titleMatches("Up (2009) 1080p.mkv", { media: media("Up") })).toBe(true);
    expect(titleMatches("Frieren.Beyond.Journeys.End.S01E01.mkv", { media: media("Frieren: Beyond Journey’s End") })).toBe(true);
  });
});

describe("episodeMatches", () => {
  it("matches the right season only", () => {
    expect(episodeMatches({ season: 1, episode: 1 }, { season: 2, episode: 1 })).toBe(false);
    expect(episodeMatches({ season: 2, episode: 1 }, { season: 2, episode: 1 })).toBe(true);
  });
  it("covers multi-episode files", () => {
    expect(episodeMatches({ season: 1, episode: 1, last: 2 }, { season: 1, episode: 2 })).toBe(true);
  });
  it("maps absolute anime numbering", () => {
    expect(episodeMatches({ episode: 26 }, { season: 2, episode: 1, absolute: 26 })).toBe(true);
    expect(episodeMatches({ episode: 1 }, { season: 2, episode: 1, absolute: 26 })).toBe(false);
    expect(episodeMatches({ episode: 3 }, { season: 1, episode: 3 })).toBe(true);
  });
});

describe("parseName", () => {
  it("takes the last year", () => expect(parseName("Blade Runner 2049 (2017).mkv")).toEqual({ title: "Blade Runner 2049", year: 2017 }));
  it("strips NxNN tags", () => expect(parseName("Show 2x03.mkv").title).toBe("Show"));
  it("keeps a title that is a year", () => expect(parseName("1917.mkv").title).toBe("1917"));
});

describe("isDone", () => {
  it("films need 95%", () => {
    expect(isDone(6800, 7200)).toBe(false);
    expect(isDone(6900, 7200)).toBe(true);
  });
  it("episodes are done at the credits", () => expect(isDone(1340, 1440)).toBe(true));
});

describe("scanner stems (no extension)", () => {
  it("keeps the year on a stem", () => expect(parseName("Dune.2021.2160p")).toEqual({ title: "Dune", year: 2021 }));
  it("parses episode stems", () => expect(parseEpisode("Show.S01E02.x264")).toEqual({ season: 1, episode: 2 }));
});

describe("deterministic season reconciliation & canonical normalizer", () => {
  it("separates ONA shorts and TBA/unaired entries so a 2-season anime like Frieren shows 2 seasons instead of 3+", () => {
    const nodes: RawAnilistNode[] = [
      {
        id: 154587,
        idMal: 52991,
        format: "TV",
        status: "FINISHED",
        episodes: 28,
        duration: 24,
        seasonYear: 2023,
        startDate: { year: 2023, month: 9, day: 29 },
        title: { english: "Frieren: Beyond Journey's End", romaji: "Sousou no Frieren" },
      },
      {
        id: 170068,
        idMal: 56885,
        format: "ONA",
        status: "FINISHED",
        episodes: 11,
        duration: 2,
        seasonYear: 2023,
        startDate: { year: 2023, month: 10, day: 11 },
        title: { english: "Frieren: Beyond Journey's End Mini Anime", romaji: "Sousou no Frieren: ●● no Mahou" },
      },
      {
        id: 182255,
        idMal: 59978,
        format: "TV",
        status: "FINISHED",
        episodes: 24,
        duration: 24,
        seasonYear: 2026,
        startDate: { year: 2026, month: 1, day: 16 },
        title: { english: "Frieren: Beyond Journey's End Season 2", romaji: "Sousou no Frieren 2nd Season" },
      },
      {
        id: 199999,
        idMal: 65000,
        format: "TV",
        status: "NOT_YET_RELEASED",
        episodes: null,
        duration: null,
        seasonYear: 2028,
        startDate: { year: 2028, month: null, day: null },
        title: { english: "Frieren: Beyond Journey's End Season 3", romaji: "Sousou no Frieren 3rd Season" },
      },
    ];

    const res = reconcileAnimeSeasons(nodes, "anilist:182255");
    expect(res.seasons).toHaveLength(2);
    expect(res.seasons.map((s) => ({ number: s.number, episodeCount: s.episodeCount, key: s.key }))).toEqual([
      { number: 1, episodeCount: 28, key: "anilist:154587" },
      { number: 2, episodeCount: 24, key: "anilist:182255" },
    ]);
    expect(res.specials).toHaveLength(1);
    expect(res.specials[0]).toMatchObject({ number: 0, name: "Specials", episodeCount: 11 });
    expect(res.upcomingSeasons).toHaveLength(1);
    expect(res.upcomingSeasons[0]).toMatchObject({ number: 3, episodeCount: 0, status: "upcoming" });
    expect(res.initialSeason).toBe(2);
  });

  it("folds split cours/parts into a single canonical season and maps cour-relative playback accurately", () => {
    const nodes: RawAnilistNode[] = [
      {
        id: 140960,
        idMal: 50265,
        format: "TV",
        status: "FINISHED",
        episodes: 12,
        duration: 24,
        seasonYear: 2022,
        startDate: { year: 2022, month: 4, day: 9 },
        title: { english: "SPY x FAMILY", romaji: "SPY×FAMILY" },
      },
      {
        id: 142838,
        idMal: 50602,
        format: "TV",
        status: "FINISHED",
        episodes: 13,
        duration: 24,
        seasonYear: 2022,
        startDate: { year: 2022, month: 10, day: 1 },
        title: { english: "SPY x FAMILY Part 2", romaji: "SPY×FAMILY Part 2" },
      },
      {
        id: 158927,
        idMal: 53887,
        format: "TV",
        status: "FINISHED",
        episodes: 12,
        duration: 24,
        seasonYear: 2023,
        startDate: { year: 2023, month: 10, day: 7 },
        title: { english: "SPY x FAMILY Season 2", romaji: "SPY×FAMILY Season 2" },
      },
    ];

    const rec = reconcileAnimeSeasons(nodes, "anilist:140960");
    // 3 AniList entries reconcile into 2 official seasons (Season 1 = 25 eps across 2 cours, Season 2 = 12 eps)
    expect(rec.seasons).toHaveLength(2);
    expect(rec.seasons[0].episodeCount).toBe(25);
    expect(rec.seasons[0].cours).toHaveLength(2);
    expect(rec.seasons[0].cours?.[0]).toMatchObject({ key: "anilist:140960", startEpisode: 1, endEpisode: 12 });
    expect(rec.seasons[0].cours?.[1]).toMatchObject({ key: "anilist:142838", startEpisode: 13, endEpisode: 25 });
    expect(rec.seasons[1]).toMatchObject({ number: 2, episodeCount: 12, key: "anilist:158927" });

    // Stitch episodes across Cour 1 and Cour 2
    const stitched = stitchCourEpisodes(
      rec.seasons[0],
      new Map<string, Episode[]>([
        ["anilist:140960", [{ season: 1, number: 1, title: "Operation Strix" }]],
        ["anilist:142838", [{ season: 1, number: 1, title: "Project Apple" }]],
      ]),
      24,
    );
    expect(stitched).toHaveLength(25);
    expect(stitched[0]).toMatchObject({ number: 1, title: "Operation Strix", sourceKey: "anilist:140960", courEpisode: 1 });
    expect(stitched[12]).toMatchObject({ number: 13, title: "Project Apple", sourceKey: "anilist:142838", courEpisode: 1, malId: 50602 });

    // Resolve playback request for Season 1 Episode 15 -> maps to Cour 2 (anilist:142838, malId: 50602, courEpisode: 3)
    const detail: MediaDetail = {
      key: "anilist:140960",
      kind: "anime",
      title: "SPY x FAMILY",
      overview: "",
      genres: [],
      seasons: rec.seasons,
      cast: [],
      crew: [],
      related: [],
    };
    const req = resolvePlaybackRequest(detail, 1, 15, "sub");
    expect(req).toMatchObject({
      season: 1,
      episode: 15,
      courEpisode: 3,
      audio: "sub",
      media: {
        key: "anilist:142838",
        malId: 50602,
      },
    });
  });

  it("normalizes TMDB seasons by separating Season 0 Specials and 0-episode TBA seasons", () => {
    const tmdb = normalizeTmdbSeasons(
      [
        { season_number: 0, name: "Specials", episode_count: 6, air_date: "2023-10-01" },
        { season_number: 1, name: "Season 1", episode_count: 28, air_date: "2023-09-29" },
        { season_number: 2, name: "Season 2", episode_count: 24, air_date: "2026-01-16" },
        { season_number: 3, name: "Season 3", episode_count: 0, air_date: null },
      ],
      "tmdb:tv:209867",
      209867,
    );
    expect(tmdb.seasons.map((s) => s.number)).toEqual([1, 2]);
    expect(tmdb.specials).toHaveLength(1);
    expect(tmdb.specials[0]).toMatchObject({ number: 0, name: "Specials", episodeCount: 6 });
    expect(tmdb.upcomingSeasons).toHaveLength(1);
    expect(tmdb.upcomingSeasons[0]).toMatchObject({ number: 3, episodeCount: 0, status: "upcoming" });
  });

  it("clamps out-of-bounds season and episode parameters safely without crashing", () => {
    expect(parseSeasonEpisodeParams(new URLSearchParams("s=abc&e=-5"))).toEqual({ season: undefined, episode: undefined });
    expect(parseSeasonEpisodeParams(new URLSearchParams("s=0&e=3"))).toEqual({ season: 0, episode: 3 });

    const detail = {
      seasons: [
        { number: 1, name: "Season 1", episodeCount: 12 },
        { number: 2, name: "Season 2", episodeCount: 10 },
      ],
      specials: [{ number: 0, name: "Specials", episodeCount: 4 }],
      initialSeason: 1,
    };

    // Requesting nonexistent Season 3 clamps back to initialSeason (Season 1)
    expect(clampSeason(detail, 3)?.number).toBe(1);
    // Requesting Season 0 selects Specials when available
    expect(clampSeason(detail, 0)?.number).toBe(0);
    // Clamping episode 99 on a 10-episode season returns 10
    expect(clampEpisode(detail.seasons[1], 99)).toBe(10);
    expect(clampEpisode(detail.seasons[1], -3)).toBe(1);
  });

  it("maps cour-specific entry routes without season param and computes next episode across cour and season boundaries", () => {
    const nodes: RawAnilistNode[] = [
      { id: 100, idMal: 1000, title: { english: "Show Part 1" }, format: "TV", episodes: 12, seasonYear: 2023 },
      { id: 101, idMal: 1001, title: { english: "Show Part 2" }, format: "TV", episodes: 12, seasonYear: 2023 },
      { id: 102, idMal: 1002, title: { english: "Show Season 2" }, format: "TV", episodes: 10, seasonYear: 2024 },
    ];
    const reconciled = reconcileAnimeSeasons(nodes, "anilist:101");
    const detail: MediaDetail = {
      key: "anilist:101",
      canonicalKey: reconciled.canonicalKey,
      initialSeason: reconciled.initialSeason,
      kind: "anime",
      title: "Show",
      overview: "",
      genres: [],
      seasons: reconciled.seasons,
      specials: reconciled.specials,
      cast: [],
      crew: [],
      related: [],
    };

    // Navigating directly to /watch/anilist:101?e=2 (no season param) maps cour-relative ep 2 -> canonical S1E14
    const courDirect = resolvePlaybackRequest(detail, undefined, 2, "sub");
    expect(courDirect?.season).toBe(1);
    expect(courDirect?.episode).toBe(14);
    expect(courDirect?.courEpisode).toBe(2);
    expect(courDirect?.media.key).toBe("anilist:101");

    // End of Cour 1 (S1E12) steps into Cour 2 (S1E13, key: anilist:101, courEpisode: 1)
    const nextCour = resolveNextEpisode(detail, 1, 12, "sub");
    expect(nextCour?.s).toBe(1);
    expect(nextCour?.e).toBe(13);
    expect(nextCour?.key).toBe("anilist:101");
    expect(nextCour?.courEpisode).toBe(1);

    // End of Season 1 (S1E24) steps into Season 2 Episode 1 (S2E1, key: anilist:102, courEpisode: 1)
    const nextSeason = resolveNextEpisode(detail, 1, 24, "sub");
    expect(nextSeason?.s).toBe(2);
    expect(nextSeason?.e).toBe(1);
    expect(nextSeason?.key).toBe("anilist:102");
    expect(nextSeason?.courEpisode).toBe(1);

    // Final episode of final season returns null
    expect(resolveNextEpisode(detail, 2, 10, "sub")).toBeNull();
  });

  it("synchronizes audioFor and saveProgress across canonical and cour-specific keys", async () => {
    const { audioFor, setAudioFor } = await import("../lib/settings");
    const { saveProgress, getEntry, getProgress } = await import("../lib/progress");
    const { playTarget } = await import("../lib/play");

    setAudioFor("anilist:100", "dub", ["anilist:101"]);
    expect(audioFor("anilist:100")).toBe("dub");
    expect(audioFor("anilist:101", ["anilist:100"])).toBe("dub");

    saveProgress({
      media: {
        key: "anilist:101",
        canonicalKey: "anilist:100",
        kind: "anime",
        title: "Show Part 2",
        overview: "",
        genres: [],
        hue: 120,
      },
      season: 1,
      episode: 14,
      audio: "dub",
      position: 420,
      duration: 1440,
    });

    expect(getEntry("anilist:100")?.episode).toBe(14);
    expect(getProgress("anilist:100", 1, 14)?.position).toBe(420);
    expect(playTarget({ key: "anilist:101", canonicalKey: "anilist:100", kind: "anime" })).toEqual({
      s: 1,
      e: 14,
      a: "dub",
    });
  });
});

