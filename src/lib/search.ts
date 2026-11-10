import { searchAnime } from "./anilist";
import { searchTmdb } from "./tmdb";
import type { Media } from "./types";

/** Search both catalogs at once. Anime appears once, from AniList, never duplicated from TMDB. */
export async function searchAll(term: string): Promise<Media[]> {
  const [a, b] = await Promise.all([searchTmdb(term).catch(() => []), searchAnime(term)]);
  const aniTitles = new Set(b.flatMap((m) => [m.title.toLowerCase(), m.originalTitle?.toLowerCase()]).filter(Boolean));
  const tmdb = a.filter((m) => !(m.kind === "anime" && (aniTitles.has(m.title.toLowerCase()) || aniTitles.has(m.originalTitle?.toLowerCase() ?? ""))));
  return [...tmdb, ...b];
}
