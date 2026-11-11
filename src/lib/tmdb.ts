import { cached } from "./cache";
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

type Feed = { id: string; title: string; path: string; kind?: "movie" | "tv"; params?: Record<string, string | number>; /** minutes */ ttl?: number };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86400_000));
/** Date windows are worked out when the feed loads, so "new" always means new today. */
function liveParams(f: Feed): Record<string, string | number> | undefined {
  if (f.id === "new-movies") return { ...f.params, "primary_release_date.gte": daysFromNow(-45), "primary_release_date.lte": daysFromNow(0), "vote_count.gte": 20 };
  if (f.id === "new-tv") return { ...f.params, "first_air_date.gte": daysFromNow(-60), "first_air_date.lte": daysFromNow(0), "vote_count.gte": 5 };
  if (f.id === "soon") return { ...f.params, "primary_release_date.gte": daysFromNow(1), "primary_release_date.lte": daysFromNow(60) };
  return f.params;
}

export const FEEDS: Record<"home" | "movie" | "tv", Feed[]> = {
  home: [
    { id: "trending", title: "Trending today", path: "/trending/all/day", ttl: 30 },
    { id: "pop-movies", title: "Popular movies", path: "/movie/popular", kind: "movie", ttl: 60 },
    { id: "pop-tv", title: "Popular series", path: "/tv/popular", kind: "tv", ttl: 60 },
    { id: "top-movies", title: "Critically acclaimed", path: "/movie/top_rated", kind: "movie", ttl: 720 },
    { id: "new-movies", title: "New releases", path: "/discover/movie", kind: "movie", params: { sort_by: "popularity.desc" }, ttl: 120 },
    { id: "new-tv", title: "New series", path: "/discover/tv", kind: "tv", params: { sort_by: "popularity.desc" }, ttl: 120 },
    { id: "soon", title: "Coming soon", path: "/discover/movie", kind: "movie", params: { sort_by: "popularity.desc" }, ttl: 360 },
  ],
  movie: [
    { id: "now", title: "In theaters now", path: "/movie/now_playing", kind: "movie", ttl: 120 },
    { id: "pop", title: "Popular", path: "/movie/popular", kind: "movie" },
    { id: "top", title: "Top rated", path: "/movie/top_rated", kind: "movie" },
    { id: "scifi", title: "Science fiction", path: "/discover/movie", kind: "movie", params: { with_genres: 878, sort_by: "popularity.desc" } },
    { id: "thriller", title: "Thrillers", path: "/discover/movie", kind: "movie", params: { with_genres: 53, sort_by: "popularity.desc" } },
  ],
  tv: [
    { id: "air", title: "On the air", path: "/tv/on_the_air", kind: "tv", ttl: 120 },
    { id: "pop", title: "Popular", path: "/tv/popular", kind: "tv" },
    { id: "top", title: "Top rated", path: "/tv/top_rated", kind: "tv" },
    { id: "drama", title: "Drama", path: "/discover/tv", kind: "tv", params: { with_genres: 18, sort_by: "popularity.desc" } },
    { id: "crime", title: "Crime", path: "/discover/tv", kind: "tv", params: { with_genres: 80, sort_by: "popularity.desc" } },
  ],
};

export async function loadFeed(f: Feed, _i?: number): Promise<Media[]> {
  if (!hasTmdb()) return [];
  const params = liveParams(f);
  const ttl = (f.ttl ?? 180) * 60_000;
  return cached(`tmdb:${f.path}:${JSON.stringify(params ?? {})}`, ttl, async () => {
    const r = await get(f.path, params);
    return list(r.results, f.kind).filter((m) => m.poster || m.backdrop);
  });
}

export async function searchTmdb(q: string): Promise<Media[]> {
  if (!hasTmdb()) return [];
  const r = await get("/search/multi", { query: q, include_adult: "false" });
  return list(r.results);
}

const CREW_JOBS = ["Director", "Creator", "Screenplay", "Writer", "Story", "Novel", "Original Music Composer", "Director of Photography", "Producer"];

/** The user's region, for age ratings and release dates ("GB" from "en-GB"); US as the fallback. */
const region = () => (navigator.language.split("-")[1] ?? "US").toUpperCase();

export async function tmdbDetail(key: string): Promise<MediaDetail> {
  const [, kind, id] = key.split(":") as [string, "movie" | "tv", string];
  return cached(`tmdb:detail:v2:${kind}:${id}`, 3 * HOUR, async () => {
    const extra = kind === "movie" ? "release_dates" : "content_ratings";
    const r = await get(`/${kind}/${id}`, {
      append_to_response: `videos,credits,recommendations,similar,images,external_ids,${extra}`,
      include_image_language: "en,null",
    });
    const base = toMedia({ ...r, media_type: kind, genre_ids: r.genres?.map((g: any) => g.id) }, kind)!;
    const trailer =
      r.videos?.results?.find((v: any) => v.site === "YouTube" && v.type === "Trailer" && v.official) ??
      r.videos?.results?.find((v: any) => v.site === "YouTube" && v.type === "Trailer");
    const reg = region();
    const cert =
      kind === "movie"
        ? (["" + reg, "US"].map((c) => r.release_dates?.results?.find((x: any) => x.iso_3166_1 === c)?.release_dates?.find((d: any) => d.certification)?.certification).find(Boolean))
        : ([reg, "US"].map((c) => r.content_ratings?.results?.find((x: any) => x.iso_3166_1 === c)?.rating).find(Boolean));
    // Crew: one line per person, jobs merged ("Director, Writer"), ordered by importance.
    const crewMap = new Map<string, { name: string; job: string; photo?: string; rank: number }>();
    const people = [
      ...(r.created_by ?? []).map((c: any) => ({ ...c, job: "Creator" })),
      ...(r.credits?.crew ?? []),
    ];
    for (const c of people) {
      const rank = CREW_JOBS.indexOf(c.job);
      if (rank < 0) continue;
      const cur = crewMap.get(c.name);
      if (cur) {
        if (!cur.job.includes(c.job)) cur.job += `, ${c.job}`;
        cur.rank = Math.min(cur.rank, rank);
      } else crewMap.set(c.name, { name: c.name, job: c.job, photo: img(c.profile_path, "w185"), rank });
    }
    const ep = (e: any) => (e ? { season: e.season_number, episode: e.episode_number, name: e.name, airDate: e.air_date } : undefined);
    const related = list(r.recommendations?.results ?? [], kind);
    return {
      ...base,
      backdrop: img(r.backdrop_path, "original") ?? base.backdrop,
      logo: img((r.images?.logos?.find((l: any) => l.iso_639_1 === "en") ?? r.images?.logos?.[0])?.file_path, "w500"),
      runtime: r.runtime ?? r.episode_run_time?.[0] ?? r.last_episode_to_air?.runtime ?? undefined,
      tagline: r.tagline || undefined,
      status: r.status,
      seasons: r.seasons
        ?.filter((s: any) => s.season_number > 0)
        .map((s: any) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count })),
      trailerYouTubeId: trailer?.key,
      cast: (r.credits?.cast ?? []).slice(0, 24).map((c: any) => ({ name: c.name, character: c.character, photo: img(c.profile_path, "w185") })),
      crew: [...crewMap.values()].sort((a, b) => a.rank - b.rank).slice(0, 12).map(({ rank: _r, ...c }) => c),
      related: (related.length ? related : list(r.similar?.results ?? [], kind)).slice(0, 18),
      releaseDate: r.release_date || r.first_air_date || undefined,
      endDate: kind === "tv" && r.status === "Ended" ? r.last_air_date : undefined,
      budget: r.budget || undefined,
      revenue: r.revenue || undefined,
      originalLanguage: r.original_language,
      certification: cert || undefined,
      companies: (r.production_companies ?? []).slice(0, 4).map((c: any) => c.name),
      networks: (r.networks ?? []).slice(0, 3).map((n: any) => n.name),
      countries: (r.production_countries ?? []).map((c: any) => c.name),
      imdbId: r.imdb_id ?? r.external_ids?.imdb_id ?? undefined,
      homepage: r.homepage || undefined,
      voteCount: r.vote_count,
      collection: r.belongs_to_collection?.name,
      lastEpisode: ep(r.last_episode_to_air),
      nextEpisode: ep(r.next_episode_to_air),
      totalEpisodes: r.number_of_episodes,
      fetchedAt: Date.now(),
    };
  });
}

/** Top-10 style feeds. */
export const TOP10 = {
  movie: { id: "top10-movie", title: "Top 10 movies today", path: "/trending/movie/day", kind: "movie" as const, ttl: 30 },
  tv: { id: "top10-tv", title: "Top 10 series today", path: "/trending/tv/day", kind: "tv" as const, ttl: 30 },
};

export async function tmdbSeason(key: string, season: number): Promise<Episode[]> {
  const id = key.split(":")[2];
  return cached(`tmdb:season:${id}:${season}`, 2 * HOUR, async () => {
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
