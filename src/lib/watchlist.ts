import { useSyncExternalStore } from "react";
import { fetchSync, push, registerSync } from "./account";
import type { Media } from "./types";

interface Entry {
  media: Media;
  addedAt: number;
}

const KEY = "abx.watchlist.v1";
const listeners = new Set<() => void>();
let list: Entry[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
})();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export const inList = (key: string) => list.some((e) => e.media.key === key);
export const getWatchlistItems = () => list;

export function toggleList(m: Media) {
  if (inList(m.key)) {
    list = list.filter((e) => e.media.key !== m.key);
    push(`/watchlist/${encodeURIComponent(m.key)}`, "DELETE");
  } else {
    const media: Media = { key: m.key, kind: m.kind, title: m.title, overview: m.overview.slice(0, 300), year: m.year, rating: m.rating, poster: m.poster, backdrop: m.backdrop, genres: m.genres.slice(0, 3), hue: m.hue };
    list = [{ media, addedAt: Date.now() }, ...list];
    if (!m.key.startsWith("demo:")) push(`/watchlist/${encodeURIComponent(m.key)}`, "PUT", { media });
  }
  save();
}

registerSync({
  pull: () =>
    fetchSync()
      .then((s) => {
        const remote: Entry[] = s.watchlist;
        const keys = new Set(remote.map((e) => e.media.key));
        // Keep local-only items (e.g. added while offline) and push them up.
        const localOnly = list.filter((e) => !keys.has(e.media.key));
        localOnly.forEach((e) => !e.media.key.startsWith("demo:") && push(`/watchlist/${encodeURIComponent(e.media.key)}`, "PUT", { media: e.media }));
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
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => list,
  );
}
