import { describe, expect, it } from "vitest";
import { watchedFrom } from "./scrobble";
import type { MediaDetail } from "./types";

const base = { overview: "", genres: [], cast: [], crew: [], related: [] } as unknown as MediaDetail;

describe("watchedFrom", () => {
  it("films carry their TMDB id", () => {
    const w = watchedFrom({ ...base, key: "tmdb:movie:603", kind: "movie", title: "The Matrix" } as MediaDetail, "tmdb:movie:603");
    expect(w.film).toBe(true);
    expect(w.tmdb).toEqual({ kind: "movie", id: 603 });
    expect(w.episode).toBeUndefined();
  });

  it("series episodes carry season and episode", () => {
    const w = watchedFrom({ ...base, key: "tmdb:tv:1399", kind: "tv", title: "GoT" } as MediaDetail, "tmdb:tv:1399", 2, 5);
    expect(w.tmdb).toEqual({ kind: "tv", id: 1399 });
    expect([w.season, w.episode]).toEqual([2, 5]);
    expect(w.anilistId).toBeUndefined();
  });

  it("a multi-cour anime season maps to the cour's own AniList entry and episode", () => {
    const d = {
      ...base,
      key: "anilist:100",
      kind: "anime",
      title: "Show",
      seasons: [
        {
          number: 2,
          name: "Season 2",
          episodeCount: 24,
          anilistId: 200,
          cours: [
            { key: "anilist:200", anilistId: 200, malId: 2000, title: "Part 1", startEpisode: 1, endEpisode: 12, episodeCount: 12 },
            { key: "anilist:201", malId: 2001, title: "Part 2", startEpisode: 13, endEpisode: 24, episodeCount: 12 },
          ],
        },
      ],
    } as unknown as MediaDetail;
    const w = watchedFrom(d, "anilist:100", 2, 15);
    expect(w.anilistId).toBe(201);
    expect(w.malId).toBe(2001);
    expect(w.entryEpisode).toBe(3);
    expect(w.entryEpisodes).toBe(12);
  });

  it("an anime with no season data uses its own entry", () => {
    const w = watchedFrom({ ...base, key: "anilist:21", kind: "anime", title: "One Piece", malId: 21 } as unknown as MediaDetail, "anilist:21", undefined, 7);
    expect(w.anilistId).toBe(21);
    expect(w.entryEpisode).toBe(7);
  });
});
