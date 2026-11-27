import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchAnilistAiringBatch, type AnilistAiringBatchNode } from "./anilist";
import { fmtAirBadge, fmtCountdown, fmtEpCode, toAiringMs } from "./format";
import { resolveAnilistEpisodeCount } from "./normalizer";
import { getEpisodesMap, isDone, isOngoingMedia, type ProgressEntry } from "./progress";
import { hasTmdb, tmdbDetail } from "./tmdb";
import { isFilm, type Media } from "./types";

const STORAGE_KEY = "abx.airing.v1";
const ANILIST_TTL_MS = 15 * 60_000;
const TMDB_TTL_MS = 30 * 60_000;
const ENDED_TTL_MS = 7 * 86_400_000;
const NEAR_AIR_MS = 2 * 3600_000;
const NEAR_TTL_MS = 3 * 60_000;

export interface AiringSnapshot {
  key: string;
  status?: string;
  ongoing: boolean;
  airedCount?: number;
  lastEpisode?: { season?: number; episode: number; airDate?: string };
  nextAiring?: Media["nextAiring"];
  checkedAt: number;
}

export type TrackingKind = "new-episode" | "caught-up" | "watching" | "completed" | "unstarted";

export interface TrackingState {
  kind: TrackingKind;
  badge?: string;
  detail?: string;
  nextAiring?: Media["nextAiring"];
  nextPlay?: { season?: number; episode: number };
  watchedCount: number;
  behindCount?: number;
  caughtUp: boolean;
  ongoing: boolean;
}

const listeners = new Set<() => void>();
const clockListeners = new Set<() => void>();

function loadSnapshots(): Record<string, AiringSnapshot> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, AiringSnapshot>;
  } catch {
    return {};
  }
}

let store: Record<string, AiringSnapshot> = loadSnapshots();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const inflightKeys = new Set<string>();
let minuteClock = Math.floor(Date.now() / 60_000);
let clockTimer: ReturnType<typeof setInterval> | null = null;

function persistLater() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const entries = Object.entries(store);
      if (entries.length > 400) {
        entries.sort((a, b) => b[1].checkedAt - a[1].checkedAt);
        store = Object.fromEntries(entries.slice(0, 400));
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* ignore storage full */
    }
  }, 600);
}

function emit() {
  listeners.forEach((cb) => cb());
}

function ensureClock() {
  if (clockTimer || typeof window === "undefined") return;
  clockTimer = setInterval(() => {
    const next = Math.floor(Date.now() / 60_000);
    if (next !== minuteClock) {
      minuteClock = next;
      clockListeners.forEach((cb) => cb());
    }
  }, 30_000);
}

/** Reactive current time rounded to minutes so airing countdowns tick smoothly without per-second churn. */
export function useNowMinute(): number {
  useEffect(() => {
    ensureClock();
  }, []);
  const m = useSyncExternalStore(
    (cb) => {
      clockListeners.add(cb);
      return () => clockListeners.delete(cb);
    },
    () => minuteClock,
  );
  return m * 60_000;
}

export function useAiringMap(): Record<string, AiringSnapshot> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => store,
  );
}

export function useAiringFor(key?: string): AiringSnapshot | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (key ? store[key] : undefined),
  );
}

function isFresh(snap: AiringSnapshot | undefined, key: string, nowMs = Date.now()): boolean {
  if (!snap) return false;
  if (snap.nextAiring) {
    const atMs = toAiringMs(snap.nextAiring.at);
    if (atMs <= nowMs) return nowMs - snap.checkedAt < NEAR_TTL_MS;
    if (atMs - nowMs <= NEAR_AIR_MS) return nowMs - snap.checkedAt < NEAR_TTL_MS;
  }
  if (!snap.ongoing && /finished|ended|canceled|cancelled/i.test(snap.status ?? "")) {
    return nowMs - snap.checkedAt < ENDED_TTL_MS;
  }
  const ttl = key.startsWith("anilist:") ? ANILIST_TTL_MS : TMDB_TTL_MS;
  return nowMs - snap.checkedAt < ttl;
}

function pickActiveSequelNode(root: AnilistAiringBatchNode): AnilistAiringBatchNode {
  const candidates: AnilistAiringBatchNode[] = [root];
  const walk = (n: AnilistAiringBatchNode, depth: number) => {
    if (depth > 2) return;
    for (const edge of n.relations?.edges ?? []) {
      if (edge.relationType !== "SEQUEL" || !edge.node) continue;
      if (edge.node.format && !["TV", "ONA", "TV_SHORT"].includes(edge.node.format)) continue;
      candidates.push(edge.node);
      walk(edge.node, depth + 1);
    }
  };
  walk(root, 0);
  const airing = candidates.find((c) => c.nextAiringEpisode && typeof c.nextAiringEpisode.airingAt === "number");
  if (airing) return airing;
  const releasing = candidates.find((c) => c.status === "RELEASING");
  if (releasing) return releasing;
  return candidates[candidates.length - 1] ?? root;
}

function isCompareNewer(a: { season?: number; episode: number }, b: { season?: number; episode: number }): boolean {
  const sa = a.season ?? 1;
  const sb = b.season ?? 1;
  if (sa !== sb) return sa > sb;
  return a.episode > b.episode;
}

/**
 * Pure tracking resolver: combines a title's stored ProgressEntry, live AiringSnapshot,
 * and current time to determine whether the user is caught up, has a new episode out, or is mid-run.
 */
export function getTrackingState(
  media: Media,
  entry: ProgressEntry | undefined,
  snap: AiringSnapshot | undefined,
  nowMs = Date.now(),
): TrackingState {
  const epMap = entry ? getEpisodesMap(entry.media.key, [media.key]) : {};
  const watchedList = Object.values(epMap).filter((ep) => ep.completed || isDone(ep.position, ep.duration));
  const watchedCount = watchedList.length;

  const status = snap?.status ?? entry?.media.status ?? media.status;
  const nextAiring = snap?.nextAiring ?? entry?.media.nextAiring ?? media.nextAiring;
  const ongoing = Boolean(
    snap?.ongoing ??
      (entry?.caughtUp || isOngoingMedia({ kind: media.kind, format: media.format, status, nextAiring })),
  );

  if (isFilm(media)) {
    const done = Boolean(entry?.finished || watchedList.length > 0);
    return {
      kind: done ? "completed" : entry && entry.position > 15 ? "watching" : "unstarted",
      watchedCount,
      caughtUp: false,
      ongoing: false,
    };
  }

  const maxWatchedCursor = watchedList.reduce<{ season?: number; episode: number } | undefined>((best, cur) => {
    const c = { season: cur.season, episode: cur.episode ?? 1 };
    return !best || isCompareNewer(c, best) ? c : best;
  }, entry?.season != null || entry?.episode != null ? { season: entry.season, episode: entry.episode ?? 1 } : undefined);

  const nextAirMs = nextAiring ? toAiringMs(nextAiring.at) : undefined;
  const nextJustAired = Boolean(
    nextAiring &&
      nextAirMs != null &&
      nextAirMs <= nowMs &&
      (!maxWatchedCursor ||
        isCompareNewer({ season: nextAiring.season ?? maxWatchedCursor.season, episode: nextAiring.episode }, maxWatchedCursor) ||
        (nextAiring.episode === maxWatchedCursor.episode && !entry?.caughtUp && watchedCount === 0)),
  );

  const serverHasNewLast = Boolean(
    snap?.lastEpisode &&
      maxWatchedCursor &&
      isCompareNewer(snap.lastEpisode, maxWatchedCursor),
  );

  const serverAiredAhead = Boolean(
    entry?.caughtUp &&
      snap?.airedCount &&
      maxWatchedCursor &&
      snap.airedCount > maxWatchedCursor.episode &&
      !media.key.startsWith("tmdb:tv:"),
  );

  if (entry?.caughtUp && (nextJustAired || serverHasNewLast || serverAiredAhead)) {
    const targetEp = serverHasNewLast && snap?.lastEpisode
      ? { season: snap.lastEpisode.season, episode: snap.lastEpisode.episode }
      : serverAiredAhead
        ? { season: entry.season, episode: (maxWatchedCursor?.episode ?? entry.episode ?? 1) + 1 }
        : nextAiring
          ? { season: nextAiring.season ?? entry.season, episode: nextAiring.episode }
          : { season: entry.season, episode: (entry.episode ?? 1) + 1 };
    const code = fmtEpCode(targetEp.season, targetEp.episode);
    return {
      kind: "new-episode",
      badge: `New · ${code}`,
      detail: `${code} is out now`,
      nextPlay: targetEp,
      nextAiring: nextJustAired ? undefined : nextAiring,
      watchedCount,
      caughtUp: false,
      ongoing: true,
    };
  }

  if (entry?.caughtUp || (ongoing && snap?.airedCount != null && watchedCount >= snap.airedCount && watchedCount > 0 && ongoing)) {
    const countdown = nextAiring ? fmtCountdown(nextAiring.at, Boolean(nextAiring.dateOnly), nowMs) : "";
    const code = nextAiring ? fmtEpCode(nextAiring.season ?? entry?.season, nextAiring.episode) : "";
    return {
      kind: "caught-up",
      badge: nextAiring ? `Caught up · ${countdown}` : "Caught up",
      detail: nextAiring ? `${code} · ${fmtAirBadge(nextAiring, nowMs).split(" · ").slice(1).join(" · ") || countdown}` : "Waiting for next episode",
      nextAiring,
      watchedCount,
      caughtUp: true,
      ongoing: true,
    };
  }

  if (entry?.finished) {
    return {
      kind: "completed",
      badge: "Completed",
      watchedCount,
      caughtUp: false,
      ongoing: false,
    };
  }

  if (entry && (entry.position > 15 || entry.upNext || watchedCount > 0)) {
    const behindCount =
      snap?.airedCount != null && snap.airedCount > watchedCount
        ? snap.airedCount - watchedCount
        : undefined;
    return {
      kind: "watching",
      badge: nextAiring ? fmtAirBadge(nextAiring, nowMs) : behindCount ? `${behindCount} left` : undefined,
      detail: nextAiring ? `Next · ${fmtAirBadge(nextAiring, nowMs)}` : undefined,
      nextAiring,
      watchedCount,
      behindCount,
      caughtUp: false,
      ongoing,
    };
  }

  return {
    kind: "unstarted",
    badge: nextAiring ? fmtAirBadge(nextAiring, nowMs) : undefined,
    detail: nextAiring ? `Airs ${fmtAirBadge(nextAiring, nowMs)}` : undefined,
    nextAiring,
    watchedCount,
    caughtUp: false,
    ongoing,
  };
}

/** Refresh stale airing status for tracked shows in batches (1 AniList call per 50 shows + selective TMDB). */
export async function refreshTrackedAiring(items: Media[]): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const now = Date.now();
  const candidates = items.filter((m) => !isFilm(m) && (m.key.startsWith("anilist:") || m.key.startsWith("tmdb:tv:")));
  if (!candidates.length) return;

  const anilistToFetch: { key: string; id: number; seed: Media }[] = [];
  const tmdbToFetch: Media[] = [];

  for (const m of candidates) {
    if (inflightKeys.has(m.key)) continue;
    if (isFresh(store[m.key], m.key, now)) continue;
    if (m.key.startsWith("anilist:")) {
      const id = Number(m.key.split(":")[1]);
      if (id > 0) anilistToFetch.push({ key: m.key, id, seed: m });
    } else if (m.key.startsWith("tmdb:tv:") && hasTmdb()) {
      tmdbToFetch.push(m);
    }
  }

  let changed = false;

  if (anilistToFetch.length > 0) {
    anilistToFetch.forEach((x) => inflightKeys.add(x.key));
    try {
      const nodes = await fetchAnilistAiringBatch(anilistToFetch.map((x) => x.id));
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const req of anilistToFetch) {
        const raw = byId.get(req.id);
        if (!raw) continue;
        const active = pickActiveSequelNode(raw);
        const airedCount = resolveAnilistEpisodeCount({
          id: active.id,
          status: active.status,
          episodes: active.episodes,
          nextAiringEpisode: active.nextAiringEpisode ?? undefined,
        });
        const nextAiring =
          active.nextAiringEpisode && typeof active.nextAiringEpisode.airingAt === "number"
            ? { episode: active.nextAiringEpisode.episode, at: active.nextAiringEpisode.airingAt * 1000 }
            : undefined;
        store = {
          ...store,
          [req.key]: {
            key: req.key,
            status: active.status ?? raw.status ?? undefined,
            ongoing: Boolean(nextAiring || active.status === "RELEASING" || raw.status === "RELEASING"),
            ...(airedCount > 0 ? { airedCount } : {}),
            ...(nextAiring ? { nextAiring } : {}),
            checkedAt: Date.now(),
          },
        };
        changed = true;
      }
    } catch {
      /* ignore transient network/rate-limit failure */
    } finally {
      anilistToFetch.forEach((x) => inflightKeys.delete(x.key));
    }
  }

  if (tmdbToFetch.length > 0) {
    const slice = tmdbToFetch.slice(0, 12);
    slice.forEach((m) => inflightKeys.add(m.key));
    const CONCURRENCY = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < slice.length) {
        const m = slice[idx++];
        try {
          const det = await tmdbDetail(m.key);
          const ongoing = /returning|production|airing/i.test(det.status ?? "") || Boolean(det.nextAiring);
          const airedCount = det.lastEpisode?.episode ?? det.totalEpisodes;
          store = {
            ...store,
            [m.key]: {
              key: m.key,
              status: det.status,
              ongoing,
              ...(airedCount != null ? { airedCount } : {}),
              ...(det.lastEpisode ? { lastEpisode: { season: det.lastEpisode.season, episode: det.lastEpisode.episode, airDate: det.lastEpisode.airDate } } : {}),
              ...(det.nextAiring ? { nextAiring: det.nextAiring } : {}),
              checkedAt: Date.now(),
            },
          };
          changed = true;
        } catch {
          /* ignore offline/failed TMDB fetch */
        } finally {
          inflightKeys.delete(m.key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, worker));
  }

  if (changed) {
    emit();
    persistLater();
  }
}

/** Subscribe a screen (Home, MyList, Vault) to live airing & caught-up countdowns for its tracked items. */
export function useAiringRadar(mediaList: Media[]) {
  const map = useAiringMap();
  const nowMs = useNowMinute();
  const sig = useMemo(
    () => mediaList.map((m) => m.key).filter((k) => k.startsWith("anilist:") || k.startsWith("tmdb:tv:")).sort().join("|"),
    [mediaList],
  );

  useEffect(() => {
    if (!sig) return;
    void refreshTrackedAiring(mediaList);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return { airingMap: map, nowMs };
}
