import { useSyncExternalStore } from "react";
import { fetchSync, push, registerSync } from "./account";
import { toast } from "./toast";
import type { Media } from "./types";

interface Entry {
  media: Media;
  addedAt: number;
}

const KEY = "abx.watchlist.v1";
const listeners = new Set<() => void>();
let list: Entry[] = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((e) => e?.media?.key) : [];
  } catch {
    return [];
  }
})();
/** O(1) membership: a shelf of 40 cards must not scan the whole list 40 times per change. */
let keys = new Set(list.map((e) => e.media.key));

function save() {
  keys = new Set(list.map((e) => e.media.key));
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const inList = (key: string) => keys.has(key);

/**
 * Saves under the show's canonical key, so the same series reached through a sequel or a cour
 * (which has its own catalog key) toggles one entry instead of adding a duplicate.
 */
export function toggleList(m: Media & { canonicalKey?: string }, quiet = false) {
  const key = m.canonicalKey ?? m.key;
  const existing = inList(key) ? key : inList(m.key) ? m.key : null;
  if (existing) {
    list = list.filter((e) => e.media.key !== existing);
    push(`/watchlist/${encodeURIComponent(existing)}`, "DELETE");
    if (!quiet) toast(`Removed “${m.title}” from My List`, { icon: "bookmark", action: { label: "Undo", run: () => !inList(key) && toggleList(m, true) } });
  } else {
    const media: Media = {
      key,
      kind: m.kind,
      title: m.title,
      ...(m.originalTitle ? { originalTitle: m.originalTitle } : {}),
      ...(m.tmdbId != null ? { tmdbId: m.tmdbId } : {}),
      ...(m.anilistId != null ? { anilistId: m.anilistId } : {}),
      ...(m.malId != null ? { malId: m.malId } : {}),
      ...(m.originalLanguage ? { originalLanguage: m.originalLanguage } : {}),
      ...(m.format ? { format: m.format } : {}),
      overview: (m.overview ?? "").slice(0, 300),
      year: m.year,
      rating: m.rating,
      poster: m.poster,
      backdrop: m.backdrop,
      genres: (m.genres ?? []).slice(0, 3),
      hue: m.hue,
    };
    list = [{ media, addedAt: Date.now() }, ...list];
    push(`/watchlist/${encodeURIComponent(key)}`, "PUT", { media });
    if (!quiet) toast(`Added “${m.title}” to My List`, { icon: "check" });
  }
  save();
}

registerSync({
  pull: () =>
    fetchSync()
      .then((s) => {
        const remote: Entry[] = (Array.isArray(s.watchlist) ? s.watchlist : []).filter((e: Entry) => e?.media?.key);
        const remoteKeys = new Set(remote.map((e) => e.media.key));
        // Keep local-only items (e.g. added while offline) and push them up.
        const localOnly = list.filter((e) => !remoteKeys.has(e.media.key));
        localOnly.forEach((e) => push(`/watchlist/${encodeURIComponent(e.media.key)}`, "PUT", { media: e.media }));
        list = [...localOnly, ...remote].sort((a, b) => b.addedAt - a.addedAt);
        save();
      })
      .catch(() => {}),
  clear: () => {
    list = [];
    save();
  },
});

export function useWatchlist() {
  return useSyncExternalStore(subscribe, () => list);
}

/** Whether a title (under any of its keys) is saved. Re-renders only when that answer changes. */
export function useSaved(...candidates: (string | undefined)[]) {
  return useSyncExternalStore(subscribe, () => candidates.some((k) => !!k && keys.has(k)));
}
