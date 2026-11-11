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
  /** The previous episode finished; this entry points at the one after it, from the start. */
  upNext?: boolean;
  /** Watched to the end with nothing after it. */
  finished?: boolean;
}

/**
 * "Done" is 95% for films, but short episodes end with 90–120s of credits and preview,
 * so anything under an hour counts once you're within two minutes of the end (and past 85%).
 */
export function isDone(position: number, duration: number) {
  if (!(duration > 0)) return false;
  const f = position / duration;
  return f > 0.95 || (duration < 3600 && duration - position < 120 && f > 0.85);
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

/**
 * Progress is stored per title (latest episode wins), which is what "Continue watching" needs.
 * Finishing an episode moves the entry on to `next`, so the show stays in Continue watching as "Up next".
 */
export function saveProgress(e: Omit<ProgressEntry, "updatedAt" | "upNext" | "finished">, next?: { season?: number; episode: number; media?: Media } | null) {
  const done = isDone(e.position, e.duration);
  const base = { ...e, media: slim(e.media), updatedAt: Date.now() };
  // The next episode lives in another entry (anime: season 2 is its own AniList title):
  // this one is finished, and the next title shows up in Continue watching as "Up next".
  const elsewhere = done && next?.media && next.media.key !== e.media.key ? next.media : null;
  const entry: ProgressEntry = !done
    ? base
    : next && !elsewhere
      ? { ...base, season: next.season, episode: next.episode, position: 0, upNext: true }
      : { ...base, position: 0, finished: true };
  write(entry);
  if (elsewhere && next) {
    const existing = store[elsewhere.key];
    if (!existing || existing.finished) write({ media: slim(elsewhere), season: next.season, episode: next.episode, audio: e.audio, position: 0, duration: 0, updatedAt: Date.now() + 1, upNext: true });
  }
}

function write(entry: ProgressEntry) {
  store = { ...store, [entry.media.key]: entry };
  save();
  if (!entry.media.key.startsWith("demo:")) push(`/progress/${encodeURIComponent(entry.media.key)}`, "PUT", entry);
}

/**
 * A finished show got a new episode (or season): put it back in Continue watching as "Up next".
 * Called by the new-episode alerts. Returns true if the entry changed.
 */
export function reviveFinished(mediaKey: string, next: { season?: number; episode: number }) {
  const p = store[mediaKey];
  if (!p || !p.finished) return false;
  write({ ...p, season: next.season, episode: next.episode, position: 0, duration: 0, finished: false, upNext: true, updatedAt: Date.now() });
  return true;
}

/** Every saved entry (finished ones too), for the alerts and history pages. */
export const allProgress = () => store;

export function getProgress(mediaKey: string, season?: number, episode?: number) {
  const p = store[mediaKey];
  if (!p || p.season !== season || p.episode !== episode) return undefined;
  return p;
}

/** The raw entry for a title, whatever its episode (Title page "Resume" / "Up next" button). */
export function getEntry(mediaKey: string): ProgressEntry | undefined {
  const p = store[mediaKey];
  return p && !p.finished ? p : undefined;
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useProgressEntry(mediaKey: string) {
  const s = useSyncExternalStore(subscribe, () => store);
  const p = s[mediaKey];
  return p && !p.finished ? p : undefined;
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
  const s = useSyncExternalStore(subscribe, () => store);
  return Object.values(s)
    .filter((p) => !p.finished && (p.position > 30 || p.upNext))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
}
