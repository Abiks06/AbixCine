import { whenAnimeMappingsHydrated } from "./animeMapping";
import { cached, peekCache } from "./cache";
import { api, getAuth, isWakingError, whenServerAwake } from "./account";
import { isFutureIsoDate, normalizeEpisodes, normalizeTmdbSeasons, tmdbReleaseWindows, todayIso, type RawTmdbSeason } from "./normalizer";
import { getSettings } from "./settings";
import type { Episode, Media, MediaDetail } from "./types";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const HOUR = 3600_000;

const ownKey = () => getSettings().tmdbKey.trim();
/** Real catalog is available with your own key, or through the AbixCine server when it holds one. */
export const hasTmdb = () => !!ownKey() || (getAuth().tmdbProxy && !!getAuth().user);

/** Transport-level in-flight deduplication for identical TMDB requests. */
const inflightGet = new Map<string, Promise<unknown>>();

interface TmdbRawMedia {
  id?: number | string;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  origin_country?: string[];
  original_language?: string;
  genres?: { id: number; name: string }[];
}

interface TmdbListResponse {
  results?: TmdbRawMedia[];
}

interface TmdbEpisodeSummaryRaw {
  season_number?: number;
  episode_number?: number;
  name?: string;
  air_date?: string;
  runtime?: number;
}

interface TmdbEpisodeRaw extends TmdbEpisodeSummaryRaw {
  overview?: string;
  still_path?: string | null;
  vote_average?: number;
}

interface TmdbDetailPayload extends TmdbRawMedia {
  videos?: { results?: { site?: string; type?: string; official?: boolean; key?: string }[] };
  release_dates?: { results?: { iso_3166_1?: string; release_dates?: { certification?: string; type?: number; release_date?: string }[] }[] };
  content_ratings?: { results?: { iso_3166_1?: string; rating?: string }[] };
  created_by?: { name?: string; profile_path?: string | null }[];
  credits?: {
    cast?: { name?: string; character?: string; profile_path?: string | null }[];
    crew?: { name?: string; job?: string; profile_path?: string | null }[];
  };
  recommendations?: TmdbListResponse;
  similar?: TmdbListResponse;
  images?: { logos?: { iso_639_1?: string; file_path?: string }[] };
  seasons?: RawTmdbSeason[];
  runtime?: number;
  episode_run_time?: number[];
  last_episode_to_air?: TmdbEpisodeSummaryRaw;
  next_episode_to_air?: TmdbEpisodeSummaryRaw;
  tagline?: string;
  status?: string;
  last_air_date?: string;
  budget?: number;
  revenue?: number;
  production_companies?: { name?: string }[];
  networks?: { name?: string }[];
  production_countries?: { name?: string }[];
  imdb_id?: string;
  external_ids?: { imdb_id?: string };
  homepage?: string;
  vote_count?: number;
  belongs_to_collection?: { name?: string };
  number_of_episodes?: number;
}

async function get<T = unknown>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const sig = `${path}|${JSON.stringify(params)}`;
  const existing = inflightGet.get(sig);
  if (existing) return existing as Promise<T>;

  const req = (async () => {
    const key = ownKey();
    if (!key) {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      const url = `/tmdb${path}?${qs}`;
      // Through the AbixCine server, which may be asleep on a cold launch: wait for it to wake
      // (shared across every request) and ask again, rather than handing back nothing. Without
      // this, the first open of the day showed anime only until you left Home and came back.
      for (let attempt = 0; ; attempt++) {
        try {
          return (await api(url)) as T;
        } catch (e) {
          if (attempt >= 2 || !isWakingError(e) || !(await whenServerAwake())) throw e;
        }
      }
    }
    const url = new URL(API + path);
    const headers: Record<string, string> = { accept: "application/json" };
    // Accept either a v3 API key or a v4 read-access token.
    if (key.length > 60) headers.Authorization = `Bearer ${key}`;
    else url.searchParams.set("api_key", key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return (await res.json()) as T;
  })().finally(() => inflightGet.delete(sig));

  inflightGet.set(sig, req);
  return req;
}

const img = (p: string | null | undefined, size: string) => (p ? `${IMG}/${size}${p}` : undefined);

function toMedia(r: TmdbRawMedia, fallbackKind?: "movie" | "tv"): Media | null {
  const kind = (r.media_type ?? fallbackKind) as "movie" | "tv";
  if (kind !== "movie" && kind !== "tv") return null;
  const date = r.release_date || r.first_air_date;
  // TMDB tags Japanese animation as genre 16 + origin JP; surface it as anime.
  const isAnime = r.genre_ids?.includes(16) && (r.origin_country?.includes("JP") || r.original_language === "ja");
  return {
    key: `tmdb:${kind}:${r.id}`,
    kind: isAnime && kind === "tv" ? "anime" : kind,
    tmdbId: typeof r.id === "number" ? r.id : Number(r.id) || undefined,
    title: r.title || r.name || "Untitled",
    originalTitle: r.original_title || r.original_name,
    originalLanguage: r.original_language,
    overview: r.overview ?? "",
    year: date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined,
    releaseDate: date || undefined,
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
    poster: img(r.poster_path, "w500"),
    backdrop: img(r.backdrop_path, "w1280"),
    // Detail records carry { id, name } objects; lists and search only carry ids.
    genres: r.genres?.length ? r.genres.map((g) => g.name) : (r.genre_ids ?? []).map((id) => GENRES[id]).filter(Boolean),
  };
}

/** TMDB's genre ids (movie and TV share one numbering). Stable for years, so no extra request per launch. */
const GENRES: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie",
  53: "Thriller", 10752: "War", 37: "Western", 10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality",
  10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
};

const list = (rows: TmdbRawMedia[] | undefined, kind?: "movie" | "tv") => (rows ?? []).map((r) => toMedia(r, kind)).filter(Boolean) as Media[];

type Feed = { id: string; title: string; path: string; kind?: "movie" | "tv"; params?: Record<string, string | number>; /** minutes */ ttl?: number; allowUnreleased?: boolean };

const daysFromNow = (n: number) => todayIso(new Date(Date.now() + n * 86400_000));
/** Date windows are worked out when the feed loads, so "new" always means new today. */
function liveParams(f: Feed): Record<string, string | number> | undefined {
  // "New releases" means new to watch at home: a digital (4), physical (5) or TV (6) release in
  // the last 60 days in any region — not a festival premiere or a film still only in cinemas.
  if (f.id === "new-movies")
    return { ...f.params, with_release_type: "4|5|6", "release_date.gte": daysFromNow(-60), "release_date.lte": daysFromNow(0), "vote_count.gte": 20 };
  if (f.id === "new-tv") return { ...f.params, "first_air_date.gte": daysFromNow(-60), "first_air_date.lte": daysFromNow(0), "vote_count.gte": 5 };
  if (f.id === "soon") return { ...f.params, "primary_release_date.gte": daysFromNow(1), "primary_release_date.lte": daysFromNow(60) };
  if (f.path === "/discover/movie" && !f.allowUnreleased) {
    return { ...f.params, "primary_release_date.lte": daysFromNow(0) };
  }
  if (f.path === "/discover/tv" && !f.allowUnreleased) {
    return { ...f.params, "first_air_date.lte": daysFromNow(0) };
  }
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
    { id: "soon", title: "Coming soon", path: "/discover/movie", kind: "movie", params: { sort_by: "popularity.desc" }, ttl: 360, allowUnreleased: true },
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

export function peekFeed(f: Feed): Media[] | undefined {
  if (!hasTmdb()) return undefined;
  const params = liveParams(f);
  const ttl = (f.ttl ?? 180) * 60_000;
  return peekCache<Media[]>(`tmdb:v2:${f.path}:${JSON.stringify(params ?? {})}`, ttl);
}

export async function loadFeed(f: Feed, _i?: number): Promise<Media[]> {
  if (!hasTmdb()) return [];
  const params = liveParams(f);
  const ttl = (f.ttl ?? 180) * 60_000;
  return cached(`tmdb:v2:${f.path}:${JSON.stringify(params ?? {})}`, ttl, async () => {
    const r = await get<TmdbListResponse>(f.path, params);
    return list(r.results, f.kind).filter((m) => {
      if (!(m.poster || m.backdrop)) return false;
      if (f.allowUnreleased) return isFutureIsoDate(m.releaseDate);
      return !isFutureIsoDate(m.releaseDate) && Boolean(m.releaseDate || m.year);
    });
  });
}

export async function searchTmdb(q: string): Promise<Media[]> {
  const cleanQ = q.trim().toLowerCase();
  if (!cleanQ || !hasTmdb()) return [];
  return cached(`tmdb:search:v2:${cleanQ}`, 30 * 60_000, async () => {
    const r = await get<TmdbListResponse>("/search/multi", { query: q.trim(), include_adult: "false" });
    return list(r.results);
  });
}

const CREW_JOBS = ["Director", "Creator", "Screenplay", "Writer", "Story", "Novel", "Original Music Composer", "Director of Photography", "Producer"];

/** The user's region, for age ratings and release dates ("GB" from "en-GB"); US as the fallback. */
/** "en-GB" → GB, "zh-Hant-TW" → TW (the region is the two-letter subtag, wherever it sits), "en" → US. */
const region = () => {
  const tags = typeof navigator !== "undefined" && navigator.language ? navigator.language.split("-").slice(1) : [];
  return (tags.find((t) => /^[a-z]{2}$/i.test(t)) ?? "US").toUpperCase();
};

export async function tmdbDetail(key: string): Promise<MediaDetail> {
  const [, kind, id] = key.split(":") as [string, "movie" | "tv", string];
  if ((kind !== "movie" && kind !== "tv") || !id) throw new Error(`Invalid TMDB key: ${key}`);

  return cached(`tmdb:detail:v5:${kind}:${id}`, 3 * HOUR, async () => {
    const extra = kind === "movie" ? "release_dates" : "content_ratings";
    const r = await get<TmdbDetailPayload>(`/${kind}/${id}`, {
      append_to_response: `videos,credits,recommendations,similar,images,external_ids,${extra}`,
      include_image_language: "en,null",
    });
    const base = toMedia({ ...r, media_type: kind, genre_ids: r.genres?.map((g) => g.id) }, kind);
    if (!base) throw new Error(`Invalid TMDB ${kind} payload for ${id}`);
    const trailer =
      r.videos?.results?.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ??
      r.videos?.results?.find((v) => v.site === "YouTube" && v.type === "Trailer");
    const reg = region();
    const cert =
      kind === "movie"
        ? (["" + reg, "US"].map((c) => r.release_dates?.results?.find((x) => x.iso_3166_1 === c)?.release_dates?.find((d) => d.certification)?.certification).find(Boolean))
        : ([reg, "US"].map((c) => r.content_ratings?.results?.find((x) => x.iso_3166_1 === c)?.rating).find(Boolean));
    // Crew: one line per person, jobs merged ("Director, Writer"), ordered by importance.
    const crewMap = new Map<string, { name: string; job: string; photo?: string; rank: number }>();
    const people = [
      ...(r.created_by ?? []).map((c) => ({ ...c, job: "Creator" })),
      ...(r.credits?.crew ?? []),
    ];
    for (const c of people) {
      if (!c.name || !c.job) continue;
      const rank = CREW_JOBS.indexOf(c.job);
      if (rank < 0) continue;
      const cur = crewMap.get(c.name);
      if (cur) {
        if (!cur.job.split(", ").includes(c.job)) cur.job += `, ${c.job}`;
        cur.rank = Math.min(cur.rank, rank);
      } else crewMap.set(c.name, { name: c.name, job: c.job, photo: img(c.profile_path, "w185"), rank });
    }
    const ep = (e?: TmdbEpisodeSummaryRaw) =>
      e && e.season_number != null && e.episode_number != null
        ? { season: e.season_number, episode: e.episode_number, name: e.name ?? "", airDate: e.air_date }
        : undefined;
    const related = list(r.recommendations?.results ?? [], kind);
    // Splitting seasons into cours reads the anime index: wait for it (briefly) so an early visit
    // doesn't cache an unsplit season for three hours.
    if (kind === "tv") await whenAnimeMappingsHydrated();
    const lastEpisode = ep(r.last_episode_to_air);
    const nextEpisode = ep(r.next_episode_to_air);
    const normalizedSeasons =
      kind === "tv"
        ? normalizeTmdbSeasons(r.seasons, base.key, Number(id), {
            lastEpisode,
            nextEpisode,
            status: r.status,
          })
        : undefined;

    return {
      ...base,
      backdrop: img(r.backdrop_path, "original") ?? base.backdrop,
      logo: img((r.images?.logos?.find((l) => l.iso_639_1 === "en") ?? r.images?.logos?.[0])?.file_path, "w500"),
      // TMDB reports an unknown runtime as 0, which would read as "0m" and pass every "fits tonight" filter.
      runtime: [r.runtime, r.episode_run_time?.[0], r.last_episode_to_air?.runtime].find((n) => typeof n === "number" && n > 0),
      tagline: r.tagline || undefined,
      status: r.status,
      seasons: normalizedSeasons?.seasons.length ? normalizedSeasons.seasons : undefined,
      specials: normalizedSeasons?.specials.length ? normalizedSeasons.specials : undefined,
      upcomingSeasons: normalizedSeasons?.upcomingSeasons.length ? normalizedSeasons.upcomingSeasons : undefined,
      canonicalKey: normalizedSeasons?.canonicalKey ?? base.key,
      initialSeason: normalizedSeasons?.initialSeason,
      trailerYouTubeId: trailer?.key,
      cast: (r.credits?.cast ?? [])
        .slice(0, 24)
        .filter((c): c is typeof c & { name: string } => Boolean(c.name))
        .map((c) => ({ name: c.name, character: c.character, photo: img(c.profile_path, "w185") })),
      crew: [...crewMap.values()].sort((a, b) => a.rank - b.rank).slice(0, 12).map(({ rank: _r, ...c }) => c),
      related: (related.length ? related : list(r.similar?.results ?? [], kind)).slice(0, 18),
      releaseDate: r.release_date || r.first_air_date || undefined,
      ...(kind === "movie" ? releaseWindowFields(r.release_dates?.results) : {}),
      endDate: kind === "tv" && (r.status === "Ended" || r.status === "Canceled") ? r.last_air_date : undefined,
      budget: r.budget || undefined,
      revenue: r.revenue || undefined,
      originalLanguage: r.original_language,
      certification: cert || undefined,
      companies: (r.production_companies ?? []).slice(0, 4).map((c) => c.name).filter((n): n is string => Boolean(n)),
      networks: (r.networks ?? []).slice(0, 3).map((n) => n.name).filter((n): n is string => Boolean(n)),
      countries: (r.production_countries ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)),
      imdbId: r.imdb_id ?? r.external_ids?.imdb_id ?? undefined,
      homepage: r.homepage || undefined,
      voteCount: r.vote_count,
      collection: r.belongs_to_collection?.name,
      lastEpisode,
      nextEpisode,
      totalEpisodes: r.number_of_episodes,
      fetchedAt: Date.now(),
    };
  });
}

function releaseWindowFields(results: Parameters<typeof tmdbReleaseWindows>[0]) {
  const w = tmdbReleaseWindows(results);
  return { theatricalReleaseDate: w.theatrical, digitalReleaseDate: w.digital };
}

/** Top-10 style feeds. */
export const TOP10 = {
  movie: { id: "top10-movie", title: "Top 10 movies today", path: "/trending/movie/day", kind: "movie" as const, ttl: 30 },
  tv: { id: "top10-tv", title: "Top 10 series today", path: "/trending/tv/day", kind: "tv" as const, ttl: 30 },
};

export async function tmdbSeason(key: string, season: number): Promise<Episode[]> {
  const [, kind, id] = key.split(":");
  if (kind !== "tv" || !id || !Number.isInteger(season) || season < 0) return [];
  try {
    return await cached(`tmdb:season:v2:${id}:${season}`, 2 * HOUR, async () => {
      const r = await get<{ episodes?: TmdbEpisodeRaw[] }>(`/tv/${id}/season/${season}`);
      const rawList = Array.isArray(r?.episodes) ? r.episodes : [];
      const mapped = rawList.map((e) => ({
        season,
        number: typeof e?.episode_number === "number" ? e.episode_number : 0,
        title: e?.name,
        overview: e?.overview,
        still: img(e?.still_path, "w300"),
        runtime: e?.runtime,
        airDate: e?.air_date,
        rating: e?.vote_average ? Math.round(e.vote_average * 10) / 10 : undefined,
      }));
      return normalizeEpisodes(mapped, season);
    });
  } catch {
    return [];
  }
}
