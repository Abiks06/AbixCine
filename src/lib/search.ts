import { searchAnime } from "./anilist";
import { tmdbToAnilist } from "./idmap";
import { searchTmdb } from "./tmdb";
import type { Media } from "./types";

/**
 * Search both catalogs at once. Anime appears once, from AniList (Sub/Dub, AniSkip, seasons),
 * never duplicated from TMDB: a TMDB result is dropped when the ID map says AniList has it, or
 * (offline map) when the titles are the same.
 */
export async function searchAll(term: string): Promise<Media[]> {
  const [a, b] = await Promise.all([searchTmdb(term).catch(() => []), searchAnime(term)]);
  return [...(await dropAnimeDuplicates(a, b)), ...b];
}

export async function dropAnimeDuplicates(tmdb: Media[], anilist: Media[]): Promise<Media[]> {
  const aniTitles = new Set(anilist.flatMap((m) => [m.title.toLowerCase(), m.originalTitle?.toLowerCase()]).filter(Boolean));
  const aniKeys = new Set(anilist.map((m) => m.key));
  const tvIds = tmdb.filter((m) => m.kind === "anime" && m.key.startsWith("tmdb:tv:")).map((m) => Number(m.key.split(":")[2]));
  const map = tvIds.length ? await tmdbToAnilist("tv", tvIds) : {};
  return tmdb.filter((m) => {
    if (m.kind !== "anime") return true;
    const ids = map[Number(m.key.split(":")[2])];
    // Mapped: it's on AniList. Keep it only if this search didn't bring the AniList entry (the title page forwards it).
    if (ids?.length) return !ids.some((x) => aniKeys.has(`anilist:${x.anilist}`));
    return !(aniTitles.has(m.title.toLowerCase()) || aniTitles.has(m.originalTitle?.toLowerCase() ?? ""));
  });
}
