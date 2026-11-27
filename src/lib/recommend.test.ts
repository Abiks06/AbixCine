import { describe, expect, it } from "vitest";
import type { ProgressEntry } from "./progress";
import { buildRecommendations, buildTasteShelves, normalizeGenres } from "./recommend";
import type { Media } from "./types";

const NOW = Date.UTC(2026, 10, 20);
const DAY = 86_400_000;

function media(
  key: string,
  kind: Media["kind"],
  opts: Partial<Media> = {},
): Media {
  return {
    key,
    kind,
    title: opts.title ?? key,
    overview: "Overview",
    genres: opts.genres ?? ["Drama"],
    poster: "/poster.jpg",
    backdrop: "/back.jpg",
    rating: opts.rating ?? 7.8,
    year: opts.year ?? 2024,
    ...opts,
  };
}

function progressEntry(m: Media, daysAgo: number, extra: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    media: m,
    position: extra.finished ? 0 : 400,
    duration: 2400,
    updatedAt: NOW - daysAgo * DAY,
    ...extra,
  };
}

describe("buildRecommendations", () => {
  it("curates picks during cold start with zero watch history", () => {
    const f1 = media("f1", "movie", { genres: ["Sci-Fi"], rating: 8.6 });
    const s1 = media("s1", "tv", { genres: ["Thriller"], rating: 8.4 });
    const a1 = media("a1", "anime", { genres: ["Action"], rating: 8.3 });
    const res = buildRecommendations({
      progress: [],
      watchlist: [],
      seedRelated: [],
      catalogPools: [
        { label: "popular", items: [f1, s1] },
        { label: "airing", items: [a1] },
      ],
      lens: "all",
      mode: "for-you",
      now: NOW,
    });
    expect(res.hasSignals).toBe(false);
    expect(res.picks).toHaveLength(3);
    expect(res.picks.map((p) => p.media.key)).toEqual(expect.arrayContaining(["f1", "s1", "a1"]));
  });

  it("excludes finished and active Continue Watching titles and promotes My List + similar seeds", () => {
    const watched = media("watched", "movie", { genres: ["Sci-Fi", "Thriller"] });
    const active = media("active", "tv", { genres: ["Drama"] });
    const saved = media("saved", "movie", { genres: ["Sci-Fi"], rating: 8.1 });
    const related = media("rel", "movie", { genres: ["Sci-Fi", "Action"], rating: 8.4 });
    const unrelated = media("unrel", "movie", { genres: ["Comedy"], rating: 6.5 });

    const res = buildRecommendations({
      progress: [
        progressEntry(watched, 2, { finished: true }),
        progressEntry(active, 1, { position: 600 }),
      ],
      watchlist: [{ media: saved, addedAt: NOW - DAY }],
      seedRelated: [{ source: watched, items: [related, watched, active] }],
      catalogPools: [{ label: "popular", items: [unrelated, watched, active] }],
      lens: "all",
      mode: "for-you",
      now: NOW,
    });

    const keys = res.picks.map((p) => p.media.key);
    expect(keys).not.toContain("watched");
    expect(keys).not.toContain("active");
    expect(keys[0]).toBe("saved");
    expect(keys).toContain("rel");
    expect(res.topGenres[0]).toBe("Sci-Fi");
    expect(res.picks.find((p) => p.media.key === "rel")?.reason).toContain("Because you watched");
  });

  it("supports queue, surprise, lens filters, dismissed items, and shuffleOffset", () => {
    const scifi1 = media("sf1", "movie", { genres: ["Sci-Fi"], rating: 8.5 });
    const scifi2 = media("sf2", "movie", { genres: ["Sci-Fi"], rating: 8.2 });
    const mystery = media("mys", "tv", { genres: ["Mystery"], rating: 8.3 });
    const animeSaved = media("an1", "anime", { genres: ["Fantasy"], rating: 8.0 });

    const baseOpts = {
      progress: [progressEntry(media("seed", "movie", { genres: ["Sci-Fi"] }), 1, { finished: true })],
      watchlist: [{ media: animeSaved, addedAt: NOW }],
      seedRelated: [],
      catalogPools: [
        { label: "popular" as const, items: [scifi1, scifi2, mystery] },
        { label: "acclaimed" as const, items: [mystery, scifi1] },
      ],
      now: NOW,
    };

    const queueRes = buildRecommendations({ ...baseOpts, lens: "all", mode: "queue" });
    expect(queueRes.picks.map((p) => p.media.key)).toEqual(["an1"]);

    const surpriseRes = buildRecommendations({ ...baseOpts, lens: "all", mode: "surprise" });
    expect(surpriseRes.picks[0]?.media.key).toBe("mys");

    const tvOnly = buildRecommendations({ ...baseOpts, lens: "series", mode: "for-you" });
    expect(tvOnly.picks.every((p) => p.media.kind === "tv")).toBe(true);

    const skipped = buildRecommendations({
      ...baseOpts,
      lens: "all",
      mode: "for-you",
      dismissed: new Set(["an1"]),
    });
    expect(skipped.picks.map((p) => p.media.key)).not.toContain("an1");
  });

  it("normalizes compound genres, hides fake match % on cold start, and caps My List share in for-you", () => {
    expect(normalizeGenres(["Sci-Fi & Fantasy", "Science Fiction", "Action & Adventure"])).toEqual([
      "Sci-Fi",
      "Fantasy",
      "Action",
      "Adventure",
    ]);

    const cold = buildRecommendations({
      progress: [],
      watchlist: [],
      seedRelated: [],
      catalogPools: [
        {
          label: "popular",
          items: [
            media("c1", "movie", { genres: ["Sci-Fi & Fantasy"], rating: 8.4 }),
            media("c2", "tv", { genres: ["Action & Adventure"], rating: 8.2 }),
          ],
        },
      ],
      lens: "all",
      mode: "for-you",
      now: NOW,
    });
    expect(cold.hasSignals).toBe(false);
    expect(cold.picks.every((p) => p.showMatchPct === false)).toBe(true);

    const wl1 = media("wl1", "movie", { genres: ["Sci-Fi"], rating: 8.8 });
    const wl2 = media("wl2", "movie", { genres: ["Sci-Fi"], rating: 8.7 });
    const cat1 = media("cat1", "tv", { genres: ["Sci-Fi & Fantasy"], rating: 8.1 });
    const cat2 = media("cat2", "anime", { genres: ["Sci-Fi"], rating: 8.0 });
    const caught = media("caught", "anime", { genres: ["Action"], status: "RELEASING" });

    const warm = buildRecommendations({
      progress: [
        progressEntry(media("seed", "movie", { genres: ["Science Fiction"] }), 1, { finished: true }),
        progressEntry(caught, 1, { caughtUp: true, position: 0 }),
      ],
      watchlist: [
        { media: wl1, addedAt: NOW - DAY },
        { media: wl2, addedAt: NOW - DAY },
      ],
      seedRelated: [],
      catalogPools: [{ label: "popular", items: [cat1, cat2, caught] }],
      lens: "all",
      mode: "for-you",
      limit: 3,
      now: NOW,
    });
    const keys = warm.picks.map((p) => p.media.key);
    expect(keys).not.toContain("caught");
    expect(warm.picks.filter((p) => p.media.key === "wl1" || p.media.key === "wl2").length).toBeLessThanOrEqual(1);
    expect(warm.picks.every((p) => p.showMatchPct === true)).toBe(true);
  });

  it("supports cold-start seedGenres and builds tuned below-the-fold taste shelves", () => {
    const items = [
      media("m1", "movie", { genres: ["Cyberpunk", "Sci-Fi & Fantasy"], rating: 8.5 }),
      media("m2", "movie", { genres: ["Sci-Fi"], rating: 8.2 }),
      media("m3", "tv", { genres: ["Sci-Fi"], rating: 8.1 }),
      media("m4", "anime", { genres: ["Science Fiction"], rating: 8.0 }),
      media("m5", "movie", { genres: ["Mystery"], rating: 8.4 }),
      media("m6", "tv", { genres: ["Mystery"], rating: 8.1 }),
      media("m7", "anime", { genres: ["Mystery"], rating: 7.9 }),
      media("m8", "movie", { genres: ["Mystery"], rating: 7.8 }),
    ];
    const seeded = buildRecommendations({
      progress: [],
      watchlist: [],
      seedRelated: [],
      catalogPools: [{ label: "popular", items }],
      lens: "all",
      mode: "for-you",
      seedGenres: ["Sci-Fi", "Mystery"],
      now: NOW,
    });
    expect(seeded.hasSignals).toBe(true);
    expect(seeded.topGenres).toContain("Sci-Fi");

    const shelves = buildTasteShelves({
      topGenres: seeded.topGenres,
      hasSignals: seeded.hasSignals,
      progress: [],
      candidates: items,
      lens: "all",
    });
    expect(shelves.length).toBeGreaterThanOrEqual(1);
    expect(shelves[0].items.length).toBeGreaterThanOrEqual(4);
  });
});
