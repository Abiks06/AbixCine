import { anilistDetail } from "./anilist";
import { tmdbDetail } from "./tmdb";
import type { MediaDetail } from "./types";

/** Route a media key to whichever catalog owns it. */
export function getDetail(key: string): Promise<MediaDetail> {
  if (key.startsWith("anilist:")) return anilistDetail(key);
  return tmdbDetail(key);
}

export const encodeKey = (k: string) => encodeURIComponent(k);
export const decodeKey = (k: string) => decodeURIComponent(k);
