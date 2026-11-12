import { cached, peekCache, seedCache } from "./cache";
import { stripHtml } from "./format";
import {
  normalizeEpisodes,
  reconcileAnimeSeasons,
  resolveAnilistEpisodeCount,
  type RawAnilistNode,
  type ReconciledSeasons,
} from "./normalizer";
import type { Episode, Media, MediaDetail } from "./types";

// AniList's public GraphQL API needs no key (rate limit ~90 req/min).
const API = "https://graphql.anilist.co";
const HOUR = 3600_000;

/** Transport-level in-flight deduplication for identical GraphQL queries. */
const inflightGql = new Map<string, Promise<unknown>>();

interface AnilistRelationNode {
  id: number;
  format?: string | null;
  relations?: { edges?: { relationType?: string | null; node?: AnilistRelationNode | null }[] | null } | null;
}

interface AnilistMediaItem extends RawAnilistNode {
  description?: string | null;
  averageScore?: number | null;
  genres?: string[] | null;
  coverImage?: { extraLarge?: string | null; color?: string | null } | null;
  bannerImage?: string | null;
  relations?: { edges?: { relationType?: string | null; node?: { id: number; format?: string | null } | null }[] | null } | null;
}

interface AnilistDetailItem extends AnilistMediaItem {
  trailer?: { id?: string; site?: string } | null;
  source?: string | null;
  season?: string | null;
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  popularity?: number | null;
  streamingEpisodes?: { title?: string; thumbnail?: string }[] | null;
  studios?: { nodes?: { name?: string | null }[] | null } | null;
  staff?: {
    edges?: { role?: string | null; node?: { name?: { full?: string | null } | null; image?: { medium?: string | null } | null } | null }[] | null;
  } | null;
  characters?: {
    edges?: {
      role?: string | null;
      node?: { name?: { full?: string | null } | null; image?: { medium?: string | null } | null } | null;
      voiceActors?: { name?: { full?: string | null } | null }[] | null;
    }[] | null;
  } | null;
  recommendations?: { nodes?: { mediaRecommendation?: AnilistMediaItem | null }[] | null } | null;
}

interface AniZipEpisode {
  title?: { en?: string; "x-jat"?: string };
  overview?: string;
  summary?: string;
  image?: string;
  runtime?: number;
  length?: number;
  airDate?: string;
}

async function gql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const sig = `${query.replace(/\s+/g, " ").trim()}|${JSON.stringify(variables)}`;
  const existing = inflightGql.get(sig);
  if (existing) return existing as Promise<T>;

  const req = (async () => {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const j = await res.json();
    if (j.errors) throw new Error(j.errors[0]?.message ?? "AniList error");
    return j.data as T;
  })().finally(() => inflightGql.delete(sig));

  inflightGql.set(sig, req);
  return req;
}

const FIELDS = `id idMal title { romaji english native } description(asHtml: false) seasonYear averageScore genres
  coverImage { extraLarge color } bannerImage episodes duration format status`;

function toMedia(m: AnilistMediaItem): Media {
  return {
    key: `anilist:${m.id}`,
    kind: "anime",
    anilistId: m.id,
    malId: m.idMal ?? undefined,
    title: m.title?.english || m.title?.romaji || "Untitled",
    originalTitle: m.title?.romaji ?? undefined,
    overview: stripHtml(m.description ?? ""),
    year: m.seasonYear ?? m.startDate?.year ?? undefined,
    rating: m.averageScore ? m.averageScore / 10 : undefined,
    poster: m.coverImage?.extraLarge ?? undefined,
    backdrop: m.bannerImage ?? undefined,
    genres: m.genres ?? [],
    color: m.coverImage?.color ?? undefined,
  };
}

export const ANIME_FEEDS = [
  { id: "trending", title: "Trending now", sort: "TRENDING_DESC" },
  { id: "season", title: "Airing this season", sort: "POPULARITY_DESC", airing: true },
  { id: "popular", title: "All-time popular", sort: "POPULARITY_DESC" },
  { id: "top", title: "Highest rated", sort: "SCORE_DESC" },
] as const;

function currentSeason() {
  const d = new Date();
  const m = d.getMonth();
  const season = m < 3 ? "WINTER" : m < 6 ? "SPRING" : m < 9 ? "SUMMER" : "FALL";
  return { season, year: d.getFullYear() };
}

export async function loadAnimeFeed(f: (typeof ANIME_FEEDS)[number], _i?: number): Promise<Media[]> {
  const airing = "airing" in f && f.airing;
  return cached(`anilist:feed:${f.id}`, 3 * HOUR, async () => {
    const { season, year } = currentSeason();
    const d = await gql<{ Page?: { media?: AnilistMediaItem[] } }>(
      `query($sort:[MediaSort],$season:MediaSeason,$year:Int){ Page(perPage:24){ media(type:ANIME,sort:$sort,isAdult:false,season:$season,seasonYear:$year){ ${FIELDS} } } }`,
      { sort: [f.sort], ...(airing ? { season, year } : {}) },
    );
    return (d.Page?.media ?? []).map(toMedia);
  });
}

/** Formats that can link seasons or specials across a franchise graph. */
const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"]);
const MAINLINE_SEARCH_FORMATS = new Set(["TV", "ONA"]);
const isSeasonLink = (rel: string, format?: string | null) =>
  (rel === "SEQUEL" || rel === "PREQUEL" || rel === "SIDE_STORY") && !!format && SEASON_FORMATS.has(format);

/** Strip season/cour/part markers so "My Hero Academia Season 3" groups with "My Hero Academia". */
export function baseTitle(t: string) {
  return t
    .toLowerCase()
    .replace(/[:\-–]\s*(part|cour)\s*\d+.*$/i, "")
    .replace(/\b(season|cour|part)\s*\d+\b.*$/i, "")
    .replace(/\b\d+(st|nd|rd|th)\s+(season|cour|part)\b.*$/i, "")
    .replace(/\b(final|second|third|fourth|fifth|sixth|seventh)\s+(season|cour|part)\b.*$/i, "")
    .replace(/\s+(ii|iii|iv|v|vi)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Search, with every series' seasons folded into one result. Seasons are joined when AniList
 * links them as prequel/sequel within the results, or share a base title; the earliest mainline
 * entry stands for the show and seasonCount reflects reconciled playable seasons (cours folded).
 */
export async function searchAnime(q: string): Promise<Media[]> {
  const cleanQ = q.trim().toLowerCase();
  if (!cleanQ) return [];
  try {
    return await cached(`anilist:search:v2:${cleanQ}`, 30 * 60_000, async () => {
      const d = await gql<{ Page?: { media?: AnilistMediaItem[] } }>(
        `query($q:String){ Page(perPage:25){ media(type:ANIME,search:$q,isAdult:false,sort:SEARCH_MATCH){ ${FIELDS} startDate { year month day } nextAiringEpisode { episode } relations { edges { relationType node { id format } } } } } }`,
        { q: q.trim() },
      );
      const list: AnilistMediaItem[] = d.Page?.media ?? [];
      const parent = new Map<number, number>(list.map((m) => [m.id, m.id]));
      const find = (x: number): number => {
        const p = parent.get(x);
        if (p == null || p === x) return x;
        const root = find(p);
        parent.set(x, root);
        return root;
      };
      const union = (a: number, b: number) => parent.set(find(a), find(b));
      const byBase = new Map<string, number>();
      for (const m of list) {
        if (!m.format || !MAINLINE_SEARCH_FORMATS.has(m.format)) continue;
        for (const e of m.relations?.edges ?? []) {
          if (e.node && parent.has(e.node.id) && (e.relationType === "SEQUEL" || e.relationType === "PREQUEL") && e.node.format && MAINLINE_SEARCH_FORMATS.has(e.node.format)) {
            union(m.id, e.node.id);
          }
        }
        const base = baseTitle(m.title?.english || m.title?.romaji || "");
        if (!base) continue;
        const existingBase = byBase.get(base);
        if (existingBase != null) union(m.id, existingBase);
        else byBase.set(base, m.id);
      }
      const order = (m: AnilistMediaItem) => (m.startDate?.year ?? m.seasonYear ?? 9999) * 12 + (m.startDate?.month ?? 0);
      const groups = new Map<number, AnilistMediaItem[]>();
      for (const m of list) {
        const root = m.format && MAINLINE_SEARCH_FORMATS.has(m.format) ? find(m.id) : m.id;
        groups.set(root, [...(groups.get(root) ?? []), m]);
      }
      const seen = new Set<number>();
      const out: Media[] = [];
      for (const m of list) {
        const root = m.format && MAINLINE_SEARCH_FORMATS.has(m.format) ? find(m.id) : m.id;
        if (seen.has(root)) continue;
        seen.add(root);
        const members = groups.get(root) ?? [m];
        const airedMembers = members.filter((x) => resolveAnilistEpisodeCount(x) > 0);
        const pool = airedMembers.length > 0 ? airedMembers : members;
        const first = [...pool].sort((x, y) => order(x) - order(y))[0];
        const reconciled = reconcileAnimeSeasons(members);
        out.push({
          ...toMedia(first),
          seasonCount: reconciled.seasons.length > 1 ? reconciled.seasons.length : undefined,
        });
      }
      return out;
    });
  } catch {
    return [];
  }
}

export interface AnimeSeason {
  key: string;
  id: number;
  malId?: number;
  title: string;
  episodes?: number;
  year?: number;
  /** "Season 2" style label in airing order. */
  label: string;
}

const REL_DEPTH = `relations { edges { relationType node { id format REL } } }`;
const relQuery = (depth: number) => {
  let q = "";
  for (let i = 0; i < depth; i++) q = REL_DEPTH.replace("REL", q);
  return q;
};

const FRANCHISE_CACHE_PREFIX = "anilist:franchise:v2:";
const STREAMING_EPS_CACHE_PREFIX = "anilist:streaming-eps:v1:";

/**
 * Fetch raw franchise nodes for an AniList entry and seed the cache for every discovered
 * member ID so switching seasons or opening a sequel entry never re-queries the graph.
 */
export async function animeFranchiseNodes(key: string): Promise<RawAnilistNode[]> {
  const start = Number(key.split(":")[1]);
  if (!start || !Number.isFinite(start)) return [];

  const cachedHit = peekCache<RawAnilistNode[]>(`${FRANCHISE_CACHE_PREFIX}${start}`, 24 * HOUR);
  if (cachedHit) return cachedHit;

  return cached(`${FRANCHISE_CACHE_PREFIX}${start}`, 24 * HOUR, async () => {
    const ids = new Set<number>([start]);
    let frontier = [start];
    for (let round = 0; round < 6 && frontier.length; round++) {
      const d = await gql<{ Page?: { media?: AnilistRelationNode[] } }>(
        `query($ids:[Int]){ Page(perPage:50){ media(id_in:$ids,type:ANIME){ id format ${relQuery(4)} } } }`,
        { ids: frontier },
      );
      const next: number[] = [];
      const walk = (node: AnilistRelationNode) => {
        for (const e of node.relations?.edges ?? []) {
          if (!e.relationType || !e.node || !isSeasonLink(e.relationType, e.node.format)) continue;
          if (!ids.has(e.node.id)) {
            ids.add(e.node.id);
            next.push(e.node.id);
          }
          walk(e.node);
        }
      };
      for (const m of d.Page?.media ?? []) walk(m);
      frontier = next;
      if (ids.size > 40) break;
    }
    const d = await gql<{ Page?: { media?: RawAnilistNode[] } }>(
      `query($ids:[Int]){ Page(perPage:50){ media(id_in:$ids,type:ANIME){ id idMal format status episodes duration seasonYear startDate { year month day } title { romaji english native } nextAiringEpisode { episode airingAt } } } }`,
      { ids: [...ids] },
    );
    const nodes: RawAnilistNode[] = (d.Page?.media ?? []).filter(
      (m) => (m.format && SEASON_FORMATS.has(m.format)) || m.id === start,
    );
    const now = Date.now();
    for (const m of nodes) {
      seedCache(`${FRANCHISE_CACHE_PREFIX}${m.id}`, nodes, now);
    }
    return nodes;
  });
}

/**
 * Reconcile an AniList franchise into canonical seasons (with cours folded, Specials separated,
 * and unaired/TBA entries excluded from the primary selector).
 */
export async function reconcileAnilistFranchise(key: string): Promise<ReconciledSeasons> {
  const nodes = await animeFranchiseNodes(key);
  return reconcileAnimeSeasons(nodes, key);
}

/**
 * Every playable mainline season of the series an AniList entry belongs to, in airing order,
 * with split cours folded and unaired/special entries excluded from the mainline count.
 */
export async function animeSeasons(key: string): Promise<AnimeSeason[]> {
  const reconciled = await reconcileAnilistFranchise(key);
  return reconciled.seasons.map((s) => ({
    key: s.key ?? key,
    id: s.anilistId ?? Number((s.key ?? key).split(":")[1]),
    malId: s.malId,
    title: s.cours?.[0]?.title ?? s.name,
    episodes: s.episodeCount,
    year: s.year,
    label: s.name,
  }));
}

const STAFF_ROLE = /^(Director|Original Creator|Original Story|Series Composition|Music|Character Design|Script|Chief Director|Animation Director)/;
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const isoDate = (d?: { year?: number | null; month?: number | null; day?: number | null } | null) =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}` : undefined;

export async function anilistDetail(key: string): Promise<MediaDetail> {
  const id = Number(key.split(":")[1]);
  if (!id || !Number.isFinite(id)) throw new Error(`Invalid AniList key: ${key}`);

  return cached(`anilist:detail:v4:${id}`, 3 * HOUR, async () => {
    const d = await gql<{ Media?: AnilistDetailItem }>(
      `query($id:Int){ Media(id:$id,type:ANIME){ ${FIELDS} nextAiringEpisode { episode airingAt }
        trailer { id site }
        source season seasonYear startDate { year month day } endDate { year month day } popularity
        streamingEpisodes { title thumbnail }
        studios(isMain:true){ nodes { name } }
        staff(perPage:12,sort:RELEVANCE){ edges { role node { name { full } image { medium } } } }
        characters(perPage:16,sort:[ROLE,RELEVANCE]){ edges { role node { name { full } image { medium } } voiceActors(language:JAPANESE,sort:RELEVANCE){ name { full } } } }
        recommendations(perPage:14,sort:RATING_DESC){ nodes { mediaRecommendation { ${FIELDS} } } } } }`,
      { id },
    );
    const m = d.Media;
    if (!m) throw new Error(`AniList entry ${id} not found`);

    if (Array.isArray(m.streamingEpisodes)) {
      seedCache(`${STREAMING_EPS_CACHE_PREFIX}${id}`, m.streamingEpisodes);
    }

    const epCount = resolveAnilistEpisodeCount(m);

    return {
      ...toMedia(m),
      runtime: m.duration ?? undefined,
      status: m.status ?? undefined,
      episodeCount: epCount > 0 ? epCount : undefined,
      nextAiring:
        m.nextAiringEpisode && typeof m.nextAiringEpisode.airingAt === "number"
          ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt * 1000 }
          : undefined,
      trailerYouTubeId: m.trailer?.site === "youtube" ? m.trailer.id : undefined,
      cast: (m.characters?.edges ?? [])
        .filter((e): e is typeof e & { node: { name: { full: string }; image?: { medium?: string | null } | null } } => Boolean(e?.node?.name?.full))
        .map((e) => ({
          name: e.node.name.full,
          character: e.role ? e.role[0] + e.role.slice(1).toLowerCase() : undefined,
          photo: e.node.image?.medium ?? undefined,
          actor: e.voiceActors?.[0]?.name?.full ?? undefined,
        })),
      crew: (m.staff?.edges ?? [])
        .filter((e): e is typeof e & { node: { name: { full: string }; image?: { medium?: string | null } | null }; role: string } => Boolean(e?.node?.name?.full && e.role && STAFF_ROLE.test(e.role)))
        .map((e) => ({ name: e.node.name.full, job: e.role.replace(/\s*\(.*\)$/, ""), photo: e.node.image?.medium ?? undefined })),
      companies: (m.studios?.nodes ?? []).map((n) => n.name).filter((n): n is string => Boolean(n)),
      releaseDate: isoDate(m.startDate),
      endDate: isoDate(m.endDate),
      source: m.source ? titleCase(m.source) : undefined,
      seasonLabel: m.season && m.seasonYear ? `${titleCase(m.season)} ${m.seasonYear}` : undefined,
      format: m.format ? (m.format.length <= 3 ? m.format : titleCase(m.format)) : undefined,
      originalLanguage: "ja",
      voteCount: m.popularity ?? undefined,
      fetchedAt: Date.now(),
      related: (m.recommendations?.nodes ?? [])
        .map((n) => n.mediaRecommendation)
        .filter((r): r is AnilistMediaItem => Boolean(r))
        .map(toMedia),
    };
  });
}

/**
 * Per-episode titles, stills, synopses and air dates for an AniList entry. ani.zip maps AniList
 * ids to TheTVDB episode data; AniList's own streaming-episode thumbnails fill in when it has none.
 */
export async function animeEpisodes(key: string, seasonNumber = 1, expectedCount?: number, defaultRuntime?: number): Promise<Episode[]> {
  const id = Number(key.split(":")[1]);
  if (!id || !Number.isFinite(id)) return [];
  const rawList = await cached(`anilist:episodes:v2:${id}`, 12 * HOUR, async () => {
    const byNo = new Map<number, Episode>();
    try {
      const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${id}`);
      if (res.ok) {
        const j: { episodes?: Record<string, AniZipEpisode> } = await res.json();
        for (const [k, e] of Object.entries(j.episodes ?? {})) {
          const n = Number(k);
          if (!Number.isInteger(n) || n < 1) continue; // skip specials ("S1")
          byNo.set(n, {
            season: 1,
            number: n,
            title: e.title?.en || e.title?.["x-jat"] || `Episode ${n}`,
            overview: e.overview || e.summary || undefined,
            still: e.image || undefined,
            runtime: e.runtime || e.length || undefined,
            airDate: e.airDate || undefined,
          });
        }
      }
    } catch {
      /* fall through to AniList */
    }
    if (![...byNo.values()].some((e) => e.still)) {
      try {
        let streaming = peekCache<{ title?: string; thumbnail?: string }[]>(`${STREAMING_EPS_CACHE_PREFIX}${id}`, 12 * HOUR);
        if (!streaming) {
          const d = await gql<{ Media?: { streamingEpisodes?: { title?: string; thumbnail?: string }[] } }>(`query($id:Int){ Media(id:$id){ streamingEpisodes { title thumbnail } } }`, { id });
          streaming = d.Media?.streamingEpisodes ?? [];
          seedCache(`${STREAMING_EPS_CACHE_PREFIX}${id}`, streaming);
        }
        for (const s of streaming ?? []) {
          const m = String(s.title ?? "").match(/Episode\s+(\d+)\s*[-:]\s*(.*)/i);
          if (!m) continue;
          const n = Number(m[1]);
          const prev = byNo.get(n);
          byNo.set(n, {
            season: 1,
            number: n,
            title: prev?.title && !/^Episode \d+$/.test(prev.title) ? prev.title : m[2] || `Episode ${n}`,
            overview: prev?.overview,
            still: s.thumbnail || prev?.still,
            runtime: prev?.runtime,
            airDate: prev?.airDate,
          });
        }
      } catch {
        /* no episode data: callers fall back to numbered entries */
      }
    }
    return [...byNo.values()].sort((a, b) => a.number - b.number);
  });

  return normalizeEpisodes(rawList, seasonNumber, expectedCount, defaultRuntime, { key });
}
