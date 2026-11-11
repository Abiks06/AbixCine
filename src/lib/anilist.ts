import { cached } from "./cache";
import { stripHtml } from "./format";
import type { Episode, Media, MediaDetail } from "./types";

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

const FIELDS = `id idMal title { romaji english native } description(asHtml: false) seasonYear averageScore genres
  coverImage { extraLarge color } bannerImage episodes format status`;

function toMedia(m: any): Media {
  return {
    key: `anilist:${m.id}`,
    kind: "anime",
    malId: m.idMal ?? undefined,
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

export async function loadAnimeFeed(f: (typeof ANIME_FEEDS)[number], _i?: number): Promise<Media[]> {
  const airing = "airing" in f && f.airing;
  return cached(`anilist:feed:${f.id}`, 3 * HOUR, async () => {
      const { season, year } = currentSeason();
      const d = await gql(
        `query($sort:[MediaSort],$season:MediaSeason,$year:Int){ Page(perPage:24){ media(type:ANIME,sort:$sort,isAdult:false,season:$season,seasonYear:$year){ ${FIELDS} } } }`,
        { sort: [f.sort], ...(airing ? { season, year } : {}) },
      );
      return d.Page.media.map(toMedia);
    });
}

/** Formats that make up a series' seasons (movies, OVAs and specials stay separate titles). */
const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const isSeasonLink = (rel: string, format?: string | null) => (rel === "SEQUEL" || rel === "PREQUEL") && !!format && SEASON_FORMATS.has(format);

/** Strip season markers so "My Hero Academia Season 3" groups with "My Hero Academia". */
export function baseTitle(t: string) {
  return t
    .toLowerCase()
    .replace(/[:\-–]\s*(part|cour)\s*\d+.*$/i, "")
    .replace(/\b(season|cour|part)\s*\d+\b.*$/i, "")
    .replace(/\b\d+(st|nd|rd|th)\s+season\b.*$/i, "")
    .replace(/\b(final|second|third|fourth|fifth|sixth|seventh)\s+season\b.*$/i, "")
    .replace(/\s+(ii|iii|iv|v|vi)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Search, with every series' seasons folded into one result. Seasons are joined when AniList
 * links them as prequel/sequel within the results, or share a base title; the earliest one
 * stands for the show and the title page offers the season picker.
 */
export async function searchAnime(q: string): Promise<Media[]> {
  try {
    const d = await gql(
      `query($q:String){ Page(perPage:25){ media(type:ANIME,search:$q,isAdult:false,sort:SEARCH_MATCH){ ${FIELDS} startDate { year month } relations { edges { relationType node { id format } } } } } }`,
      { q },
    );
    const list: any[] = d.Page.media;
    const parent = new Map<number, number>(list.map((m) => [m.id, m.id]));
    const find = (x: number): number => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    const union = (a: number, b: number) => parent.set(find(a), find(b));
    const byBase = new Map<string, number>();
    for (const m of list) {
      if (!SEASON_FORMATS.has(m.format)) continue;
      for (const e of m.relations?.edges ?? []) if (parent.has(e.node.id) && isSeasonLink(e.relationType, e.node.format)) union(m.id, e.node.id);
      const base = baseTitle(m.title.english || m.title.romaji || "");
      if (!base) continue;
      if (byBase.has(base)) union(m.id, byBase.get(base)!);
      else byBase.set(base, m.id);
    }
    // Keep each group once, at the position of its best-ranked member, represented by its earliest season.
    const order = (m: any) => (m.startDate?.year ?? m.seasonYear ?? 9999) * 12 + (m.startDate?.month ?? 0);
    const groups = new Map<number, any[]>();
    for (const m of list) {
      const root = SEASON_FORMATS.has(m.format) ? find(m.id) : m.id;
      groups.set(root, [...(groups.get(root) ?? []), m]);
    }
    const seen = new Set<number>();
    const out: Media[] = [];
    for (const m of list) {
      const root = SEASON_FORMATS.has(m.format) ? find(m.id) : m.id;
      if (seen.has(root)) continue;
      seen.add(root);
      const members = groups.get(root)!;
      const first = [...members].sort((x, y) => order(x) - order(y))[0];
      out.push({ ...toMedia(first), seasonCount: members.length > 1 ? members.length : undefined });
    }
    return out;
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

/**
 * Every season of the series an AniList entry belongs to, in airing order. Follows prequel /
 * sequel links between TV/ONA entries, four hops per request, then fetches all seasons' details
 * in one batch. A one-season show returns a single entry.
 */
export async function animeSeasons(key: string): Promise<AnimeSeason[]> {
  const start = Number(key.split(":")[1]);
  if (!start) return [];
  return cached(`anilist:seasons:v1:${start}`, 24 * HOUR, async () => {
    const ids = new Set<number>([start]);
    let frontier = [start];
    for (let round = 0; round < 6 && frontier.length; round++) {
      const d = await gql(`query($ids:[Int]){ Page(perPage:50){ media(id_in:$ids,type:ANIME){ id format ${relQuery(4)} } } }`, { ids: frontier });
      const next: number[] = [];
      const walk = (node: any) => {
        for (const e of node.relations?.edges ?? []) {
          if (!isSeasonLink(e.relationType, e.node.format)) continue;
          if (!ids.has(e.node.id)) {
            ids.add(e.node.id);
            next.push(e.node.id);
          }
          walk(e.node);
        }
      };
      for (const m of d.Page.media) walk(m);
      // Nodes found at the deepest level may have links beyond it: explore from them next round.
      frontier = next;
      if (ids.size > 40) break; // long-runners split into many cours; that's plenty
    }
    const d = await gql(
      `query($ids:[Int]){ Page(perPage:50){ media(id_in:$ids,type:ANIME){ id idMal format episodes seasonYear startDate { year month day } title { romaji english } nextAiringEpisode { episode } } } }`,
      { ids: [...ids] },
    );
    const list = (d.Page.media as any[])
      .filter((m) => SEASON_FORMATS.has(m.format) || m.id === start)
      .sort((a, b) => {
        const k = (m: any) => (m.startDate?.year ?? 9999) * 10000 + (m.startDate?.month ?? 0) * 100 + (m.startDate?.day ?? 0);
        return k(a) - k(b);
      });
    return list.map((m, i) => ({
      key: `anilist:${m.id}`,
      id: m.id,
      malId: m.idMal ?? undefined,
      title: m.title.english || m.title.romaji,
      episodes: m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : undefined),
      year: m.seasonYear ?? m.startDate?.year ?? undefined,
      label: `Season ${i + 1}`,
    }));
  });
}

const STAFF_ROLE = /^(Director|Original Creator|Original Story|Series Composition|Music|Character Design|Script|Chief Director|Animation Director)/;
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const isoDate = (d?: { year?: number; month?: number; day?: number }) =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}` : undefined;

export async function anilistDetail(key: string): Promise<MediaDetail> {
  const id = Number(key.split(":")[1]);
  return cached(`anilist:detail:v3:${id}`, 3 * HOUR, async () => {
    const d = await gql(
      `query($id:Int){ Media(id:$id,type:ANIME){ ${FIELDS} duration nextAiringEpisode { episode airingAt }
        trailer { id site }
        source season seasonYear startDate { year month day } endDate { year month day } popularity
        studios(isMain:true){ nodes { name } }
        staff(perPage:12,sort:RELEVANCE){ edges { role node { name { full } image { medium } } } }
        characters(perPage:16,sort:[ROLE,RELEVANCE]){ edges { role node { name { full } image { medium } } voiceActors(language:JAPANESE,sort:RELEVANCE){ name { full } } } }
        recommendations(perPage:14,sort:RATING_DESC){ nodes { mediaRecommendation { ${FIELDS} } } } } }`,
      { id },
    );
    const m = d.Media;
    return {
      ...toMedia(m),
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

/**
 * Per-episode titles, stills, synopses and air dates for an AniList entry. ani.zip maps AniList
 * ids to TheTVDB episode data; AniList's own streaming-episode thumbnails fill in when it has none.
 */
export async function animeEpisodes(key: string): Promise<Episode[]> {
  const id = Number(key.split(":")[1]);
  if (!id) return [];
  return cached(`anilist:episodes:v1:${id}`, 12 * HOUR, async () => {
    const byNo = new Map<number, Episode>();
    try {
      const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${id}`);
      if (res.ok) {
        const j = await res.json();
        for (const [k, e] of Object.entries<any>(j.episodes ?? {})) {
          const n = Number(k);
          if (!Number.isInteger(n) || n < 1) continue; // skip specials ("S1")
          byNo.set(n, {
            season: 0,
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
        const d = await gql(`query($id:Int){ Media(id:$id){ streamingEpisodes { title thumbnail } } }`, { id });
        for (const s of d.Media?.streamingEpisodes ?? []) {
          const m = String(s.title ?? "").match(/Episode\s+(\d+)\s*[-:]\s*(.*)/i);
          if (!m) continue;
          const n = Number(m[1]);
          const prev = byNo.get(n);
          byNo.set(n, { season: 0, number: n, title: prev?.title && !/^Episode \d+$/.test(prev.title) ? prev.title : m[2] || `Episode ${n}`, overview: prev?.overview, still: s.thumbnail || prev?.still, runtime: prev?.runtime, airDate: prev?.airDate });
        }
      } catch {
        /* no episode data: callers fall back to numbered entries */
      }
    }
    return [...byNo.values()].sort((a, b) => a.number - b.number);
  });
}
