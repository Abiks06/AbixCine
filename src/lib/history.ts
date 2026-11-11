import { useSyncExternalStore } from "react";
import { fetchSync, push, registerSync } from "./account";
import { isDone } from "./progress";
import type { Media } from "./types";

/**
 * Watch history: one record per title per episode (or per film), with where you stopped and
 * whether you finished it. Continue watching (progress.ts) only needs the latest episode per show;
 * this is the full record behind the episode list's watched marks and the History page.
 *
 * Stored on this PC and synced to the account (/history), newest write wins per episode.
 */
export interface WatchRecord {
  key: string;
  /** "movie", "e5" (anime, absolute) or "s2e5". */
  ep: string;
  media: Media;
  season?: number;
  episode?: number;
  position: number;
  duration: number;
  watched: boolean;
  /** Last time this was played or marked (ms). */
  at: number;
  /** Came from (or reached) the server, so a missing server row means it was removed elsewhere. */
  synced?: boolean;
}

export const epKey = (season?: number, episode?: number) => (episode == null ? "movie" : season != null ? `s${season}e${episode}` : `e${episode}`);

const KEY = "abx.history.v1";
const MAX = 5000;
const PUSH_EVERY_MS = 120_000;
const listeners = new Set<() => void>();
type Store = Record<string, Record<string, WatchRecord>>;

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
let store: Store = load();
let flat: WatchRecord[] | null = null;

function save() {
  flat = null;
  // Keep the newest MAX records.
  const all = list();
  if (all.length > MAX) {
    const keep = new Set(all.slice(0, MAX).map((r) => r.key + "|" + r.ep));
    const next: Store = {};
    for (const r of all) if (keep.has(r.key + "|" + r.ep)) (next[r.key] ??= {})[r.ep] = r;
    store = next;
    flat = null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function list(): WatchRecord[] {
  flat ??= Object.values(store)
    .flatMap((eps) => Object.values(eps))
    .sort((a, b) => b.at - a.at);
  return flat;
}

const slim = (m: Media): Media => ({ key: m.key, kind: m.kind, title: m.title, overview: "", year: m.year, poster: m.poster, backdrop: m.backdrop, genres: [], hue: m.hue });
const wire = (r: WatchRecord) => ({ ep: r.ep, season: r.season, episode: r.episode, position: Math.round(r.position), duration: Math.round(r.duration), watched: r.watched, at: r.at });
const lastPush = new Map<string, number>();

function pushRecords(key: string, media: Media, recs: WatchRecord[]) {
  if (key.startsWith("demo:") || !recs.length) return;
  // Big batches ("mark all 1,100 episodes watched") go in parts; each part keeps its own outbox slot.
  for (let i = 0; i < recs.length; i += 200) {
    const part = recs.slice(i, i + 200);
    const tag = recs.length > 200 ? `?part=${i / 200}` : part.length === 1 ? `?ep=${encodeURIComponent(part[0].ep)}` : "";
    push(`/history/${encodeURIComponent(key)}${tag}`, "PUT", { media: slim(media), entries: part.map(wire) });
  }
}

/** Called by the player with the playhead (every ~10s, on pause and on exit). */
export function recordWatch(e: { media: Media; season?: number; episode?: number; position: number; duration: number }) {
  if (!(e.duration > 0)) return;
  const ep = epKey(e.season, e.episode);
  const prev = store[e.media.key]?.[ep];
  const watched = (prev?.watched ?? false) || isDone(e.position, e.duration);
  const rec: WatchRecord = { key: e.media.key, ep, media: slim(e.media), season: e.season, episode: e.episode, position: e.position, duration: e.duration, watched, at: Date.now(), synced: prev?.synced };
  store = { ...store, [e.media.key]: { ...store[e.media.key], [ep]: rec } };
  save();
  // The server copy doesn't need every 10s tick: push the first one, finishing, and every 2 minutes.
  const id = e.media.key + "|" + ep;
  const due = !prev || watched !== prev.watched || Date.now() - (lastPush.get(id) ?? 0) > PUSH_EVERY_MS;
  if (due) {
    lastPush.set(id, Date.now());
    pushRecords(e.media.key, e.media, [rec]);
  }
}

/** Mark episodes (or a film) watched / not watched without playing them. */
export function setWatched(media: Media, eps: { season?: number; episode?: number; duration?: number }[], watched: boolean) {
  const now = Date.now();
  const cur = { ...store[media.key] };
  const changed: WatchRecord[] = [];
  for (const x of eps) {
    const ep = epKey(x.season, x.episode);
    const prev = cur[ep];
    const dur = prev?.duration || (x.duration ?? 0);
    const rec: WatchRecord = { key: media.key, ep, media: slim(media), season: x.season, episode: x.episode, position: watched ? dur : 0, duration: dur, watched, at: now, synced: prev?.synced };
    cur[ep] = rec;
    changed.push(rec);
  }
  store = { ...store, [media.key]: cur };
  save();
  pushRecords(media.key, media, changed);
}

/** Forget one episode, a whole title, or everything. */
export function removeHistory(key?: string, ep?: string) {
  if (!key) {
    store = {};
    save();
    push("/history", "DELETE");
    return;
  }
  if (ep) {
    const { [ep]: _gone, ...rest } = store[key] ?? {};
    store = { ...store, [key]: rest };
  } else {
    const { [key]: _gone, ...rest } = store;
    store = rest;
  }
  save();
  push(`/history/${encodeURIComponent(key)}${ep ? `?ep=${encodeURIComponent(ep)}` : ""}`, "DELETE");
}

export const getRecord = (key: string, season?: number, episode?: number): WatchRecord | undefined => store[key]?.[epKey(season, episode)];
export const isWatched = (key: string, season?: number, episode?: number) => !!getRecord(key, season, episode)?.watched;

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Every record for one title, by episode key. */
export function useTitleHistory(key: string): Record<string, WatchRecord> {
  const s = useSyncExternalStore(subscribe, () => store);
  return s[key] ?? EMPTY;
}
const EMPTY: Record<string, WatchRecord> = {};

/** Newest first. */
export function useHistory(): WatchRecord[] {
  useSyncExternalStore(subscribe, () => store);
  return list();
}

/** Merge rows from the server into ours, newest per episode wins. Exported for tests. */
export function mergeRemote(local: Store, remote: (Omit<WatchRecord, "synced"> & { key: string })[]): { merged: Store; pushBack: WatchRecord[] } {
  const merged: Store = {};
  const pushBack: WatchRecord[] = [];
  const seen = new Set<string>();
  for (const r of remote) {
    seen.add(r.key + "|" + r.ep);
    const mine = local[r.key]?.[r.ep];
    if (mine && mine.at > r.at) {
      (merged[r.key] ??= {})[r.ep] = { ...mine, synced: true };
      pushBack.push(mine);
    } else (merged[r.key] ??= {})[r.ep] = { ...r, synced: true };
  }
  for (const [key, eps] of Object.entries(local)) {
    for (const [ep, rec] of Object.entries(eps)) {
      if (seen.has(key + "|" + ep)) continue;
      // It reached the server before and is gone now: removed on another device.
      if (rec.synced) continue;
      (merged[key] ??= {})[ep] = rec;
      pushBack.push(rec);
    }
  }
  return { merged, pushBack };
}

registerSync({
  pull: () =>
    fetchSync()
      .then((s) => {
        if (!Array.isArray(s.history)) return;
        const { merged, pushBack } = mergeRemote(store, s.history);
        store = merged;
        save();
        const byKey = new Map<string, WatchRecord[]>();
        for (const r of pushBack) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
        byKey.forEach((recs, key) => pushRecords(key, recs[0].media, recs));
      })
      .catch(() => {}),
  clear: () => {
    store = {};
    save();
  },
});
