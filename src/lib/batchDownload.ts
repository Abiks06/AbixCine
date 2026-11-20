import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { acquireSession } from "../sources/session";
import { isUnairedEpisode, resolvePlaybackRequest } from "./catalog";
import { rankDownloadOptions } from "./downloadRank";
import {
  ensureDownloadFolder,
  hasDownloadedEpisode,
  startDownload,
  type DownloadedEntry,
  type DownloadJob,
} from "./downloads";
import { getSettings, type Audio } from "./settings";
import { toast } from "./toast";
import type { Episode, MediaDetail } from "./types";

interface QueuedEpisodeTask {
  taskKey: string;
  detail: MediaDetail;
  season?: number;
  episode: Episode;
  audio?: Audio;
}

export interface BatchDownloadState {
  active: boolean;
  title?: string;
  canonicalKey?: string;
  season?: number;
  currentEp?: number;
  total: number;
  queued: number;
  failed: number;
  pendingKeys: ReadonlySet<string>;
}

const RESOLVE_TIMEOUT_MS = 12_000;
const EXTRA_SETTLE_GRACE_MS = 1600;

let batchQueue: QueuedEpisodeTask[] = [];
let working = false;
let cancelled = false;
let activeAbort: (() => void) | null = null;

let batchState: BatchDownloadState = {
  active: false,
  total: 0,
  queued: 0,
  failed: 0,
  pendingKeys: new Set(),
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function batchEpisodeKey(canonicalKey: string, season: number | undefined, episode: number, audio?: string): string {
  return `${canonicalKey}|${season ?? 1}|${episode}|${audio ?? ""}`;
}

export function useBatchDownloads(): BatchDownloadState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => batchState,
  );
}

/** Filter a season's episodes to aired episodes not already saved or queued/active/paused. */
export function selectMissingEpisodes(
  episodes: Episode[],
  opts: {
    canonicalKey: string;
    season: number;
    audio?: string;
    items: DownloadedEntry[];
    jobs: DownloadJob[];
    airedCount?: number;
    seriesStatus?: string;
  },
): Episode[] {
  return episodes.filter((ep) => {
    if (isUnairedEpisode(ep, { airedCount: opts.airedCount, seriesStatus: opts.seriesStatus })) {
      return false;
    }
    if (hasDownloadedEpisode(opts.canonicalKey, opts.season, ep.number, opts.audio, opts.items)) {
      return false;
    }
    const inJobs = opts.jobs.some((j) => {
      if (j.isFilm || j.status === "cancelled" || j.status === "completed") return false;
      if (j.canonicalKey !== opts.canonicalKey && j.mediaKey !== opts.canonicalKey) return false;
      if (j.season != null && j.season !== opts.season) return false;
      if (j.episode !== ep.number) return false;
      if (opts.audio && j.audio && j.audio !== "dual" && j.audio !== opts.audio) return false;
      return true;
    });
    return !inJobs;
  });
}

function resolveBestDownloadServer(detail: MediaDetail, season: number | undefined, episode: Episode, audio?: Audio) {
  return new Promise<{ ok: boolean }>((resolve) => {
    const req = resolvePlaybackRequest(detail, season, episode.number, audio);
    if (!req) {
      resolve({ ok: false });
      return;
    }
    const session = acquireSession(req);
    session.retain();
    session.start(2);

    let done = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (candidateIndex: number) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(graceTimer);
      unsub();
      activeAbort = null;

      const snap = session.getSnapshot();
      const ranked = rankDownloadOptions(snap.candidates, getSettings().preferredQuality);
      const chosen = ranked[candidateIndex];
      session.release();

      if (!chosen) {
        resolve({ ok: false });
        return;
      }
      void startDownload(req, chosen, detail, episode.title, { silent: true }).then((job) => {
        resolve({ ok: Boolean(job) });
      });
    };

    const check = () => {
      if (cancelled) {
        finish(-1);
        return;
      }
      const snap = session.getSnapshot();
      const ranked = rankDownloadOptions(snap.candidates, getSettings().preferredQuality);
      if (ranked.length > 0 && (!snap.busy || ranked.length >= 2 || (snap.pick && ranked.includes(snap.pick)))) {
        finish(0);
        return;
      }
      if (ranked.length > 0 && !graceTimer) {
        graceTimer = setTimeout(() => finish(0), EXTRA_SETTLE_GRACE_MS);
      }
      if (!snap.busy && ranked.length === 0) {
        finish(-1);
      }
    };

    activeAbort = () => finish(-1);
    hardTimer = setTimeout(() => finish(0), RESOLVE_TIMEOUT_MS);
    const unsub = session.subscribe(check);
    check();
  });
}

async function drainBatchQueue() {
  if (working) return;
  working = true;
  cancelled = false;

  while (batchQueue.length > 0 && !cancelled) {
    const task = batchQueue.shift()!;
    const cKey = task.detail.canonicalKey ?? task.detail.key;
    batchState = {
      ...batchState,
      active: true,
      title: task.detail.title,
      canonicalKey: cKey,
      season: task.season,
      currentEp: task.episode.number,
    };
    emit();

    const { ok } = await resolveBestDownloadServer(task.detail, task.season, task.episode, task.audio);
    if (cancelled) break;

    const nextPending = new Set(batchState.pendingKeys);
    nextPending.delete(task.taskKey);
    batchState = {
      ...batchState,
      queued: batchState.queued + (ok ? 1 : 0),
      failed: batchState.failed + (ok ? 0 : 1),
      pendingKeys: nextPending,
    };
    emit();
  }

  const summary = batchState;
  const wasCancelled = cancelled;
  batchQueue = [];
  working = false;
  cancelled = false;
  batchState = {
    active: false,
    total: 0,
    queued: 0,
    failed: 0,
    pendingKeys: new Set(),
  };
  emit();

  if (!wasCancelled && summary.total > 1) {
    if (summary.queued > 0 && summary.failed === 0) {
      toast(`Queued ${summary.queued} episodes of “${summary.title}” for download`, { icon: "download" });
    } else if (summary.queued > 0) {
      toast(`Queued ${summary.queued}/${summary.total} episodes (${summary.failed} had no downloadable stream)`, { icon: "info" });
    } else if (summary.failed > 0) {
      toast(`Couldn't find downloadable streams for “${summary.title}”`, { icon: "info" });
    }
  } else if (!wasCancelled && summary.total === 1 && summary.failed > 0) {
    toast(`No downloadable server found for E${summary.currentEp ?? ""}`, { icon: "info" });
  }
}

export async function queueEpisodeDownload(
  detail: MediaDetail,
  season: number | undefined,
  episode: Episode,
  audio?: Audio,
): Promise<void> {
  if (!isTauri()) {
    toast("Offline downloads work in the AbixCine desktop app.", { icon: "info" });
    return;
  }
  const root = await ensureDownloadFolder();
  if (!root) return;

  const cKey = detail.canonicalKey ?? detail.key;
  const taskKey = batchEpisodeKey(cKey, season, episode.number, audio);
  if (batchState.pendingKeys.has(taskKey)) return;

  const nextPending = new Set(batchState.pendingKeys);
  nextPending.add(taskKey);
  batchQueue.push({ taskKey, detail, season, episode, audio });
  batchState = {
    ...batchState,
    active: true,
    title: detail.title,
    canonicalKey: cKey,
    season,
    total: batchState.total + 1,
    pendingKeys: nextPending,
  };
  emit();
  void drainBatchQueue();
}

export async function queueSeasonDownloads(
  detail: MediaDetail,
  season: number,
  episodes: Episode[],
  audio?: Audio,
  airedCount?: number,
  items?: DownloadedEntry[],
  jobs?: DownloadJob[],
): Promise<void> {
  if (!isTauri()) {
    toast("Offline downloads work in the AbixCine desktop app.", { icon: "info" });
    return;
  }
  const root = await ensureDownloadFolder();
  if (!root) return;

  const cKey = detail.canonicalKey ?? detail.key;
  const missing =
    items && jobs
      ? selectMissingEpisodes(episodes, {
          canonicalKey: cKey,
          season,
          audio,
          items,
          jobs,
          airedCount,
          seriesStatus: detail.status,
        })
      : episodes.filter((ep) => !isUnairedEpisode(ep, { airedCount, seriesStatus: detail.status }));

  if (!missing.length) {
    toast(`Season ${season} is already saved or queued`, { icon: "check" });
    return;
  }

  const nextPending = new Set(batchState.pendingKeys);
  let added = 0;
  for (const ep of missing) {
    const taskKey = batchEpisodeKey(cKey, season, ep.number, audio);
    if (nextPending.has(taskKey)) continue;
    nextPending.add(taskKey);
    batchQueue.push({ taskKey, detail, season, episode: ep, audio });
    added++;
  }
  if (!added) return;

  batchState = {
    ...batchState,
    active: true,
    title: detail.title,
    canonicalKey: cKey,
    season,
    total: batchState.total + added,
    pendingKeys: nextPending,
  };
  emit();
  toast(`Finding best download servers for ${added} episode${added === 1 ? "" : "s"}…`, { icon: "download" });
  void drainBatchQueue();
}

export function cancelBatchDownloads(): void {
  if (!batchState.active && batchQueue.length === 0) return;
  cancelled = true;
  batchQueue = [];
  activeAbort?.();
  toast("Stopped remaining season download queue", { icon: "info" });
}
