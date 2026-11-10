import { cached } from "./cache";
import { demoDetail, demoList } from "./demo";
import { api, getAuth } from "./account";
import { getSettings } from "./settings";
import type { Episode, Media, MediaDetail } from "./types";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const HOUR = 3600_000;

const ownKey = () => getSettings().tmdbKey.trim();
/** Real catalog is available with your own key, or through the AbixCine server when it holds one. */
export const hasTmdb = () => !!ownKey() || (getAuth().tmdbProxy && !!getAuth().user);

async function get<T = any>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const key = ownKey();
  if (!key) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return api(`/tmdb${path}?${qs}`);
  }
  const url = new URL(API + path);
  const headers: Record<string, string> = { accept: "application/json" };
  // Accept either a v3 API key or a v4 read-access token.
  if (key.length > 60) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

const img = (p: string | null | undefined, size: string) => (p ? `${IMG}/${size}${p}` : undefined);

function toMedia(r: any, fallbackKind?: "movie" | "tv"): Media | null {
  const kind = (r.media_type ?? fallbackKind) as "movie" | "tv";
  if (kind !== "movie" && kind !== "tv") return null;
  const date = r.release_date || r.first_air_date;
  // TMDB tags Japanese animation as genre 16 + origin JP; surface it as anime.
  const isAnime = r.genre_ids?.includes(16) && (r.origin_country?.includes("JP") || r.original_language === "ja");
  return {
    key: `tmdb:${kind}:${r.id}`,
    kind: isAnime && kind === "tv" ? "anime" : kind,
    title: r.title || r.name,
    originalTitle: r.original_title || r.original_name,
    overview: r.overview ?? "",
    year: date ? Number(date.slice(0, 4)) : undefined,
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
    poster: img(r.poster_path, "w500"),
    backdrop: img(r.backdrop_path, "w1280"),
    genres: (r.genres ?? []).map((g: any) => g.name),
  };
}

const list = (rows: any[], kind?: "movie" | "tv") => rows.map((r) => toMedia(r, kind)).filter(Boolean) as Media[];

type Feed = { id: string; title: string; path: string; kind?: "movie" | "tv"; params?: Record<string, string | number> };

export const FEEDS: Record<"home" | "movie" | "tv", Feed[]> = {
  home: [
    { id: "trending", title: "Trending this week", path: "/trending/all/week" },
    { id: "pop-movies", title: "Popular movies", path: "/movie/popular", kind: "movie" },
    { id: "pop-tv", title: "Popular series", path: "/tv/popular", kind: "tv" },
    { id: "top-movies", title: "Critically acclaimed", path: "/movie/top_rated", kind: "movie" },
  ],
  movie: [
    { id: "now", title: "In theaters now", path: "/movie/now_playing", kind: "movie" },
    { id: "pop", title: "Popular", path: "/movie/popular", kind: "movie" },
    { id: "top", title: "Top rated", path: "/movie/top_rated", kind: "movie" },
    { id: "scifi", title: "Science fiction", path: "/discover/movie", kind: "movie", params: { with_genres: 878, sort_by: "popularity.desc" } },
    { id: "thriller", title: "Thrillers", path: "/discover/movie", kind: "movie", params: { with_genres: 53, sort_by: "popularity.desc" } },
  ],
  tv: [
    { id: "air", title: "On the air", path: "/tv/on_the_air", kind: "tv" },
    { id: "pop", title: "Popular", path: "/tv/popular", kind: "tv" },
    { id: "top", title: "Top rated", path: "/tv/top_rated", kind: "tv" },
    { id: "drama", title: "Drama", path: "/discover/tv", kind: "tv", params: { with_genres: 18, sort_by: "popularity.desc" } },
    { id: "crime", title: "Crime", path: "/discover/tv", kind: "tv", params: { with_genres: 80, sort_by: "popularity.desc" } },
  ],
};

export async function loadFeed(f: Feed, i: number): Promise<Media[]> {
  if (!hasTmdb()) return demoList(f.kind ?? (i % 2 ? "tv" : "movie"), i + 1);
  return cached(`tmdb:${f.path}:${JSON.stringify(f.params ?? {})}`, 3 * HOUR, async () => list((await get(f.path, f.params)).results, f.kind));
}

export async function searchTmdb(q: string): Promise<Media[]> {
  if (!hasTmdb()) return demoList("movie", q.length + 3, 8).map((m) => ({ ...m, title: `${q} ${m.title}` }));
  const r = await get("/search/multi", { query: q, include_adult: "false" });
  return list(r.results);
}

export async function tmdbDetail(key: string): Promise<MediaDetail> {
  if (key.startsWith("demo:")) return demoDetail(key);
  const [, kind, id] = key.split(":") as [string, "movie" | "tv", string];
  return cached(`tmdb:detail:${kind}:${id}`, 6 * HOUR, async () => {
    const r = await get(`/${kind}/${id}`, { append_to_response: "videos,credits,recommendations,images", include_image_language: "en,null" });
    const base = toMedia({ ...r, media_type: kind, genre_ids: r.genres?.map((g: any) => g.id) }, kind)!;
    const trailer = r.videos?.results?.find((v: any) => v.site === "YouTube" && v.type === "Trailer");
    return {
      ...base,
      backdrop: img(r.backdrop_path, "original") ?? base.backdrop,
      logo: img((r.images?.logos?.find((l: any) => l.iso_639_1 === "en") ?? r.images?.logos?.[0])?.file_path, "w500"),
      runtime: r.runtime ?? r.episode_run_time?.[0],
      tagline: r.tagline || undefined,
      status: r.status,
      seasons: r.seasons
        ?.filter((s: any) => s.season_number > 0)
        .map((s: any) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count })),
      trailerYouTubeId: trailer?.key,
      cast: (r.credits?.cast ?? []).slice(0, 14).map((c: any) => ({ name: c.name, character: c.character, photo: img(c.profile_path, "w185") })),
      related: list(r.recommendations?.results ?? [], kind).slice(0, 18),
    };
  });
}

/** Top-10 style feeds. */
export const TOP10 = {
  movie: { id: "top10-movie", title: "Top 10 movies today", path: "/trending/movie/day", kind: "movie" as const },
  tv: { id: "top10-tv", title: "Top 10 series today", path: "/trending/tv/day", kind: "tv" as const },
};

export async function tmdbSeason(key: string, season: number): Promise<Episode[]> {
  if (key.startsWith("demo:")) {
    return Array.from({ length: 8 }, (_, i) => ({ season, number: i + 1, title: `Episode ${i + 1}`, overview: "Placeholder episode.", runtime: 45 }));
  }
  const id = key.split(":")[2];
  return cached(`tmdb:season:${id}:${season}`, 6 * HOUR, async () => {
    const r = await get(`/tv/${id}/season/${season}`);
    return r.episodes.map((e: any) => ({
      season,
      number: e.episode_number,
      title: e.name,
      overview: e.overview,
      still: img(e.still_path, "w300"),
      runtime: e.runtime,
      airDate: e.air_date,
      rating: e.vote_average ? Math.round(e.vote_average * 10) / 10 : undefined,
    }));
  });
}
