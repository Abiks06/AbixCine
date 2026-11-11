import { cached } from "./cache";
import { demoDetail, demoList } from "./demo";
import { stripHtml } from "./format";
import { animeIds } from "./idmap";
import type { FranchiseEntry, Media, MediaDetail } from "./types";

// AniList's public GraphQL API needs no key (rate limit ~90 req/min).
const API = "https://graphql.anilist.co";
const HOUR = 3600_000;

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error(j.errors[0]?.message ?? "AniList error");
  return j.data;
}

const FIELDS = `id title { romaji english native } description(asHtml: false) seasonYear averageScore genres
  coverImage { extraLarge color } bannerImage episodes format status`;

function toMedia(m: any): Media {
  return {
    key: `anilist:${m.id}`,
    kind: "anime",
    title: m.title.english || m.title.romaji,
    originalTitle: m.title.romaji,
    overview: stripHtml(m.description ?? ""),
    year: m.seasonYear ?? undefined,
    rating: m.averageScore ? m.averageScore / 10 : undefined,
    poster: m.coverImage?.extraLarge,
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

export async function loadAnimeFeed(f: (typeof ANIME_FEEDS)[number], i: number): Promise<Media[]> {
  const airing = "airing" in f && f.airing;
  try {
    return await cached(`anilist:feed:${f.id}`, 3 * HOUR, async () => {
      const { season, year } = currentSeason();
      const d = await gql(
        `query($sort:[MediaSort],$season:MediaSeason,$year:Int){ Page(perPage:24){ media(type:ANIME,sort:$sort,isAdult:false,season:$season,seasonYear:$year){ ${FIELDS} } } }`,
        { sort: [f.sort], ...(airing ? { season, year } : {}) },
      );
      return d.Page.media.map(toMedia);
    });
  } catch {
    return demoList("anime", 40 + i);
  }
}

export async function searchAnime(q: string): Promise<Media[]> {
  try {
    const d = await gql(`query($q:String){ Page(perPage:20){ media(type:ANIME,search:$q,isAdult:false,sort:SEARCH_MATCH){ ${FIELDS} } } }`, { q });
    return d.Page.media.map(toMedia);
  } catch {
    return [];
  }
}

const STAFF_ROLE = /^(Director|Original Creator|Original Story|Series Composition|Music|Character Design|Script|Chief Director|Animation Director)/;
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const isoDate = (d?: { year?: number; month?: number; day?: number }) =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}` : undefined;

/** Formats that count as a "season" of a show (films, OVAs and specials are side stories). */
const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const REL_FIELDS = `id type format status episodes seasonYear title { romaji english } coverImage { extraLarge }`;

function toEntry(n: any): FranchiseEntry {
  return {
    key: `anilist:${n.id}`,
    title: n.title?.english || n.title?.romaji,
    year: n.seasonYear ?? undefined,
    format: n.format ?? undefined,
    episodes: n.episodes ?? undefined,
    status: n.status ?? undefined,
    poster: n.coverImage?.extraLarge,
    unreleased: n.status === "NOT_YET_RELEASED" || n.status === "CANCELLED",
  };
}

/** The previous and next season among an entry's relations (ignoring films, recaps and spin-offs). */
export function relatedSeasons(edges: any[]): { prequel?: FranchiseEntry; sequel?: FranchiseEntry } {
  const pick = (type: string) => edges.find((e) => e.relationType === type && e.node?.type === "ANIME" && SEASON_FORMATS.has(e.node.format))?.node;
  const p = pick("PREQUEL");
  const n = pick("SEQUEL");
  return { prequel: p ? toEntry(p) : undefined, sequel: n ? toEntry(n) : undefined };
}

/**
 * The whole season chain an entry belongs to, first season first: walks PREQUEL links back and
 * SEQUEL links forward (8 hops each way at most, one cached request per hop).
 */
export async function animeSeasons(key: string): Promise<FranchiseEntry[]> {
  if (!key.startsWith("anilist:")) return [];
  const id = Number(key.split(":")[1]);
  return cached(`anilist:chain:v1:${id}`, 24 * HOUR, async () => {
    const hop = (n: number) =>
      cached(`anilist:rel:v1:${n}`, 24 * HOUR, async () => {
        const d = await gql(`query($id:Int){ Media(id:$id,type:ANIME){ ${REL_FIELDS} relations { edges { relationType(version:2) node { ${REL_FIELDS} } } } } }`, { id: n });
        return { self: toEntry(d.Media), ...relatedSeasons(d.Media.relations?.edges ?? []) };
      });
    const me = await hop(id);
    const before: FranchiseEntry[] = [];
    const after: FranchiseEntry[] = [];
    const seen = new Set([me.self.key]);
    let p = me.prequel;
    for (let i = 0; p && i < 8 && !seen.has(p.key); i++) {
      seen.add(p.key);
      before.unshift(p);
      p = (await hop(Number(p.key.split(":")[1]))).prequel;
    }
    let n = me.sequel;
    for (let i = 0; n && i < 8 && !seen.has(n.key); i++) {
      seen.add(n.key);
      after.push(n);
      n = (await hop(Number(n.key.split(":")[1]))).sequel;
    }
    return [...before, me.self, ...after];
  });
}

/**
 * Where an AniList entry sits in its show, for matching files organised by season: the season
 * number (TVDB's, when the ID map knows it, else its place in the chain) and how many episodes
 * came before it (for libraries that number episodes straight through).
 */
export async function seasonPlacement(key: string): Promise<{ season: number; before: number; rootTitles: string[] } | null> {
  if (!key.startsWith("anilist:")) return null;
  try {
    const [chain, map] = await Promise.all([animeSeasons(key), animeIds(Number(key.split(":")[1]))]);
    const i = chain.findIndex((c) => c.key === key);
    if (i < 0) return null;
    const tvdbSeason = map?.season?.tvdb;
    const season = tvdbSeason && tvdbSeason > 0 ? tvdbSeason : i + 1;
    const before = chain.slice(0, i).reduce((n, c) => n + (c.episodes ?? 0), 0);
    return { season, before, rootTitles: chain[0] ? [chain[0].title] : [] };
  } catch {
    return null;
  }
}

export async function anilistDetail(key: string): Promise<MediaDetail> {
  if (key.startsWith("demo:")) return demoDetail(key);
  const id = Number(key.split(":")[1]);
  return cached(`anilist:detail:v3:${id}`, 3 * HOUR, async () => {
    const d = await gql(
      `query($id:Int){ Media(id:$id,type:ANIME){ ${FIELDS} idMal synonyms duration nextAiringEpisode { episode airingAt }
        relations { edges { relationType(version:2) node { ${REL_FIELDS} } } }
        trailer { id site }
        source season seasonYear startDate { year month day } endDate { year month day } popularity
        studios(isMain:true){ nodes { name } }
        staff(perPage:12,sort:RELEVANCE){ edges { role node { name { full } image { medium } } } }
        characters(perPage:16,sort:[ROLE,RELEVANCE]){ edges { role node { name { full } image { medium } } voiceActors(language:JAPANESE,sort:RELEVANCE){ name { full } } } }
        recommendations(perPage:14,sort:RATING_DESC){ nodes { mediaRecommendation { ${FIELDS} } } } } }`,
      { id },
    );
    const m = d.Media;
    const rel = relatedSeasons(m.relations?.edges ?? []);
    const map = await animeIds(id);
    return {
      ...toMedia(m),
      ids: {
        anilist: id,
        mal: m.idMal ?? map?.mal ?? undefined,
        tmdb: map?.tmdbTv ?? map?.tmdbMovie ?? undefined,
        tmdbKind: map?.tmdbTv ? "tv" : map?.tmdbMovie ? "movie" : undefined,
        tvdb: map?.tvdb ?? undefined,
        imdb: map?.imdb ?? undefined,
      },
      altTitles: [m.title.english, m.title.romaji, ...(m.synonyms ?? [])].filter((t: unknown): t is string => typeof t === "string" && /^[\x20-\u024f]+$/.test(t)).slice(0, 8),
      prequel: rel.prequel,
      sequel: rel.sequel,
      runtime: m.duration,
      status: m.status,
      episodeCount: m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : undefined),
      nextAiring: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt * 1000 } : undefined,
      trailerYouTubeId: m.trailer?.site === "youtube" ? m.trailer.id : undefined,
      cast: m.characters.edges.map((e: any) => ({
        name: e.node.name.full,
        character: e.role ? e.role[0] + e.role.slice(1).toLowerCase() : undefined,
        photo: e.node.image?.medium,
        actor: e.voiceActors?.[0]?.name?.full,
      })),
      crew: (m.staff?.edges ?? [])
        .filter((e: any) => STAFF_ROLE.test(e.role ?? ""))
        .map((e: any) => ({ name: e.node.name.full, job: (e.role as string).replace(/\s*\(.*\)$/, ""), photo: e.node.image?.medium })),
      companies: m.studios?.nodes?.map((n: any) => n.name) ?? [],
      releaseDate: isoDate(m.startDate),
      endDate: isoDate(m.endDate),
      source: m.source ? titleCase(m.source) : undefined,
      seasonLabel: m.season && m.seasonYear ? `${titleCase(m.season)} ${m.seasonYear}` : undefined,
      format: m.format ? (m.format.length <= 3 ? m.format : titleCase(m.format)) : undefined,
      originalLanguage: "ja",
      voteCount: m.popularity ?? undefined,
      fetchedAt: Date.now(),
      related: m.recommendations.nodes.map((n: any) => n.mediaRecommendation).filter(Boolean).map(toMedia),
    };
  });
}
