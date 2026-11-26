import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { acquireSession } from "../sources/session";
import type { StreamCandidate } from "../sources/types";
import { isUnairedEpisode, resolvePlaybackRequest } from "./catalog";
import { bestKnownQuality, candidateMeetsTargetQuality, formatResolution, rankDownloadOptions } from "./downloadRank";
import {
  ensureDownloadFolder,
  hasDownloadedEpisode,
  registerBatchCancelHook,
  startDownload,
  type DownloadedEntry,
  type DownloadJob,
} from "./downloads";
import {
  getDownloadQuality,
  getSettings,
  normalizeDownloadFormat,
  normalizeDownloadQualityPolicy,
  type Audio,
  type DownloadFormat,
  type DownloadQualityPolicy,
} from "./settings";
import { toast } from "./toast";
import type { Episode, MediaDetail, PlaybackRequest } from "./types";

interface QueuedEpisodeTask {
  taskKey: string;
  seasonKey: string;
  canonicalKey: string;
  detail: MediaDetail;
  season: number;
  episode: Episode;
  audio?: Audio;
  preferredQuality?: number;
  preferredFormat?: DownloadFormat;
  qualityPolicy?: DownloadQualityPolicy;
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

export interface BatchQualityPrompt {
  id: string;
  title: string;
  canonicalKey: string;
  season: number;
  episodeNumber: number;
  episodeTitle: string;
  targetQuality: number;
  bestQuality: number;
  providerName: string;
  totalEpisodes: number;
  remainingEpisodes: number;
  format: DownloadFormat;
}

export type BatchQualityDecision = "switch_season" | "accept_once" | "skip_keep_target" | "cancel";

const RESOLVE_TIMEOUT_MS = 20_000;
const EXTRA_SETTLE_GRACE_MS = 2_000;
const QUALITY_CHECK_ALL_AT_MS = 2_500;
const QUALITY_WAIT_GRACE_MS = 8_000;

let batchQueue: QueuedEpisodeTask[] = [];
const batchSeasons = new Map<string, BatchSeasonSummary>();
const seasonStickyProviders = new Map<string, string>();
const seasonPolicyOverrides = new Map<
  string,
  { preferredQuality?: number; qualityPolicy?: DownloadQualityPolicy }
>();
const seasonFirstChecked = new Set<string>();
let working = false;
let drainGen = 0;
let currentTask: QueuedEpisodeTask | null = null;
let currentTaskAborted = false;
let activeAbort: (() => void) | null = null;

let activePrompt: BatchQualityPrompt | null = null;
let promptResolver: ((d: BatchQualityDecision) => void) | null = null;
const promptListeners = new Set<() => void>();
const emitPrompt = () => promptListeners.forEach((fn) => fn());

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

export function useBatchQualityPrompt(): BatchQualityPrompt | null {
  return useSyncExternalStore(
    (cb) => {
      promptListeners.add(cb);
      return () => promptListeners.delete(cb);
    },
    () => activePrompt,
  );
}

export function resolveBatchQualityPrompt(choice: BatchQualityDecision): void {
  const res = promptResolver;
  promptResolver = null;
  activePrompt = null;
  emitPrompt();
  res?.(choice);
}

function askBatchQualityDecision(prompt: BatchQualityPrompt): Promise<BatchQualityDecision> {
  return new Promise((resolve) => {
    activePrompt = prompt;
    promptResolver = resolve;
    emitPrompt();
  });
}

/** Filter a season's episodes to aired episodes not already saved or queued/active/paused/held. */
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

interface ResolveServerOutcome {
  status: "ready" | "below_target" | "empty" | "aborted";
  req?: PlaybackRequest;
  chosen?: StreamCandidate;
  fallbacks?: StreamCandidate[];
  bestQuality?: number;
  targetQuality: number;
  format: DownloadFormat;
  policy: DownloadQualityPolicy;
}

function resolveBestDownloadServer(
  detail: MediaDetail,
  season: number | undefined,
  episode: Episode,
  seasonKey: string,
  audio?: Audio,
  preferredQuality?: number,
  preferredFormat?: DownloadFormat,
  qualityPolicy?: DownloadQualityPolicy,
): Promise<ResolveServerOutcome> {
  return new Promise((resolve) => {
    const settings = getSettings();
    const targetQ = preferredQuality ?? getDownloadQuality(settings);
    const targetFmt = normalizeDownloadFormat(preferredFormat ?? settings.downloadFormat);
    const policy = normalizeDownloadQualityPolicy(qualityPolicy ?? settings.downloadQualityPolicy);

    const req = resolvePlaybackRequest(detail, season, episode.number, audio);
    if (!req) {
      resolve({ status: "empty", targetQuality: targetQ, format: targetFmt, policy });
      return;
    }

    const stickyProvider = seasonStickyProviders.get(seasonKey);
    const resolveGen = drainGen;
    const session = acquireSession(req);
    session.retain();
    session.start(6);

    let done = false;
    let expandedAll = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let expandTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let qualityTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (candidateIndex: number) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(expandTimer);
      clearTimeout(graceTimer);
      clearTimeout(qualityTimer);
      unsub();
      activeAbort = null;

      const snap = session.getSnapshot();
      const ranked = rankDownloadOptions(snap.candidates, targetQ, { preferredProviderId: stickyProvider });
      const chosen = ranked[candidateIndex];
      const fallbacks = ranked.filter((c) => c !== chosen).slice(0, 10);
      session.release();

      if (candidateIndex < 0 || resolveGen !== drainGen || currentTaskAborted) {
        resolve({ status: "aborted", targetQuality: targetQ, format: targetFmt, policy });
        return;
      }
      if (!chosen) {
        resolve({ status: "empty", targetQuality: targetQ, format: targetFmt, policy });
        return;
      }

      const topKnownQ = ranked.reduce<number | undefined>((max, c) => {
        const q = bestKnownQuality(c);
        return q != null && (max == null || q > max) ? q : max;
      }, undefined);

      if (topKnownQ != null && topKnownQ < targetQ) {
        resolve({
          status: "below_target",
          req,
          chosen,
          fallbacks,
          bestQuality: topKnownQ,
          targetQuality: targetQ,
          format: targetFmt,
          policy,
        });
        return;
      }

      resolve({
        status: "ready",
        req,
        chosen,
        fallbacks,
        bestQuality: topKnownQ,
        targetQuality: targetQ,
        format: targetFmt,
        policy,
      });
    };

    const ensureCheckAll = () => {
      if (!expandedAll) {
        expandedAll = true;
        session.checkAll();
      }
    };

    expandTimer = setTimeout(() => {
      const snap = session.getSnapshot();
      const hasTarget = snap.candidates.some((c) => candidateMeetsTargetQuality(c, targetQ));
      if (!hasTarget) ensureCheckAll();
    }, QUALITY_CHECK_ALL_AT_MS);

    const check = () => {
      if (resolveGen !== drainGen || currentTaskAborted) {
        finish(-1);
        return;
      }
      const snap = session.getSnapshot();
      const ranked = rankDownloadOptions(snap.candidates, targetQ, { preferredProviderId: stickyProvider });
      if (!snap.busy) {
        if (!expandedAll && !ranked.some((c) => candidateMeetsTargetQuality(c, targetQ))) {
          ensureCheckAll();
          if (session.getSnapshot().busy) return;
        }
        finish(ranked.length > 0 ? 0 : -1);
        return;
      }

      if (ranked.length > 0) {
        const topMeetsTarget = candidateMeetsTargetQuality(ranked[0], targetQ);
        const stickyStillPending =
          Boolean(stickyProvider) &&
          ranked[0].providerId !== stickyProvider &&
          snap.lanes.some(
            (l) => l.providerId === stickyProvider && l.status === "searching",
          );

        if (topMeetsTarget && !stickyStillPending && (ranked.length >= 2 || (snap.pick && ranked.includes(snap.pick)))) {
          finish(0);
          return;
        }
        if (topMeetsTarget) {
          if (!graceTimer) graceTimer = setTimeout(() => finish(0), EXTRA_SETTLE_GRACE_MS);
        } else {
          if (!expandedAll) ensureCheckAll();
          if (!qualityTimer) {
            qualityTimer = setTimeout(() => finish(0), QUALITY_WAIT_GRACE_MS);
          }
        }
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

function finalizeSeasonBatch(seasonKey: string) {
  const cur = batchSeasons.get(seasonKey);
  if (!cur) return;
  const moreInSeason = batchQueue.some((q) => q.seasonKey === seasonKey);
  if (moreInSeason) return;

  batchSeasons.delete(seasonKey);
  seasonFirstChecked.delete(seasonKey);
  seasonPolicyOverrides.delete(seasonKey);
  seasonStickyProviders.delete(seasonKey);

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

async function drainBatchQueue() {
  if (working) return;
  working = true;
  const myGen = drainGen;

  try {
    while (batchQueue.length > 0 && myGen === drainGen) {
      const task = batchQueue.shift()!;
      currentTask = task;
      currentTaskAborted = false;
      const sSummary = batchSeasons.get(task.seasonKey);
      if (sSummary) sSummary.currentEp = task.episode.number;
      batchState = buildStateFromSeasons(task, batchState.pendingKeys);
      emit();

      const seasonOverride = seasonPolicyOverrides.get(task.seasonKey);
      const effectiveQ = seasonOverride?.preferredQuality ?? task.preferredQuality;
      const effectivePolicy = seasonOverride?.qualityPolicy ?? task.qualityPolicy;

      const outcome = await resolveBestDownloadServer(
        task.detail,
        task.season,
        task.episode,
        task.seasonKey,
        task.audio,
        effectiveQ,
        task.preferredFormat,
        effectivePolicy,
      );

      const isFirstSeasonCheck = !seasonFirstChecked.has(task.seasonKey);
      if (outcome.status === "ready" || outcome.status === "below_target") {
        seasonFirstChecked.add(task.seasonKey);
      }

      let ok = false;
      let countResult = true;

      if (myGen === drainGen && !currentTaskAborted && outcome.status !== "aborted") {
        if (
          outcome.status === "below_target" &&
          outcome.chosen &&
          outcome.req &&
          outcome.bestQuality &&
          outcome.policy === "ask" &&
          isFirstSeasonCheck &&
          (sSummary?.total ?? 0) > 1
        ) {
          const remainingCount = batchQueue.filter((q) => q.seasonKey === task.seasonKey).length;
          const decision = await askBatchQualityDecision({
            id: task.taskKey,
            title: task.detail.title,
            canonicalKey: task.canonicalKey,
            season: task.season,
            episodeNumber: task.episode.number,
            episodeTitle: task.episode.title,
            targetQuality: outcome.targetQuality,
            bestQuality: outcome.bestQuality,
            providerName: outcome.chosen.providerName,
            totalEpisodes: sSummary?.total ?? 1,
            remainingEpisodes: remainingCount,
            format: outcome.format,
          });

          if (myGen !== drainGen || currentTaskAborted || decision === "cancel") {
            countResult = false;
            if (decision === "cancel" && myGen === drainGen) {
              const nextPending = new Set(batchState.pendingKeys);
              nextPending.delete(task.taskKey);
              batchState = buildStateFromSeasons(null, nextPending);
              currentTask = null;
              emit();
              cancelBatchDownloads({ silent: true, canonicalKey: task.canonicalKey, season: task.season });
              continue;
            }
          } else if (decision === "switch_season") {
            seasonPolicyOverrides.set(task.seasonKey, {
              preferredQuality: outcome.bestQuality,
              qualityPolicy: "best",
            });
            seasonStickyProviders.set(task.seasonKey, outcome.chosen.providerId);
            for (const queuedTask of batchQueue) {
              if (queuedTask.seasonKey === task.seasonKey) {
                queuedTask.preferredQuality = outcome.bestQuality;
                queuedTask.qualityPolicy = "best";
              }
            }
            const job = await startDownload(outcome.req, outcome.chosen, task.detail, task.episode.title, {
              silent: true,
              fallbacks: outcome.fallbacks,
              preferredQuality: outcome.bestQuality,
              preferredFormat: outcome.format,
              qualityPolicy: "best",
              replaceExisting: true,
            });
            ok = Boolean(job);
            toast(
              `Switched Season ${task.season} downloads to ${formatResolution(outcome.bestQuality)} (${outcome.chosen.providerName})`,
              { icon: "download" },
            );
          } else if (decision === "accept_once") {
            const job = await startDownload(outcome.req, outcome.chosen, task.detail, task.episode.title, {
              silent: true,
              fallbacks: outcome.fallbacks,
              preferredQuality: outcome.bestQuality,
              preferredFormat: outcome.format,
              qualityPolicy: "best",
              replaceExisting: true,
            });
            ok = Boolean(job);
          } else if (decision === "skip_keep_target") {
            countResult = true;
            ok = false;
          }
        } else if (outcome.chosen && outcome.req) {
          if (outcome.status === "ready") {
            seasonStickyProviders.set(task.seasonKey, outcome.chosen.providerId);
          }
          const job = await startDownload(outcome.req, outcome.chosen, task.detail, task.episode.title, {
            silent: true,
            fallbacks: outcome.fallbacks,
            preferredQuality: outcome.targetQuality,
            preferredFormat: outcome.format,
            qualityPolicy: outcome.policy,
            replaceExisting: true,
          });
          ok = Boolean(job);
        }
      }

      const wasAborted = currentTaskAborted;
      currentTask = null;
      currentTaskAborted = false;
      if (myGen !== drainGen) break;

      const nextPending = new Set(batchState.pendingKeys);
      nextPending.delete(task.taskKey);

      if (!wasAborted && countResult) {
        const cur = batchSeasons.get(task.seasonKey);
        if (cur) {
          if (ok) cur.queued++;
          else cur.failed++;
          finalizeSeasonBatch(task.seasonKey);
        }
      } else if (!wasAborted) {
        finalizeSeasonBatch(task.seasonKey);
      }

      batchState = buildStateFromSeasons(null, nextPending);
      emit();
    }
  } finally {
    currentTask = null;
    currentTaskAborted = false;
    working = false;
    if (myGen === drainGen && batchQueue.length === 0) {
      batchSeasons.clear();
      seasonFirstChecked.clear();
      seasonPolicyOverrides.clear();
      seasonStickyProviders.clear();
      batchState = {
        active: false,
        total: 0,
        queued: 0,
        failed: 0,
        pendingKeys: new Set(),
        seasons: {},
      };
      emit();
    } else if (batchQueue.length > 0) {
      void drainBatchQueue();
    }
  }
}

export async function queueEpisodeDownload(
  detail: MediaDetail,
  season: number | undefined,
  episode: Episode,
  audio?: Audio,
  preferredQuality?: number,
  preferredFormat?: DownloadFormat,
  qualityPolicy?: DownloadQualityPolicy,
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
  batchQueue.push({
    taskKey,
    seasonKey: sKey,
    canonicalKey: cKey,
    detail,
    season: sNum,
    episode,
    audio,
    preferredQuality,
    preferredFormat,
    qualityPolicy,
  });

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
  preferredQuality?: number,
  preferredFormat?: DownloadFormat,
  qualityPolicy?: DownloadQualityPolicy,
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

  const targetQ = preferredQuality ?? getDownloadQuality(getSettings());
  // Seed sticky provider from any existing episode of this season that already hit target resolution.
  if (items && !seasonStickyProviders.has(sKey)) {
    const existingGood = items.find(
      (it) =>
        !it.isFilm &&
        (it.canonicalKey === cKey || it.mediaKey === cKey) &&
        (it.season ?? 1) === season &&
        it.qualityVerified &&
        (it.quality ?? 0) >= targetQ &&
        it.providerId !== "local-vault",
    );
    if (existingGood) {
      seasonStickyProviders.set(sKey, existingGood.providerId);
    }
  }

  const nextPending = new Set(batchState.pendingKeys);
  let added = 0;
  for (const ep of missing) {
    const taskKey = batchEpisodeKey(cKey, season, ep.number, audio);
    if (nextPending.has(taskKey)) continue;
    nextPending.add(taskKey);
    batchQueue.push({
      taskKey,
      seasonKey: sKey,
      canonicalKey: cKey,
      detail,
      season,
      episode: ep,
      audio,
      preferredQuality,
      preferredFormat,
      qualityPolicy,
    });
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
    drainGen += 1;
    batchQueue = [];
    batchSeasons.clear();
    seasonFirstChecked.clear();
    seasonPolicyOverrides.clear();
    seasonStickyProviders.clear();
    currentTaskAborted = true;
    if (activePrompt) {
      resolveBatchQualityPrompt("cancel");
    }
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
      seasonFirstChecked.delete(k);
      seasonPolicyOverrides.delete(k);
      seasonStickyProviders.delete(k);
      matched = true;
    }
  }

  if (activePrompt && taskMatchesScope(activePrompt, opts)) {
    resolveBatchQualityPrompt("cancel");
    matched = true;
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
  seasonFirstChecked.clear();
  seasonPolicyOverrides.clear();
  seasonStickyProviders.clear();
  currentTask = null;
  currentTaskAborted = false;
  drainGen += 1;
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
