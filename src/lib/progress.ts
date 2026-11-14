import { useMemo, useSyncExternalStore } from "react";
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
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // Drop rows a bad sync or an old build left without a title: every reader assumes `media.key`.
    return Object.fromEntries(Object.entries(raw as Record<string, ProgressEntry>).filter(([, e]) => e?.media?.key));
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

/** Keep what the UI and stream resolvers need (including malId and originalLanguage), so synced rows stay small without breaking resume. */
const slim = (m: Media & { canonicalKey?: string }): Media => ({
  key: m.canonicalKey ?? m.key,
  kind: m.kind,
  title: m.title,
  originalTitle: m.originalTitle,
  overview: "",
  year: m.year,
  rating: m.rating,
  poster: m.poster,
  backdrop: m.backdrop,
  genres: [],
  hue: m.hue,
  ...(m.malId ? { malId: m.malId } : {}),
  ...(m.originalLanguage ? { originalLanguage: m.originalLanguage } : {}),
  ...(m.format ? { format: m.format } : {}),
});

/**
 * Progress is stored per title (latest episode wins), which is what "Continue watching" needs.
 * Finishing an episode moves the entry on to `next`, so the show stays in Continue watching as "Up next".
 */
export function saveProgress(
  e: Omit<ProgressEntry, "updatedAt" | "upNext" | "finished"> & { media: Media & { canonicalKey?: string } },
  next?: { season?: number; episode: number } | null,
) {
  const canonicalKey = e.media.canonicalKey ?? e.media.key;
  const done = isDone(e.position, e.duration);
  const isSeries = canonicalKey.startsWith("tmdb:tv:") || e.media.kind === "tv";
  const isEpisodicAnime = (canonicalKey.startsWith("anilist:") || e.media.kind === "anime") && e.media.kind !== "movie";
  const base = {
    ...e,
    ...(isSeries && e.season == null ? { season: 1 } : {}),
    ...((isSeries || isEpisodicAnime) && e.episode == null ? { episode: 1 } : {}),
    media: slim(e.media),
    updatedAt: Date.now(),
  };
  const entry: ProgressEntry = !done
    ? base
    : next
      ? { ...base, season: next.season ?? base.season, episode: next.episode, position: 0, upNext: true }
      : { ...base, position: 0, finished: true };
  if (e.media.key !== canonicalKey && e.media.key in store) {
    const { [e.media.key]: _, ...rest } = store;
    store = { ...rest, [canonicalKey]: entry };
  } else {
    store = { ...store, [canonicalKey]: entry };
  }
  save();
  syncProgress(canonicalKey, entry, done);
}

/**
 * The position is saved locally every few seconds, but the server only needs it every half
 * minute: a PUT per tick was a request storm for one viewer. Milestones (an episode finishing,
 * moving to another episode) and leaving the page go up at once; anything else waits its turn.
 */
const SYNC_EVERY_MS = 30_000;
const lastSync = new Map<string, { at: number; season?: number; episode?: number }>();
const pendingSync = new Map<string, ReturnType<typeof setTimeout>>();

function syncProgress(key: string, entry: ProgressEntry, milestone: boolean) {
  const last = lastSync.get(key);
  const moved = !last || last.season !== entry.season || last.episode !== entry.episode;
  const due = !last || Date.now() - last.at >= SYNC_EVERY_MS;
  clearTimeout(pendingSync.get(key));
  pendingSync.delete(key);
  if (milestone || moved || due) {
    lastSync.set(key, { at: Date.now(), season: entry.season, episode: entry.episode });
    push(`/progress/${encodeURIComponent(key)}`, "PUT", entry);
    return;
  }
  pendingSync.set(
    key,
    setTimeout(() => flushProgressSync(key), Math.max(1000, SYNC_EVERY_MS - (Date.now() - last.at))),
  );
}

/** Send any position still waiting for its turn (pause, leaving the player, closing the app). */
export function flushProgressSync(only?: string) {
  for (const key of only ? [only] : [...pendingSync.keys()]) {
    clearTimeout(pendingSync.get(key));
    if (!pendingSync.delete(key)) continue;
    const entry = store[key];
    if (!entry) continue;
    lastSync.set(key, { at: Date.now(), season: entry.season, episode: entry.episode });
    push(`/progress/${encodeURIComponent(key)}`, "PUT", entry);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushProgressSync());
  document.addEventListener("visibilitychange", () => document.hidden && flushProgressSync());
}

export function getProgress(mediaKey: string, season?: number, episode?: number, fallbackKeys?: (string | undefined)[]) {
  const keys = [mediaKey, ...(fallbackKeys ?? [])];
  for (const k of keys) {
    if (!k) continue;
    const p = store[k];
    if (p && p.season === season && p.episode === episode) return p;
  }
  return undefined;
}

export function removeProgress(mediaKey: string) {
  const { [mediaKey]: gone, ...rest } = store;
  clearTimeout(pendingSync.get(mediaKey));
  pendingSync.delete(mediaKey);
  lastSync.delete(mediaKey);
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

/** The raw entry for a title, whatever its episode (Title page "Resume" / "Up next" button). */
export function getEntry(mediaKey: string, fallbackKeys?: (string | undefined)[]): ProgressEntry | undefined {
  const keys = [mediaKey, ...(fallbackKeys ?? [])];
  for (const k of keys) {
    if (!k) continue;
    const p = store[k];
    if (p && !p.finished) return p;
  }
  return undefined;
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
        for (const r of (Array.isArray(s.progress) ? s.progress : []) as ProgressEntry[]) {
          // A row saved without its title (an older client) can't be shown or resumed: skip it
          // rather than let one bad row abort the whole pull.
          if (!r?.media?.key) continue;
          const mine = next[r.media.key];
          if (!mine || mine.updatedAt < r.updatedAt) next[r.media.key] = r;
          else if (mine.updatedAt > r.updatedAt) push(`/progress/${encodeURIComponent(r.media.key)}`, "PUT", mine);
        }
        store = next;
        save();
      })
      .catch(() => {}),
  clear: () => {
    pendingSync.forEach((t) => clearTimeout(t));
    pendingSync.clear();
    lastSync.clear();
    store = {};
    save();
  },
});

/** Subscribe a component to every progress change (episode grids read many entries at once). */
export function useProgressStore() {
  return useSyncExternalStore(subscribe, () => store);
}

/**
 * The newest unfinished entry saved under any of a show's keys (its own, its canonical root, a
 * season's, a cour's). Reads the raw store: "Continue watching" hides entries under 30 seconds
 * and keeps only twenty, which made the title page forget a resume point it should have had.
 */
export function useMatchedProgress(keys: readonly (string | undefined)[]): ProgressEntry | undefined {
  const s = useSyncExternalStore(subscribe, () => store);
  const sig = keys.filter(Boolean).join("|");
  return useMemo(() => {
    let best: ProgressEntry | undefined;
    for (const k of sig ? sig.split("|") : []) {
      const p = s[k];
      if (p && !p.finished && (!best || p.updatedAt > best.updatedAt)) best = p;
    }
    return best;
  }, [s, sig]);
}

export function useContinueWatching(): ProgressEntry[] {
  const s = useSyncExternalStore(subscribe, () => store);
  return useMemo(
    () =>
      Object.values(s)
        .filter((p) => !p.finished && (p.position > 30 || p.upNext))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20),
    [s],
  );
}
