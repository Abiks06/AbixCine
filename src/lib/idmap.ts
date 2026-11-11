import { getApiBase } from "./account";
import { cached } from "./cache";

/**
 * Anime cross-reference (AniList ↔ MAL ↔ TMDB ↔ TVDB ↔ IMDb) served by the AbixCine API from the
 * Fribb/anime-lists dataset. Public, no sign-in needed. Every lookup fails soft: no map just
 * means matching falls back to titles.
 */
export interface AnimeIds {
  anilist: number;
  mal: number | null;
  tmdbTv: number | null;
  tmdbMovie: number | null;
  tvdb: number | null;
  imdb: string | null;
  type: string | null;
  /** Where this entry sits inside the TMDB/TVDB show: AniList's "Season 2" is TVDB season 2. */
  season: { tvdb: number | null; tmdb: number | null } | null;
  /** Every AniList entry under the same TMDB show, first season first. */
  seasons: { anilist: number; season: { tvdb: number | null; tmdb: number | null } | null; type: string | null }[];
}

const DAY = 24 * 3600_000;

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(getApiBase() + path, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function animeIds(anilistId: number): Promise<AnimeIds | null> {
  return cached(`idmap:anilist:${anilistId}`, 7 * DAY, async () => {
    const r = await get<AnimeIds>(`/idmap/anilist/${anilistId}`);
    if (r === null) throw new Error("no map"); // don't cache misses for a week
    return r;
  }).catch(() => null);
}

/** TMDB id → AniList entries (first season first), for the given TMDB ids. Unknown ids are left out. */
export async function tmdbToAnilist(kind: "tv" | "movie", ids: number[]): Promise<Record<number, { anilist: number; season: AnimeIds["season"] }[]>> {
  const uniq = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0).slice(0, 60);
  if (!uniq.length) return {};
  const key = `idmap:tmdb:${kind}:${uniq.sort((a, b) => a - b).join(",")}`;
  try {
    return await cached(key, DAY, async () => {
      const r = await get<{ map: Record<number, { anilist: number; season: AnimeIds["season"] }[]> }>(`/idmap/tmdb?kind=${kind}&ids=${uniq.join(",")}`);
      if (!r) throw new Error("no map");
      return r.map;
    });
  } catch {
    return {};
  }
}
