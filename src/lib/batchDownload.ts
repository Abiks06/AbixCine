import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { acquireSession } from "../sources/session";
import { isUnairedEpisode, resolvePlaybackRequest } from "./catalog";
import { rankDownloadOptions } from "./downloadRank";
import {
  ensureDownloadFolder,
  hasDownloadedEpisode,
  registerBatchCancelHook,
  startDownload,
  type DownloadedEntry,
  type DownloadJob,
} from "./downloads";
import { getSettings, type Audio } from "./settings";
import { toast } from "./toast";
import type { Episode, MediaDetail } from "./types";

interface QueuedEpisodeTask {
  taskKey: string;
  seasonKey: string;
  canonicalKey: string;
  detail: MediaDetail;
  season: number;
  episode: Episode;
  audio?: Audio;
}

export interface BatchSeasonSummary {
  batchKey: string;
  title: string;
  canonicalKey: string;
  season: number;
  currentEp?: number;
  total: number;
  queued: number;
  failed: number;
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
  seasons: Readonly<Record<string, BatchSeasonSummary>>;
}

const RESOLVE_TIMEOUT_MS = 12_000;
const EXTRA_SETTLE_GRACE_MS = 1600;

let batchQueue: QueuedEpisodeTask[] = [];
const batchSeasons = new Map<string, BatchSeasonSummary>();
let working = false;
let stoppedAll = false;
let currentTask: QueuedEpisodeTask | null = null;
let currentTaskAborted = false;
let activeAbort: (() => void) | null = null;

let batchState: BatchDownloadState = {
  active: false,
  total: 0,
  queued: 0,
  failed: 0,
  pendingKeys: new Set(),
  seasons: {},
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function batchEpisodeKey(canonicalKey: string, season: number | undefined, episode: number, audio?: string): string {
  return `${canonicalKey}|${season ?? 1}|${episode}|${audio ?? ""}`;
}

export function batchSeasonKey(canonicalKey: string, season?: number): string {
  return `${canonicalKey}|${season ?? 1}`;
}

export function getBatchForSeason(
  batch: BatchDownloadState,
  canonicalKey: string,
  season: number,
): BatchSeasonSummary | undefined {
  return batch.seasons[batchSeasonKey(canonicalKey, season)];
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
      if (j.isFilm || j.status === "cancelled" || j.status === "completed" || j.status === "failed") return false;
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
      const prefQuality = getSettings().preferredQuality;
      const ranked = rankDownloadOptions(snap.candidates, prefQuality);
      const chosen = ranked[candidateIndex];
      const backups = ranked.filter((c) => c !== chosen).slice(0, 6);
      session.release();

      if (!chosen || candidateIndex < 0 || stoppedAll || currentTaskAborted) {
        resolve({ ok: false });
        return;
      }
      void startDownload(req, chosen, detail, episode.title, {
        silent: true,
        fallbacks: backups,
        preferredQuality: prefQuality,
        replaceExisting: true,
      }).then((job) => {
        resolve({ ok: Boolean(job) });
      });
    };

    const check = () => {
      if (stoppedAll || currentTaskAborted) {
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

function taskMatchesScope(
  task: Pick<QueuedEpisodeTask, "canonicalKey" | "season">,
  opts?: { canonicalKey?: string; season?: number },
): boolean {
  if (opts?.canonicalKey && task.canonicalKey !== opts.canonicalKey) return false;
  if (opts?.season != null && task.season !== opts.season) return false;
  return true;
}

function buildStateFromSeasons(
  activeTask: QueuedEpisodeTask | null,
  pendingKeys: ReadonlySet<string>,
): BatchDownloadState {
  const seasons: Record<string, BatchSeasonSummary> = {};
  let total = 0;
  let queued = 0;
  let failed = 0;
  for (const [k, s] of batchSeasons) {
    seasons[k] = { ...s };
    total += s.total;
    queued += s.queued;
    failed += s.failed;
  }
  const firstSeason = activeTask
    ? batchSeasons.get(activeTask.seasonKey)
    : batchSeasons.values().next().value;
  return {
    active: batchSeasons.size > 0 || activeTask != null,
    title: activeTask?.detail.title ?? firstSeason?.title,
    canonicalKey: activeTask?.canonicalKey ?? firstSeason?.canonicalKey,
    season: activeTask?.season ?? firstSeason?.season,
    currentEp: activeTask?.episode.number ?? firstSeason?.currentEp,
    total,
    queued,
    failed,
    pendingKeys,
    seasons,
  };
}

async function drainBatchQueue() {
  if (working) return;
  working = true;
  stoppedAll = false;

  while (batchQueue.length > 0 && !stoppedAll) {
    const task = batchQueue.shift()!;
    currentTask = task;
    currentTaskAborted = false;
    const sSummary = batchSeasons.get(task.seasonKey);
    if (sSummary) sSummary.currentEp = task.episode.number;
    batchState = buildStateFromSeasons(task, batchState.pendingKeys);
    emit();

    const { ok } = await resolveBestDownloadServer(task.detail, task.season, task.episode, task.audio);
    const wasAborted = currentTaskAborted;
    currentTask = null;
    currentTaskAborted = false;
    if (stoppedAll) break;

    const nextPending = new Set(batchState.pendingKeys);
    nextPending.delete(task.taskKey);

    if (!wasAborted) {
      const cur = batchSeasons.get(task.seasonKey);
      if (cur) {
        if (ok) cur.queued++;
        else cur.failed++;
        const moreInSeason = batchQueue.some((q) => q.seasonKey === task.seasonKey);
        if (!moreInSeason) {
          batchSeasons.delete(task.seasonKey);
          if (cur.total > 1) {
            if (cur.queued > 0 && cur.failed === 0) {
              toast(`Queued ${cur.queued} episodes of “${cur.title}” (S${cur.season}) for download`, {
                icon: "download",
              });
            } else if (cur.queued > 0) {
              toast(
                `Queued ${cur.queued}/${cur.total} episodes of “${cur.title}” (S${cur.season}; ${cur.failed} unavailable)`,
                { icon: "info" },
              );
            } else if (cur.failed > 0) {
              toast(`Couldn't find downloadable streams for “${cur.title}” S${cur.season}`, { icon: "info" });
            }
          } else if (cur.total === 1 && cur.failed > 0) {
            toast(`No downloadable server found for E${cur.currentEp ?? ""}`, { icon: "info" });
          }
        }
      }
    }

    batchState = buildStateFromSeasons(null, nextPending);
    emit();
  }

  batchQueue = [];
  batchSeasons.clear();
  currentTask = null;
  currentTaskAborted = false;
  working = false;
  stoppedAll = false;
  batchState = {
    active: false,
    total: 0,
    queued: 0,
    failed: 0,
    pendingKeys: new Set(),
    seasons: {},
  };
  emit();
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
  const sNum = season ?? 1;
  const sKey = batchSeasonKey(cKey, sNum);
  const taskKey = batchEpisodeKey(cKey, sNum, episode.number, audio);
  if (batchState.pendingKeys.has(taskKey)) return;

  const nextPending = new Set(batchState.pendingKeys);
  nextPending.add(taskKey);
  batchQueue.push({ taskKey, seasonKey: sKey, canonicalKey: cKey, detail, season: sNum, episode, audio });

  const prevS = batchSeasons.get(sKey);
  batchSeasons.set(sKey, {
    batchKey: sKey,
    title: detail.title,
    canonicalKey: cKey,
    season: sNum,
    currentEp: prevS?.currentEp ?? episode.number,
    total: (prevS?.total ?? 0) + 1,
    queued: prevS?.queued ?? 0,
    failed: prevS?.failed ?? 0,
  });

  batchState = buildStateFromSeasons(currentTask, nextPending);
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
  const sKey = batchSeasonKey(cKey, season);
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
    batchQueue.push({ taskKey, seasonKey: sKey, canonicalKey: cKey, detail, season, episode: ep, audio });
    added++;
  }
  if (!added) return;

  const prevS = batchSeasons.get(sKey);
  batchSeasons.set(sKey, {
    batchKey: sKey,
    title: detail.title,
    canonicalKey: cKey,
    season,
    currentEp: prevS?.currentEp ?? missing[0]?.number,
    total: (prevS?.total ?? 0) + added,
    queued: prevS?.queued ?? 0,
    failed: prevS?.failed ?? 0,
  });

  batchState = buildStateFromSeasons(currentTask, nextPending);
  emit();
  toast(`Finding best download servers for ${added} episode${added === 1 ? "" : "s"}…`, { icon: "download" });
  void drainBatchQueue();
}

export function cancelBatchDownloads(opts?: {
  silent?: boolean;
  canonicalKey?: string;
  season?: number;
}): boolean {
  if (!batchState.active && batchQueue.length === 0 && batchSeasons.size === 0 && !currentTask) {
    return false;
  }

  const scoped = Boolean(opts?.canonicalKey != null || opts?.season != null);
  if (!scoped) {
    stoppedAll = true;
    batchQueue = [];
    batchSeasons.clear();
    currentTaskAborted = true;
    const abortFn = activeAbort;
    batchState = {
      active: false,
      total: 0,
      queued: 0,
      failed: 0,
      pendingKeys: new Set(),
      seasons: {},
    };
    emit();
    abortFn?.();
    if (!opts?.silent) {
      toast("Stopped remaining download queue", { icon: "info" });
    }
    return true;
  }

  const nextPending = new Set(batchState.pendingKeys);
  let matched = false;

  batchQueue = batchQueue.filter((t) => {
    if (taskMatchesScope(t, opts)) {
      nextPending.delete(t.taskKey);
      matched = true;
      return false;
    }
    return true;
  });

  for (const [k, s] of batchSeasons.entries()) {
    if (taskMatchesScope({ canonicalKey: s.canonicalKey, season: s.season }, opts)) {
      batchSeasons.delete(k);
      matched = true;
    }
  }

  let abortFn: (() => void) | null = null;
  if (currentTask && taskMatchesScope(currentTask, opts)) {
    nextPending.delete(currentTask.taskKey);
    currentTaskAborted = true;
    abortFn = activeAbort;
    matched = true;
  }

  if (!matched) return false;

  batchState = buildStateFromSeasons(currentTask && !currentTaskAborted ? currentTask : null, nextPending);
  emit();
  abortFn?.();
  if (!opts?.silent) {
    toast(
      opts?.season != null ? `Stopped Season ${opts.season} download queue` : "Stopped remaining season download queue",
      { icon: "info" },
    );
  }
  return true;
}

/** Seed multi-season queue entries in Vitest without triggering network session resolution. */
export function __seedBatchQueueForTest(
  entries: Array<{ detail: MediaDetail; season: number; episodes: Episode[]; audio?: Audio }>,
): void {
  batchQueue = [];
  batchSeasons.clear();
  currentTask = null;
  currentTaskAborted = false;
  stoppedAll = false;
  const nextPending = new Set<string>();
  for (const e of entries) {
    const cKey = e.detail.canonicalKey ?? e.detail.key;
    const sKey = batchSeasonKey(cKey, e.season);
    for (const ep of e.episodes) {
      const taskKey = batchEpisodeKey(cKey, e.season, ep.number, e.audio);
      nextPending.add(taskKey);
      batchQueue.push({
        taskKey,
        seasonKey: sKey,
        canonicalKey: cKey,
        detail: e.detail,
        season: e.season,
        episode: ep,
        audio: e.audio,
      });
    }
    batchSeasons.set(sKey, {
      batchKey: sKey,
      title: e.detail.title,
      canonicalKey: cKey,
      season: e.season,
      currentEp: e.episodes[0]?.number,
      total: e.episodes.length,
      queued: 0,
      failed: 0,
    });
  }
  batchState = buildStateFromSeasons(null, nextPending);
  emit();
}

export function __getBatchSnapshotForTest(): BatchDownloadState {
  return batchState;
}

registerBatchCancelHook((scope) =>
  cancelBatchDownloads({
    silent: true,
    canonicalKey: scope?.canonicalKey,
    season: scope?.season,
  }),
);
