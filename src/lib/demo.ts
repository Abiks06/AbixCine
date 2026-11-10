import type { Media, MediaDetail, MediaKind } from "./types";

/**
 * Placeholder catalog used when no TMDB key is set or the network is down,
 * so the UI is never empty. Titles are invented; artwork is generated from `hue`.
 */
const WORDS = ["Neon", "Tidal", "Echo", "Glass", "Hollow", "Ember", "Static", "Orbit", "Velvet", "Iron", "Paper", "Silent", "Atlas", "AbixCine", "Drift", "Signal"];
const NOUNS = ["Harbor", "Protocol", "Garden", "Crown", "Season", "Frontier", "Archive", "City", "Run", "Signal", "Hours", "Kingdom", "Machine", "Tide", "Wake", "Circuit"];
const GENRES = ["Sci-Fi", "Drama", "Thriller", "Action", "Mystery", "Comedy", "Fantasy", "Adventure", "Romance", "Slice of Life"];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function demoList(kind: MediaKind, seed: number, n = 18): Media[] {
  const r = rng(seed * 97 + kind.length);
  return Array.from({ length: n }, (_, i) => {
    const title = `${WORDS[Math.floor(r() * WORDS.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]}`;
    const id = seed * 1000 + i;
    return {
      key: `demo:${kind}:${id}`,
      kind,
      title,
      overview:
        "A placeholder title from AbixCine's demo catalog. Add a free TMDB key in Settings to browse the real catalog, and connect a source to play it.",
      year: 2015 + Math.floor(r() * 11),
      rating: Math.round((6 + r() * 3.5) * 10) / 10,
      genres: [GENRES[Math.floor(r() * GENRES.length)], GENRES[Math.floor(r() * GENRES.length)]].filter((g, j, a) => a.indexOf(g) === j),
      hue: Math.floor(r() * 360),
    };
  });
}

export function demoDetail(key: string): MediaDetail {
  const [, kind, idStr] = key.split(":");
  const id = Number(idStr);
  const base = demoList(kind as MediaKind, Math.floor(id / 1000)).find((m) => m.key === key) ?? demoList("movie", 1)[0];
  return {
    ...base,
    runtime: kind === "movie" ? 118 : 24,
    tagline: "Every signal leads somewhere.",
    seasons: kind === "tv" ? [1, 2, 3].map((n) => ({ number: n, name: `Season ${n}`, episodeCount: 8 })) : undefined,
    episodeCount: kind === "anime" ? 12 : undefined,
    cast: ["Ada Vance", "Kenji Mori", "Lea Okafor", "Sam Reyes", "Iris Hale"].map((name) => ({ name, character: "Character" })),
    related: demoList(base.kind, Math.floor(id / 1000) + 7, 10),
  };
}
