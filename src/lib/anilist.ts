import { cached } from "./cache";
import { demoDetail, demoList } from "./demo";
import { stripHtml } from "./format";
import type { Media, MediaDetail } from "./types";

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

export async function anilistDetail(key: string): Promise<MediaDetail> {
  if (key.startsWith("demo:")) return demoDetail(key);
  const id = Number(key.split(":")[1]);
  return cached(`anilist:detail:${id}`, 6 * HOUR, async () => {
    const d = await gql(
      `query($id:Int){ Media(id:$id,type:ANIME){ ${FIELDS} duration nextAiringEpisode { episode airingAt }
        trailer { id site }
        characters(perPage:12,sort:ROLE){ edges { role node { name { full } image { medium } } } }
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
      cast: m.characters.edges.map((e: any) => ({ name: e.node.name.full, character: e.role, photo: e.node.image?.medium })),
      related: m.recommendations.nodes.map((n: any) => n.mediaRecommendation).filter(Boolean).map(toMedia),
    };
  });
}
