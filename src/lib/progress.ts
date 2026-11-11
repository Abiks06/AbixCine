import { useSyncExternalStore } from "react";
import { fetchSync, push, registerSync } from "./account";
import type { Audio } from "./settings";
import type { Media } from "./types";

export interface ProgressEntry {
  media: Media;
  season?: number;
  episode?: number;
  audio?: Audio;
  position: number;
  duration: number;
  updatedAt: number;
}

const KEY = "abx.progress.v1";
const listeners = new Set<() => void>();

function load(): Record<string, ProgressEntry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
let store = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/** Keep only what the UI needs to redraw a card, so synced rows stay small. */
const slim = (m: Media): Media => ({
  key: m.key, kind: m.kind, title: m.title, originalTitle: m.originalTitle, overview: "", year: m.year,
  rating: m.rating, poster: m.poster, backdrop: m.backdrop, genres: [], hue: m.hue,
});

/** Progress is stored per title (latest episode wins), which is what "Continue watching" needs. */
export function saveProgress(e: Omit<ProgressEntry, "updatedAt">) {
  const done = e.duration > 0 && e.position / e.duration > 0.95;
  const entry: ProgressEntry = { ...e, media: slim(e.media), position: done ? 0 : e.position, updatedAt: Date.now() };
  store = { ...store, [e.media.key]: entry };
  save();
  push(`/progress/${encodeURIComponent(e.media.key)}`, "PUT", entry);
}

export function getProgress(mediaKey: string, season?: number, episode?: number) {
  const p = store[mediaKey];
  if (!p || p.season !== season || p.episode !== episode) return undefined;
  return p;
}

export function removeProgress(mediaKey: string) {
  const { [mediaKey]: gone, ...rest } = store;
  store = rest;
  save();
  push(`/progress/${encodeURIComponent(mediaKey)}`, "DELETE");
  return gone;
}

/** Put back an entry removed by mistake (the Undo on the toast). */
export function restoreProgress(entry: ProgressEntry) {
  store = { ...store, [entry.media.key]: entry };
  save();
  push(`/progress/${encodeURIComponent(entry.media.key)}`, "PUT", entry);
}

registerSync({
  // Merge: newest entry per title wins, whichever device it came from.
  pull: () =>
    fetchSync()
      .then((s) => {
        const next = { ...store };
        for (const r of s.progress as ProgressEntry[]) {
          const mine = next[r.media.key];
          if (!mine || mine.updatedAt < r.updatedAt) next[r.media.key] = r;
          else if (mine.updatedAt > r.updatedAt) push(`/progress/${encodeURIComponent(r.media.key)}`, "PUT", mine);
        }
        store = next;
        save();
      })
      .catch(() => {}),
  clear: () => {
    store = {};
    save();
  },
});

export function useContinueWatching(): ProgressEntry[] {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => store,
  );
  return Object.values(s)
    .filter((p) => p.position > 30)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
}
