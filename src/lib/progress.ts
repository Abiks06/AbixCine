import { useMemo, useSyncExternalStore } from "react";
import { fetchSync, push, registerSync } from "./account";
import type { Audio } from "./settings";
import type { Media } from "./types";
import { isFilm } from "./types";

/** Unified minimum seconds before an episode/film surfaces as "Resume". */
export const RESUME_MIN_SEC = 15;
const MAX_EPISODES_PER_TITLE = 2500;

export interface EpisodeProgress {
  season?: number;
  episode?: number;
  audio?: Audio;
  position: number;
  duration: number;
  updatedAt: number;
  completed?: boolean;
}

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
  /** Ongoing series where every currently aired episode has been finished. */
  caughtUp?: boolean;
  /** Watched to the end with nothing after it (films or ended series). */
  finished?: boolean;
  /** Per-episode watch state keyed by `epKey(season, episode)`, e.g. "s1:e3" or "main". */
  episodes?: Record<string, EpisodeProgress>;
  schemaVersion?: 2;
}

/**
 * Canonical episode slot key: "main" for films, "s<season>:e<episode>" for series/anime.
 * Episodic entries without an explicit season use season 0 when unset on the input so anime
 * keys remain distinguishable from TMDB seasons while lookups also check s1 fallback cleanly.
 */
export function epKey(season?: number, episode?: number): string {
  if (season == null && episode == null) return "main";
  return `s${season ?? 0}:e${episode ?? 1}`;
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

function sanitizeEpisodesMap(raw: unknown): Record<string, EpisodeProgress> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, EpisodeProgress> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^(main|s\d+:e\d+)$/.test(k) || !v || typeof v !== "object") continue;
    const ep = v as Record<string, unknown>;
    const position = typeof ep.position === "number" && Number.isFinite(ep.position) && ep.position >= 0 ? ep.position : 0;
    const duration = typeof ep.duration === "number" && Number.isFinite(ep.duration) && ep.duration >= 0 ? ep.duration : 0;
    const updatedAt = typeof ep.updatedAt === "number" && Number.isFinite(ep.updatedAt) ? ep.updatedAt : 0;
    out[k] = {
      ...(typeof ep.season === "number" && Number.isInteger(ep.season) && ep.season >= 0 ? { season: ep.season } : {}),
      ...(typeof ep.episode === "number" && Number.isInteger(ep.episode) && ep.episode >= 0 ? { episode: ep.episode } : {}),
      ...(ep.audio === "sub" || ep.audio === "dub" ? { audio: ep.audio } : {}),
      position,
      duration,
      updatedAt,
      ...(ep.completed === true ? { completed: true } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Synthesize the legacy top-level cursor into `episodes` if missing (v1 -> v2 upgrade). */
function seedLegacyEpisode(entry: ProgressEntry): Record<string, EpisodeProgress> {
  const existing = entry.episodes ? { ...entry.episodes } : {};
  // Skip when the entry only holds an untouched upNext pointer from v1.
  if (entry.upNext && entry.position <= 0) return existing;
  if (entry.position > 0 || entry.finished || entry.caughtUp) {
    const k = epKey(entry.season, entry.episode);
    if (!existing[k] && (entry.position > 0 || entry.finished || entry.caughtUp)) {
      existing[k] = {
        ...(entry.season != null ? { season: entry.season } : {}),
        ...(entry.episode != null ? { episode: entry.episode } : {}),
        ...(entry.audio ? { audio: entry.audio } : {}),
        position: entry.position,
        duration: entry.duration,
        updatedAt: entry.updatedAt,
        ...(entry.finished || entry.caughtUp || isDone(entry.position, entry.duration) ? { completed: true } : {}),
      };
    }
  }
  return existing;
}

function unionEpisodes(
  a: Record<string, EpisodeProgress> | undefined,
  b: Record<string, EpisodeProgress> | undefined,
): Record<string, EpisodeProgress> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, EpisodeProgress> = { ...(a ?? {}) };
  for (const [k, ep] of Object.entries(b ?? {})) {
    const cur = out[k];
    if (!cur || ep.updatedAt > cur.updatedAt) {
      out[k] = {
        ...ep,
        // Completion shouldn't regress when merging older partial metadata with equal/newer intent
        ...(cur?.completed && ep.updatedAt === cur.updatedAt ? { completed: true } : {}),
      };
    }
  }
  const entries = Object.entries(out);
  if (entries.length > MAX_EPISODES_PER_TITLE) {
    entries.sort((x, y) => y[1].updatedAt - x[1].updatedAt);
    return Object.fromEntries(entries.slice(0, MAX_EPISODES_PER_TITLE));
  }
  return entries.length ? out : undefined;
}

function load(): Record<string, ProgressEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // Drop rows a bad sync or an old build left without a title: every reader assumes `media.key`.
    return Object.fromEntries(
      Object.entries(raw as Record<string, ProgressEntry>)
        .filter(([, e]) => e?.media?.key)
        .map(([k, e]) => [k, { ...e, ...(e.episodes ? { episodes: sanitizeEpisodesMap(e.episodes) } : {}) }]),
    );
  } catch {
    return {};
  }
}
let store = load();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(persistNow, 1500);
}

function save(immediate = false) {
  if (immediate) persistNow();
  else schedulePersist();
  listeners.forEach((l) => l());
}

/** Keep what the UI and stream resolvers need (including malId, airing, and format), so synced rows stay small without breaking resume or countdowns. */
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
  genres: (m.genres ?? []).slice(0, 3),
  hue: m.hue,
  ...(m.malId ? { malId: m.malId } : {}),
  ...(m.tmdbId != null ? { tmdbId: m.tmdbId } : {}),
  ...(m.anilistId != null ? { anilistId: m.anilistId } : {}),
  ...(m.originalLanguage ? { originalLanguage: m.originalLanguage } : {}),
  ...(m.format ? { format: m.format } : {}),
  ...(m.status ? { status: m.status } : {}),
  ...(m.episodeCount != null ? { episodeCount: m.episodeCount } : {}),
  ...(m.runtime != null ? { runtime: m.runtime } : {}),
  ...(m.releaseDate ? { releaseDate: m.releaseDate } : {}),
  ...(m.nextAiring ? { nextAiring: m.nextAiring } : {}),
});

/** True if media metadata indicates an ongoing/airing series rather than a finished run or film. */
export function isOngoingMedia(m: Pick<Media, "kind" | "format" | "status" | "nextAiring">): boolean {
  if (isFilm(m)) return false;
  if (m.nextAiring) return true;
  return /airing|releasing|returning|production/i.test(m.status ?? "");
}

/**
 * Progress is stored per title AND per episode:
 * - `episodes[epKey]` retains exact per-episode timestamps & watched flags so switching episodes
 *   or revisiting an earlier episode never wipes its position.
 * - Top-level cursor fields track the active slot for "Continue watching" / "Caught up" shelves.
 */
export function saveProgress(
  e: Omit<ProgressEntry, "updatedAt" | "upNext" | "finished" | "caughtUp" | "episodes" | "schemaVersion"> & {
    media: Media & { canonicalKey?: string };
  },
  next?: { season?: number; episode: number } | null,
  opts?: { aliasKeys?: (string | undefined)[]; ongoing?: boolean },
) {
  const canonicalKey = e.media.canonicalKey ?? e.media.key;
  const done = isDone(e.position, e.duration);
  const isSeries = canonicalKey.startsWith("tmdb:tv:") || e.media.kind === "tv";
  const isEpisodicAnime = (canonicalKey.startsWith("anilist:") || e.media.kind === "anime") && !isFilm(e.media);
  const now = Date.now();
  const base = {
    ...e,
    ...(isSeries && e.season == null ? { season: 1 } : {}),
    ...((isSeries || isEpisodicAnime) && e.episode == null ? { episode: 1 } : {}),
    media: slim(e.media),
    updatedAt: now,
  };

  // Fold any pre-existing canonical + alias entries (e.g. cour keys) so no episode progress is ever orphaned.
  const aliasSet = new Set<string>([canonicalKey, e.media.key, ...(opts?.aliasKeys ?? []).filter((k): k is string => Boolean(k))]);
  let mergedEpisodes: Record<string, EpisodeProgress> | undefined;
  for (const k of aliasSet) {
    const existing = store[k];
    if (!existing) continue;
    mergedEpisodes = unionEpisodes(mergedEpisodes, seedLegacyEpisode(existing));
  }

  const curEpKey = epKey(base.season, base.episode);
  const prevEp = mergedEpisodes?.[curEpKey];
  const nextEpisodes = unionEpisodes(mergedEpisodes, {
    [curEpKey]: {
      ...(base.season != null ? { season: base.season } : {}),
      ...(base.episode != null ? { episode: base.episode } : {}),
      ...(base.audio ? { audio: base.audio } : {}),
      position: e.position,
      duration: e.duration,
      updatedAt: now,
      ...(done || prevEp?.completed ? { completed: true } : {}),
    },
  });

  const ongoing = Boolean(opts?.ongoing ?? isOngoingMedia(e.media));
  const entry: ProgressEntry = !done
    ? {
        ...base,
        episodes: nextEpisodes,
        schemaVersion: 2,
      }
    : next
      ? {
          ...base,
          season: next.season ?? base.season,
          episode: next.episode,
          position: 0,
          upNext: true,
          episodes: nextEpisodes,
          schemaVersion: 2,
        }
      : ongoing
        ? {
            ...base,
            position: 0,
            caughtUp: true,
            episodes: nextEpisodes,
            schemaVersion: 2,
          }
        : {
            ...base,
            position: 0,
            finished: true,
            episodes: nextEpisodes,
            schemaVersion: 2,
          };

  const nextStore = { ...store };
  for (const k of aliasSet) {
    if (k !== canonicalKey && k in nextStore) delete nextStore[k];
  }
  nextStore[canonicalKey] = entry;
  store = nextStore;
  save(done);
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
  window.addEventListener("pagehide", () => {
    persistNow();
    flushProgressSync();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      persistNow();
      flushProgressSync();
    }
  });
}

/** Collect all per-episode progress records across `mediaKey` and any alias keys (cour/season keys). */
export function getEpisodesMap(
  mediaKey: string,
  fallbackKeys?: (string | undefined)[],
): Record<string, EpisodeProgress> {
  const keys = [mediaKey, ...(fallbackKeys ?? [])];
  let out: Record<string, EpisodeProgress> | undefined;
  const seen = new Set<string>();
  for (const k of keys) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const p = store[k];
    if (!p) continue;
    out = unionEpisodes(out, seedLegacyEpisode(p));
  }
  return out ?? {};
}

/** Exact stored state for one episode (or film via `season == null && episode == null`). */
export function getEpisodeProgress(
  mediaKey: string,
  season?: number,
  episode?: number,
  fallbackKeys?: (string | undefined)[],
): EpisodeProgress | undefined {
  const map = getEpisodesMap(mediaKey, fallbackKeys);
  const direct = map[epKey(season, episode)];
  if (direct) return direct;
  // Anime entries sometimes record season=1 (canonical Season 1) vs season=undefined (`s0:eN`).
  if (episode != null) {
    if (season == null) return map[`s1:e${episode}`];
    if (season === 1) return map[`s0:e${episode}`];
  }
  return undefined;
}

/** Resume timestamp in seconds for an episode: only returns an active mid-episode timestamp. */
export function getResumePosition(
  mediaKey: string,
  season?: number,
  episode?: number,
  fallbackKeys?: (string | undefined)[],
): number | undefined {
  const ep = getEpisodeProgress(mediaKey, season, episode, fallbackKeys);
  if (!ep) return undefined;
  if (ep.completed || isDone(ep.position, ep.duration)) return undefined;
  return ep.position > RESUME_MIN_SEC ? ep.position : undefined;
}

/** Whether a specific episode (or film) has been watched to completion or manually marked watched. */
export function isEpisodeWatched(
  mediaKey: string,
  season?: number,
  episode?: number,
  fallbackKeys?: (string | undefined)[],
): boolean {
  const ep = getEpisodeProgress(mediaKey, season, episode, fallbackKeys);
  if (!ep) return false;
  return Boolean(ep.completed || isDone(ep.position, ep.duration));
}

export function getProgress(mediaKey: string, season?: number, episode?: number, fallbackKeys?: (string | undefined)[]): ProgressEntry | undefined {
  const keys = [mediaKey, ...(fallbackKeys ?? [])];
  let anchor: ProgressEntry | undefined;
  for (const k of keys) {
    if (!k) continue;
    if (store[k]) {
      anchor = store[k];
      break;
    }
  }
  const ep = getEpisodeProgress(mediaKey, season, episode, fallbackKeys);
  if (ep && anchor) {
    return {
      ...anchor,
      season: ep.season ?? season,
      episode: ep.episode ?? episode,
      audio: ep.audio ?? anchor.audio,
      position: ep.position,
      duration: ep.duration,
      updatedAt: ep.updatedAt,
      upNext: anchor.upNext && anchor.season === season && anchor.episode === episode ? true : undefined,
      finished: ep.completed,
    };
  }
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
  save(true);
  push(`/progress/${encodeURIComponent(mediaKey)}`, "DELETE");
  return gone;
}

/** Put back an entry removed by mistake (the Undo on the toast). */
export function restoreProgress(entry: ProgressEntry) {
  store = { ...store, [entry.media.key]: entry };
  save(true);
  push(`/progress/${encodeURIComponent(entry.media.key)}`, "PUT", entry);
}

/** Clone a stored entry before mutating so callers can offer instant Undo. */
function cloneEntry(entry: ProgressEntry | undefined): ProgressEntry | undefined {
  if (!entry) return undefined;
  return {
    ...entry,
    media: { ...entry.media },
    ...(entry.episodes ? { episodes: Object.fromEntries(Object.entries(entry.episodes).map(([k, v]) => [k, { ...v }])) } : {}),
  };
}

/** Manually mark one episode watched or unwatched. Returns previous ProgressEntry snapshot for Undo. */
export function markEpisodeWatched(
  media: Media & { canonicalKey?: string },
  season: number | undefined,
  episode: number | undefined,
  watched: boolean,
  durationSec = 1440,
  aliasKeys?: (string | undefined)[],
): ProgressEntry | undefined {
  const canonicalKey = media.canonicalKey ?? media.key;
  const prev = cloneEntry(store[canonicalKey]);
  const now = Date.now();
  const baseEpisodes = { ...getEpisodesMap(canonicalKey, [media.key, ...(aliasKeys ?? [])]) };
  const k = epKey(season, episode);

  if (watched) {
    baseEpisodes[k] = {
      ...(season != null ? { season } : {}),
      ...(episode != null ? { episode } : {}),
      position: durationSec,
      duration: durationSec,
      updatedAt: now,
      completed: true,
    };
  } else {
    delete baseEpisodes[k];
    if (episode != null) {
      if (season == null) delete baseEpisodes[`s1:e${episode}`];
      if (season === 1) delete baseEpisodes[`s0:e${episode}`];
    }
  }

  const remaining = Object.values(baseEpisodes).sort((a, b) => b.updatedAt - a.updatedAt);
  const nextStore = { ...store };
  for (const ak of [media.key, ...(aliasKeys ?? [])]) {
    if (ak && ak !== canonicalKey) delete nextStore[ak];
  }

  if (!watched && remaining.length === 0) {
    delete nextStore[canonicalKey];
    store = nextStore;
    save(true);
    push(`/progress/${encodeURIComponent(canonicalKey)}`, "DELETE");
    return prev;
  }

  const latestEp = watched ? baseEpisodes[k] : remaining[0];
  const entry: ProgressEntry = {
    media: slim(media),
    season: latestEp?.season ?? season,
    episode: latestEp?.episode ?? episode,
    audio: latestEp?.audio ?? prev?.audio,
    position: latestEp?.completed ? 0 : (latestEp?.position ?? 0),
    duration: latestEp?.duration ?? durationSec,
    updatedAt: now,
    ...(watched && prev?.season === season && prev?.episode === episode ? {} : prev?.upNext ? { upNext: true } : {}),
    episodes: baseEpisodes,
    schemaVersion: 2,
  };
  nextStore[canonicalKey] = entry;
  store = nextStore;
  save(true);
  syncProgress(canonicalKey, entry, true);
  return prev;
}

/** Manually mark every episode in a season watched or unwatched. Returns previous ProgressEntry snapshot for Undo. */
export function markSeasonWatched(
  media: Media & { canonicalKey?: string },
  season: number | undefined,
  episodes: { number: number; runtime?: number }[],
  watched: boolean,
  aliasKeys?: (string | undefined)[],
): ProgressEntry | undefined {
  const canonicalKey = media.canonicalKey ?? media.key;
  const prev = cloneEntry(store[canonicalKey]);
  const now = Date.now();
  const baseEpisodes = { ...getEpisodesMap(canonicalKey, [media.key, ...(aliasKeys ?? [])]) };

  for (const ep of episodes) {
    const k = epKey(season, ep.number);
    if (watched) {
      const dur = (ep.runtime && ep.runtime > 0 ? ep.runtime : 24) * 60;
      baseEpisodes[k] = {
        ...(season != null ? { season } : {}),
        episode: ep.number,
        position: dur,
        duration: dur,
        updatedAt: now,
        completed: true,
      };
    } else {
      delete baseEpisodes[k];
      if (season == null) delete baseEpisodes[`s1:e${ep.number}`];
      if (season === 1) delete baseEpisodes[`s0:e${ep.number}`];
    }
  }

  const remaining = Object.values(baseEpisodes).sort((a, b) => b.updatedAt - a.updatedAt);
  const nextStore = { ...store };
  for (const ak of [media.key, ...(aliasKeys ?? [])]) {
    if (ak && ak !== canonicalKey) delete nextStore[ak];
  }

  if (!watched && remaining.length === 0) {
    delete nextStore[canonicalKey];
    store = nextStore;
    save(true);
    push(`/progress/${encodeURIComponent(canonicalKey)}`, "DELETE");
    return prev;
  }

  const latestEp = remaining[0];
  const entry: ProgressEntry = {
    media: slim(media),
    season: latestEp?.season ?? season,
    episode: latestEp?.episode,
    audio: prev?.audio ?? latestEp?.audio,
    position: latestEp?.completed ? 0 : (latestEp?.position ?? 0),
    duration: latestEp?.duration ?? 1440,
    updatedAt: now,
    episodes: baseEpisodes,
    schemaVersion: 2,
  };
  nextStore[canonicalKey] = entry;
  store = nextStore;
  save(true);
  syncProgress(canonicalKey, entry, true);
  return prev;
}

/** The raw entry for a title, whatever its episode (Title page "Resume" / "Up next" / "Caught up" button). */
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

/**
 * Pure per-episode CRDT merge between local and remote ProgressEntry.
 * Preserves local `episodes` even if an older remote row lacks `episodes`, and keeps the
 * newest `updatedAt` per individual episode across devices.
 */
export function mergeProgressEntry(local: ProgressEntry | undefined, remote: ProgressEntry): ProgressEntry {
  if (!local) {
    return {
      ...remote,
      episodes: unionEpisodes(seedLegacyEpisode(remote), sanitizeEpisodesMap(remote.episodes)),
      schemaVersion: 2,
    };
  }
  const mergedEpisodes = unionEpisodes(
    unionEpisodes(seedLegacyEpisode(local), sanitizeEpisodesMap(local.episodes)),
    unionEpisodes(seedLegacyEpisode(remote), sanitizeEpisodesMap(remote.episodes)),
  );
  const cursor = remote.updatedAt >= local.updatedAt ? remote : local;
  return {
    ...cursor,
    media: {
      ...(local.updatedAt > remote.updatedAt ? local.media : remote.media),
      nextAiring: remote.media.nextAiring ?? local.media.nextAiring,
      status: remote.media.status ?? local.media.status,
    },
    episodes: mergedEpisodes,
    schemaVersion: 2,
  };
}

registerSync({
  // Merge per-episode timestamps across devices rather than letting latest series write destroy older episodes.
  pull: () =>
    fetchSync()
      .then((s) => {
        const next = { ...store };
        for (const r of (Array.isArray(s.progress) ? s.progress : []) as ProgressEntry[]) {
          if (!r?.media?.key) continue;
          const mine = next[r.media.key];
          const merged = mergeProgressEntry(mine, r);
          next[r.media.key] = merged;
          // Push back to server if local held episodes missing from remote or had a newer timestamp.
          const remoteEpCount = Object.keys(r.episodes ?? {}).length;
          const mergedEpCount = Object.keys(merged.episodes ?? {}).length;
          if (mine && (mine.updatedAt > r.updatedAt || mergedEpCount > remoteEpCount)) {
            push(`/progress/${encodeURIComponent(r.media.key)}`, "PUT", merged);
          }
        }
        // Removed on another device: drop our copy unless we watched it again since.
        for (const t of (Array.isArray(s.progressDeleted) ? s.progressDeleted : []) as { key?: unknown; deletedAt?: unknown }[]) {
          if (typeof t?.key !== "string" || typeof t?.deletedAt !== "number") continue;
          const mine = next[t.key];
          if (mine && mine.updatedAt <= t.deletedAt) delete next[t.key];
        }
        store = next;
        save(true);
      })
      .catch(() => {}),
  clear: () => {
    pendingSync.forEach((t) => clearTimeout(t));
    pendingSync.clear();
    lastSync.clear();
    store = {};
    save(true);
  },
});

/** Subscribe a component to every progress change (episode grids read many entries at once). */
export function useProgressStore() {
  return useSyncExternalStore(subscribe, () => store);
}

/**
 * The newest active (or caught-up ongoing) entry saved under any of a show's keys.
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

export function getContinueWatching(): ProgressEntry[] {
  return Object.values(store)
    .filter((p) => !p.finished && !p.caughtUp && (p.position > RESUME_MIN_SEC || p.upNext))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
}

export function getCaughtUp(): ProgressEntry[] {
  return Object.values(store)
    .filter((p) => Boolean(p.caughtUp) && !p.finished)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getAllProgress(): ProgressEntry[] {
  return Object.values(store).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useContinueWatching(): ProgressEntry[] {
  const s = useSyncExternalStore(subscribe, () => store);
  return useMemo(() => getContinueWatching(), [s]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Ongoing series where the user finished every currently aired episode and is waiting for the next drop. */
export function useCaughtUp(): ProgressEntry[] {
  const s = useSyncExternalStore(subscribe, () => store);
  return useMemo(() => getCaughtUp(), [s]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** All tracked entries sorted most recently updated first (used by Airing Radar & My List). */
export function useAllProgress(): ProgressEntry[] {
  const s = useSyncExternalStore(subscribe, () => store);
  return useMemo(() => getAllProgress(), [s]); // eslint-disable-line react-hooks/exhaustive-deps
}
