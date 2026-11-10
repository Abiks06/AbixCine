import { encodeKey } from "./catalog";
import { getEntry } from "./progress";
import { audioFor, type Audio } from "./settings";
import type { Media } from "./types";

/** One place that builds /watch links, so every Play button carries episode and sub/dub. */
export function watchHref(key: string, s?: number, e?: number, a?: Audio) {
  const qs = new URLSearchParams({ ...(s != null ? { s: String(s) } : {}), ...(e != null ? { e: String(e) } : {}), ...(a ? { a } : {}) });
  return `/watch/${encodeKey(key)}${qs.size ? `?${qs}` : ""}`;
}

const isAnime = (m: Pick<Media, "key" | "kind">) => m.key.startsWith("anilist:") || m.kind === "anime";

/**
 * What a bare "Play" on a title should start: the saved resume / up-next point, else the first
 * episode of a series, else the film. Anime always carries the viewer's sub/dub choice.
 */
export function playTarget(m: Pick<Media, "key" | "kind">): { s?: number; e?: number; a?: Audio } {
  const p = getEntry(m.key);
  const a = isAnime(m) ? p?.audio ?? audioFor(m.key) : undefined;
  if (p) return { s: p.season, e: p.episode, a };
  if (m.key.startsWith("tmdb:tv:")) return { s: 1, e: 1, a };
  if (m.key.startsWith("anilist:")) return { e: 1, a };
  return { a };
}

export function playHref(m: Pick<Media, "key" | "kind">) {
  const t = playTarget(m);
  return watchHref(m.key, t.s, t.e, t.a);
}
