import { describe, expect, it } from "vitest";
import { computeActivityStats } from "./activityStats";
import type { ProgressEntry } from "./progress";

const makeEntry = (over: Partial<ProgressEntry>): ProgressEntry => ({
  media: {
    key: "tmdb:movie:603",
    kind: "movie",
    title: "The Matrix",
    overview: "",
    genres: ["Sci-Fi", "Action"],
  },
  position: 0,
  duration: 0,
  updatedAt: 1000,
  ...over,
});

describe("computeActivityStats", () => {
  it("sums per-episode durations without double-counting and counts legacy v1 rows", () => {
    const entries: ProgressEntry[] = [
      // Film finished (legacy v1 without episodes map) -> 7200s (2.0h)
      makeEntry({
        finished: true,
        position: 7100,
        duration: 7200,
        updatedAt: 5000,
      }),
      // Series v2 with 2 completed episodes (1800s each) + 1 in-progress episode (600s) -> 4200s
      makeEntry({
        media: {
          key: "tmdb:tv:95396",
          kind: "tv",
          title: "Severance",
          overview: "",
          genres: ["Drama", "Sci-Fi"],
        },
        season: 1,
        episode: 3,
        position: 600,
        duration: 2700,
        updatedAt: 6000,
        episodes: {
          "s1:e1": { season: 1, episode: 1, position: 1750, duration: 1800, completed: true, updatedAt: 100 },
          "s1:e2": { season: 1, episode: 2, position: 1790, duration: 1800, completed: true, updatedAt: 200 },
          "s1:e3": { season: 1, episode: 3, position: 600, duration: 2700, completed: false, updatedAt: 300 },
        },
      }),
      // Caught-up anime -> 1440s, counts toward caughtUpShows & completedEpisodes
      makeEntry({
        media: {
          key: "anilist:154587",
          kind: "anime",
          title: "Frieren",
          overview: "",
          genres: ["Fantasy", "Adventure"],
        },
        caughtUp: true,
        season: 1,
        episode: 28,
        position: 1400,
        duration: 1440,
        updatedAt: 7000,
        episodes: {
          "s1:e28": { season: 1, episode: 28, position: 1400, duration: 1440, completed: true, updatedAt: 7000 },
        },
      }),
      // Accidental 5s click should be ignored
      makeEntry({
        media: { key: "tmdb:movie:999", kind: "movie", title: "Skipped", overview: "", genres: ["Horror"] },
        position: 5,
        duration: 5400,
        updatedAt: 8000,
      }),
    ];

    const stats = computeActivityStats(entries, 12);
    expect(stats.totalSeconds).toBe(7200 + 4200 + 1440);
    expect(stats.totalHours).toBe(3.6); // 12840 / 3600 = 3.5666...
    expect(stats.finishedFilms).toBe(1);
    expect(stats.completedEpisodes).toBe(3);
    expect(stats.activeShows).toBe(1);
    expect(stats.caughtUpShows).toBe(1);
    expect(stats.watchlistCount).toBe(12);
    expect(stats.history.map((h) => h.media.key)).toEqual([
      "anilist:154587",
      "tmdb:tv:95396",
      "tmdb:movie:603",
    ]);
    expect(stats.topGenres[0].genre).toBe("Sci-Fi");
  });
});
