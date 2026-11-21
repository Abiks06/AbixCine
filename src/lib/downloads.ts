import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useSyncExternalStore } from "react";
import { PROXY_URL_RX, unwrapProxyUrl, type StreamHeaders } from "../sources/native";
import type { StreamCandidate } from "../sources/types";
import { getSettings, updateSettings } from "./settings";
import { toast } from "./toast";
import { isUnairedEpisode } from "./normalizer";
import { isFilm, type Episode, type Media, type MediaDetail, type PlaybackRequest } from "./types";

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "remuxing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadSubtitleReq {
  lang: string;
  label: string;
  url: string;
  format?: string;
  headers?: StreamHeaders;
  isForced?: boolean;
  isHearingImpaired?: boolean;
}

export interface DownloadSourceReq {
  providerId: string;
  providerName: string;
  url: string;
  kind: string;
  headers: StreamHeaders;
  quality?: number;
  subtitles: DownloadSubtitleReq[];
}

export interface DownloadJob {
  id: string;
  root: string;
  mediaKey: string;
  canonicalKey: string;
  title: string;
  mediaKind: string;
  isFilm: boolean;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  audio?: string;
  quality?: number;
  preferredQuality?: number;
  resolvedQuality?: number;
  qualityVerified?: boolean;
  videoCodec?: string;
  providerId: string;
  providerName: string;
  url: string;
  kind: string;
  status: DownloadStatus;
  stage?: string;
  bytesDownloaded: number;
  totalBytes?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  speedBps: number;
  etaSec?: number;
  percent: number;
  filePath?: string;
  error?: string;
  attemptIndex?: number;
  totalSources?: number;
  fallbacksRemaining?: number;
  triedProviders?: string[];
  failoverNotes?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DownloadedEntry {
  id: string;
  mediaKey: string;
  canonicalKey: string;
  title: string;
  mediaKind: string;
  isFilm: boolean;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  audio?: string;
  quality?: number;
  qualityVerified?: boolean;
  videoCodec?: string;
  providerId: string;
  providerName: string;
  filePath: string;
  fileSize: number;
  subtitlePaths: string[];
  posterPath?: string;
  backdropPath?: string;
  downloadedAt: number;
  mediaSnapshot?: Partial<MediaDetail>;
}

export interface DownloadSnapshot {
  root?: string | null;
  jobs: DownloadJob[];
  items: DownloadedEntry[];
}

export interface DownloadsStoreState {
  root: string | null;
  defaultDir: string | null;
  jobs: DownloadJob[];
  items: DownloadedEntry[];
  switchingIds: ReadonlySet<string>;
}

export interface SetupPromptState {
  open: boolean;
  defaultDir: string | null;
  busy: boolean;
}

let state: DownloadsStoreState = {
  root: getSettings().downloadsPath ?? null,
  defaultDir: null,
  jobs: [],
  items: [],
  switchingIds: new Set<string>(),
};

let setupState: SetupPromptState = {
  open: false,
  defaultDir: null,
  busy: false,
};

let setupResolve: ((dir: string | null) => void) | null = null;
let setupPending: Promise<string | null> | null = null;
let folderInitInFlight: Promise<string | null> | null = null;
let initializedRoot: string | null = null;
let listenerReady = false;
let unlistenProgress: UnlistenFn | null = null;
let batchCancelHook: ((scope?: { canonicalKey?: string; season?: number }) => boolean) | null = null;
const autoRecoveryAttempted = new Set<string>();

export function registerBatchCancelHook(
  hook: (scope?: { canonicalKey?: string; season?: number }) => boolean,
): void {
  batchCancelHook = hook;
}

/** Normalize Windows/POSIX folder paths for reliable equality comparison. */
export function normalizePathKey(p?: string | null): string {
  if (!p) return "";
  let s = p.trim();
  if (s.startsWith("\\\\?\\UNC\\")) s = `\\\\${s.slice(8)}`;
  else if (s.startsWith("\\\\?\\")) s = s.slice(4);
  s = s.replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:/.test(s) || s.includes("\\")) {
    s = s.replace(/\//g, "\\").toLowerCase();
  }
  return s;
}

const listeners = new Set<() => void>();
const setupListeners = new Set<() => void>();
const changeCallbacks = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

function setSwitching(jobId: string, on: boolean) {
  const next = new Set(state.switchingIds);
  if (on) next.add(jobId);
  else next.delete(jobId);
  state = { ...state, switchingIds: next };
  emit();
}

function emitSetup() {
  setupListeners.forEach((fn) => fn());
}

export function onDownloadsChanged(cb: () => void): () => void {
  changeCallbacks.add(cb);
  return () => changeCallbacks.delete(cb);
}

function notifyDownloadsChanged() {
  changeCallbacks.forEach((cb) => cb());
}

function applySnapshot(snap: DownloadSnapshot) {
  state = {
    ...state,
    root: snap.root ?? state.root,
    jobs: Array.isArray(snap.jobs) ? snap.jobs : [],
    items: Array.isArray(snap.items) ? snap.items : [],
  };
  emit();
}

export function useDownloads(): DownloadsStoreState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Primitive selector that only re-renders when offline saved items transition between empty and non-empty. */
export function useHasDownloadedItems(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state.items.length > 0,
  );
}

/** Primitive selector returning how many offline files exist for a specific title, immune to 250ms job ticks. */
export function useOfflineCountForMedia(canonicalKey: string, mediaKey: string): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state.items.filter((e) => e.canonicalKey === canonicalKey || e.mediaKey === mediaKey).length,
  );
}

export function useDownloadSetupPrompt() {
  const prompt = useSyncExternalStore(
    (cb) => {
      setupListeners.add(cb);
      return () => setupListeners.delete(cb);
    },
    () => setupState,
  );
  return {
    ...prompt,
    chooseFolder: chooseCustomDownloadFolder,
    useDefault: confirmDefaultDownloadFolder,
    cancel: cancelDownloadFolderPrompt,
  };
}

export async function getDefaultDownloadsDir(): Promise<string | null> {
  if (!isTauri()) return null;
  if (state.defaultDir) return state.defaultDir;
  try {
    const dir = await invoke<string>("download_default_dir");
    state = { ...state, defaultDir: dir };
    setupState = { ...setupState, defaultDir: dir };
    emit();
    emitSetup();
    return dir;
  } catch {
    return null;
  }
}

async function attachProgressListener() {
  if (listenerReady || !isTauri()) return;
  listenerReady = true;
  try {
    unlistenProgress = await listen<DownloadJob>("abx://download-progress", (ev) => {
      const job = ev.payload;
      if (!job?.id) return;
      const prev = state.jobs.find((j) => j.id === job.id);

      let nextJobs: DownloadJob[];
      if (job.status === "cancelled") {
        nextJobs = state.jobs.filter((j) => j.id !== job.id);
      } else {
        const exists = state.jobs.some((j) => j.id === job.id);
        nextJobs = exists ? state.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...state.jobs];
      }
      state = { ...state, jobs: nextJobs };
      emit();

      if (job.status === "completed" && prev?.status !== "completed") {
        autoRecoveryAttempted.delete(job.id);
        const epTag = !job.isFilm && job.episode != null ? ` S${String(job.season ?? 1).padStart(2, "0")}E${String(job.episode).padStart(2, "0")}` : "";
        const qInfo = formatDownloadQuality(job);
        const qPart = qInfo.verified ? ` (${qInfo.label})` : "";
        toast(`Saved “${job.title}${epTag}”${qPart} for offline playback`, { icon: "check" });
        void refreshDownloads().then(() => notifyDownloadsChanged());
      } else if (job.status === "failed" && prev?.status !== "failed") {
        const msg = job.error || "";
        const isLocalError = /no space|disk full|permission|access is denied|read-only|outside the downloads|disk write/i.test(msg);
        if (!isLocalError && !autoRecoveryAttempted.has(job.id)) {
          autoRecoveryAttempted.add(job.id);
          void switchDownloadToNextServer(job, { auto: true }).then((switched) => {
            if (!switched) {
              toast(`Download failed: ${msg || job.title}`, { icon: "info" });
            }
          });
        } else {
          toast(`Download failed: ${msg || job.title}`, { icon: "info" });
        }
      }
    });
  } catch {
    listenerReady = false;
  }
}

export async function refreshDownloads(): Promise<DownloadSnapshot | null> {
  if (!isTauri()) return null;
  try {
    const snap = await invoke<DownloadSnapshot>("download_list");
    applySnapshot(snap);
    return snap;
  } catch {
    return null;
  }
}

export interface MigrateDownloadsResponse {
  root: string | null;
  movedFiles: number;
  migrated: boolean;
}

export async function configureDownloadsRoot(dir: string): Promise<string | null> {
  if (!isTauri() || !dir.trim()) return null;
  const trimmed = dir.trim();
  const snap = await invoke<DownloadSnapshot>("download_init_root", { root: trimmed });
  initializedRoot = snap.root ?? trimmed;
  if (normalizePathKey(getSettings().downloadsPath) !== normalizePathKey(initializedRoot)) {
    updateSettings({ downloadsPath: initializedRoot });
  }
  applySnapshot(snap);
  notifyDownloadsChanged();
  return initializedRoot;
}

export async function migrateDownloadsFolder(
  newDir: string,
  moveFiles: boolean,
): Promise<MigrateDownloadsResponse> {
  if (!isTauri() || !newDir.trim()) {
    return { root: null, movedFiles: 0, migrated: false };
  }
  const res = await invoke<{ snapshot: DownloadSnapshot; movedFiles: number; migrated: boolean }>(
    "download_migrate_root",
    { newRoot: newDir.trim(), moveFiles },
  );
  initializedRoot = res.snapshot.root ?? newDir.trim();
  if (normalizePathKey(getSettings().downloadsPath) !== normalizePathKey(initializedRoot)) {
    updateSettings({ downloadsPath: initializedRoot });
  }
  applySnapshot(res.snapshot);
  notifyDownloadsChanged();
  return { root: initializedRoot, movedFiles: res.movedFiles, migrated: res.migrated };
}

export async function initDownloads(): Promise<void> {
  if (!isTauri()) return;
  await attachProgressListener();
  void getDefaultDownloadsDir();
  const saved = getSettings().downloadsPath;
  if (saved && normalizePathKey(saved) !== normalizePathKey(initializedRoot)) {
    try {
      const snap = await invoke<DownloadSnapshot>("download_init_root", { root: saved });
      initializedRoot = snap.root ?? saved;
      if (getSettings().downloadsPath !== initializedRoot) {
        updateSettings({ downloadsPath: initializedRoot });
      }
      applySnapshot(snap);
      notifyDownloadsChanged();
    } catch {
      /* folder unreachable (unplugged drive): keep configured path without losing settings */
    }
  }
}

export function ensureDownloadFolder(): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  const saved = getSettings().downloadsPath;
  if (saved) {
    void attachProgressListener();
    if (normalizePathKey(initializedRoot) !== normalizePathKey(saved)) {
      if (!folderInitInFlight) {
        folderInitInFlight = configureDownloadsRoot(saved)
          .catch(() => {
            toast("Downloads folder is unreachable. Reconnect it or choose a new folder in Settings.", {
              icon: "info",
            });
            return null;
          })
          .finally(() => {
            folderInitInFlight = null;
          });
      }
      return folderInitInFlight;
    }
    return Promise.resolve(initializedRoot ?? saved);
  }
  if (setupPending) return setupPending;

  setupPending = (async () => {
    await attachProgressListener();
    const defDir = await getDefaultDownloadsDir();
    setupState = { open: true, defaultDir: defDir, busy: false };
    emitSetup();
    return await new Promise<string | null>((resolve) => {
      setupResolve = resolve;
    });
  })();
  return setupPending;
}

function resolveSetup(dir: string | null) {
  const res = setupResolve;
  setupResolve = null;
  setupPending = null;
  setupState = { ...setupState, open: false, busy: false };
  emitSetup();
  res?.(dir);
}

async function chooseCustomDownloadFolder() {
  if (!setupState.open || setupState.busy) return;
  setupState = { ...setupState, busy: true };
  emitSetup();
  try {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: setupState.defaultDir ?? undefined,
      title: "Choose or create a Downloads folder",
    });
    if (typeof picked === "string" && picked.trim()) {
      const configured = await configureDownloadsRoot(picked);
      resolveSetup(configured);
      return;
    }
  } catch (e: unknown) {
    toast(`Couldn't select folder: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
  setupState = { ...setupState, busy: false };
  emitSetup();
}

async function confirmDefaultDownloadFolder() {
  if (!setupState.open || setupState.busy) return;
  setupState = { ...setupState, busy: true };
  emitSetup();
  try {
    const dir = setupState.defaultDir ?? (await getDefaultDownloadsDir());
    if (dir) {
      const configured = await configureDownloadsRoot(dir);
      resolveSetup(configured);
      return;
    }
  } catch (e: unknown) {
    toast(`Couldn't initialize Downloads folder: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
  setupState = { ...setupState, busy: false };
  emitSetup();
}

function cancelDownloadFolderPrompt() {
  if (!setupState.open) return;
  resolveSetup(null);
}

function compactSnapshot(media: Media, detail?: MediaDetail): Partial<MediaDetail> {
  const src: Partial<MediaDetail> = detail ?? media;
  return {
    key: media.key,
    canonicalKey: src.canonicalKey ?? media.key,
    kind: media.kind,
    title: media.title,
    originalTitle: media.originalTitle,
    overview: media.overview,
    poster: media.poster,
    backdrop: media.backdrop,
    year: media.year,
    rating: media.rating,
    genres: media.genres ?? [],
    runtime: src.runtime,
    format: media.format,
    episodeCount: src.episodeCount,
    totalEpisodes: src.totalEpisodes,
    status: media.status,
    originalLanguage: media.originalLanguage,
    certification: src.certification,
    tmdbId: src.tmdbId,
    imdbId: src.imdbId,
    anilistId: media.anilistId ?? src.anilistId,
    malId: media.malId ?? src.malId,
    seasons: src.seasons,
    specials: src.specials,
    initialSeason: src.initialSeason,
  };
}

const TMDB_ART_RX = /^(https:\/\/image\.tmdb\.org\/t\/p\/)[a-z0-9]+(\/.+)$/;
function sizeTmdbArt(url: string | undefined, size: string): string | undefined {
  const m = url?.match(TMDB_ART_RX);
  return m ? `${m[1]}${size}${m[2]}` : url;
}

export function localArtUrl(path?: string): string | undefined {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : undefined;
}

export function buildDownloadSource(candidate: StreamCandidate): DownloadSourceReq {
  const rawSource = candidate.downloadUrl ?? candidate.url;
  const unwrapped = unwrapProxyUrl(rawSource);
  const targetKind = candidate.downloadUrl ? "file" : candidate.kind === "hls" ? "hls" : "file";
  const headers = candidate.downloadUrl
    ? (candidate.headers ?? {})
    : { ...unwrapped.headers, ...candidate.headers };

  const subtitles: DownloadSubtitleReq[] = (candidate.subtitles ?? [])
    .filter((s) => s.url && (/^https?:\/\//i.test(s.url) || PROXY_URL_RX.test(s.url)))
    .slice(0, 6)
    .map((s) => {
      const subUnwrapped = unwrapProxyUrl(s.url);
      return {
        lang: s.lang || "und",
        label: s.label || "Subtitles",
        url: subUnwrapped.url,
        ...(s.format ? { format: s.format } : {}),
        ...(Object.keys(subUnwrapped.headers).length ? { headers: subUnwrapped.headers } : {}),
        ...(s.isForced != null ? { isForced: s.isForced } : {}),
        ...(s.isHearingImpaired != null ? { isHearingImpaired: s.isHearingImpaired } : {}),
      };
    });

  return {
    providerId: candidate.providerId,
    providerName: candidate.providerName,
    url: unwrapped.url,
    kind: targetKind,
    headers,
    quality: candidate.probe?.quality ?? candidate.quality,
    subtitles,
  };
}

export async function startDownload(
  req: PlaybackRequest,
  candidate: StreamCandidate,
  detail?: MediaDetail,
  episodeTitle?: string,
  opts?: {
    silent?: boolean;
    fallbacks?: StreamCandidate[];
    preferredQuality?: number;
    replaceExisting?: boolean;
  },
): Promise<DownloadJob | null> {
  if (!isTauri()) {
    toast("Offline downloads work in the AbixCine desktop app.", { icon: "info" });
    return null;
  }
  const root = await ensureDownloadFolder();
  if (!root) return null;

  const primary = buildDownloadSource(candidate);
  const seenUrls = new Set<string>([primary.url.toLowerCase()]);
  const seenProviders = new Set<string>([primary.providerId]);
  const fallbacks: DownloadSourceReq[] = [];
  for (const fbCand of opts?.fallbacks ?? []) {
    if (fallbacks.length >= 6) break;
    const fb = buildDownloadSource(fbCand);
    const low = fb.url.toLowerCase();
    if (seenUrls.has(low) || seenProviders.has(fb.providerId)) continue;
    seenUrls.add(low);
    seenProviders.add(fb.providerId);
    fallbacks.push(fb);
  }

  const targetQuality = opts?.preferredQuality ?? getSettings().preferredQuality;
  const mediaDetail = detail ?? (req.media as Partial<MediaDetail>);
  const posterUrl = sizeTmdbArt(req.media.poster ?? detail?.poster, "w500");
  const backdropUrl = sizeTmdbArt(req.media.backdrop ?? detail?.backdrop, "w1280");
  const payload = {
    root,
    mediaKey: req.media.key,
    canonicalKey: mediaDetail.canonicalKey ?? req.media.key,
    title: req.media.title,
    mediaKind: req.media.kind,
    isFilm: isFilm(req.media),
    year: req.media.year,
    season: req.season,
    episode: req.episode,
    episodeTitle,
    audio: req.audio ?? (candidate.audio !== "unknown" ? candidate.audio : undefined),
    quality: primary.quality,
    providerId: primary.providerId,
    providerName: primary.providerName,
    url: primary.url,
    kind: primary.kind,
    headers: primary.headers,
    preferredQuality: targetQuality,
    subtitles: primary.subtitles,
    fallbacks,
    replaceExisting: opts?.replaceExisting ?? true,
    posterUrl,
    backdropUrl,
    mediaSnapshot: compactSnapshot(req.media, detail),
  };

  try {
    const job = await invoke<DownloadJob>("download_start", { req: payload });
    autoRecoveryAttempted.delete(job.id);
    const exists = state.jobs.some((j) => j.id === job.id);
    state = { ...state, jobs: exists ? state.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...state.jobs] };
    emit();
    if (!opts?.silent) {
      const qLabel = targetQuality >= 2160 ? "4K" : `${targetQuality}p`;
      const backupNote = fallbacks.length > 0 ? ` · ${fallbacks.length} backup${fallbacks.length === 1 ? "" : "s"}` : "";
      toast(`Queued “${req.media.title}” (${candidate.providerName} · up to ${qLabel}${backupNote})`, { icon: "download" });
    }
    return job;
  } catch (e: unknown) {
    if (!opts?.silent) {
      toast(`Couldn't start download: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
    }
    return null;
  }
}

export async function switchDownloadSource(
  id: string,
  candidate: StreamCandidate,
  extraFallbacks: StreamCandidate[] = [],
  preferredQuality?: number,
): Promise<DownloadJob | null> {
  if (!isTauri()) return null;
  const source = buildDownloadSource(candidate);
  const seenUrls = new Set<string>([source.url.toLowerCase()]);
  const fallbacks: DownloadSourceReq[] = [];
  for (const c of extraFallbacks) {
    if (fallbacks.length >= 6) break;
    const fb = buildDownloadSource(c);
    const low = fb.url.toLowerCase();
    if (seenUrls.has(low) || fb.providerId === source.providerId) continue;
    seenUrls.add(low);
    fallbacks.push(fb);
  }
  try {
    const job = await invoke<DownloadJob | null>("download_switch_source", {
      id,
      source,
      extraFallbacks: fallbacks,
      preferredQuality: preferredQuality ?? getSettings().preferredQuality,
    });
    if (job) {
      autoRecoveryAttempted.delete(job.id);
      const exists = state.jobs.some((j) => j.id === job.id);
      state = { ...state, jobs: exists ? state.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...state.jobs] };
      emit();
    }
    return job;
  } catch (e: unknown) {
    toast(`Couldn't switch server: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
    return null;
  }
}

export async function switchDownloadToNextServer(
  job: DownloadJob,
  opts?: { auto?: boolean },
): Promise<boolean> {
  if (!isTauri()) return false;
  if (state.switchingIds.has(job.id)) return false;
  setSwitching(job.id, true);
  if (!opts?.auto) {
    toast(`Finding another server for “${job.title}”…`, { icon: "download" });
  }
  try {
    const [{ acquireSession }, { getDetail, resolvePlaybackRequest }, { rankDownloadOptions }] = await Promise.all([
      import("../sources/session"),
      import("./catalog"),
      import("./downloadRank"),
    ]);

    const detail = await getDetail(job.canonicalKey || job.mediaKey).catch(() => null);
    const audioPref = job.audio === "sub" || job.audio === "dub" ? job.audio : undefined;
    let req: PlaybackRequest | null = null;
    if (detail) {
      req = resolvePlaybackRequest(detail, job.season, job.episode, audioPref);
    }
    if (!req) {
      req = {
        media: {
          key: job.mediaKey,
          kind: (job.mediaKind as Media["kind"]) || "movie",
          title: job.title,
          overview: "",
          genres: [],
          year: job.year,
        },
        ...(job.season != null ? { season: job.season } : {}),
        ...(job.episode != null ? { episode: job.episode } : {}),
        ...(audioPref ? { audio: audioPref } : {}),
      };
    }

    const tried = new Set<string>([job.providerId, ...(job.triedProviders ?? [])]);
    const targetQ = job.preferredQuality ?? getSettings().preferredQuality;
    const session = acquireSession(req);
    session.retain();
    session.start(3);

    const picked = await new Promise<{ next: StreamCandidate; rest: StreamCandidate[] } | null>((resolve) => {
      let settled = false;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const pickFromSnap = () => {
        const snap = session.getSnapshot();
        const ranked = rankDownloadOptions(snap.candidates, targetQ);
        const freshProvider = ranked.find(
          (c) => !tried.has(c.providerId) && unwrapProxyUrl(c.downloadUrl ?? c.url).url !== job.url,
        );
        const anyOtherUrl = ranked.find((c) => unwrapProxyUrl(c.downloadUrl ?? c.url).url !== job.url);
        return { snap, chosen: freshProvider ?? anyOtherUrl, ranked };
      };

      const finish = (useResult: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(graceTimer);
        unsub();
        const { chosen, ranked } = pickFromSnap();
        session.release();
        if (!useResult || !chosen) {
          resolve(null);
          return;
        }
        resolve({ next: chosen, rest: ranked.filter((c) => c !== chosen && !tried.has(c.providerId)) });
      };

      const check = () => {
        const { snap, chosen } = pickFromSnap();
        if (chosen && !snap.busy) {
          finish(true);
          return;
        }
        if (chosen && !graceTimer) {
          graceTimer = setTimeout(() => finish(true), 1200);
        }
        if (!snap.busy && !chosen) {
          finish(false);
        }
      };

      hardTimer = setTimeout(() => finish(true), 10_000);
      const unsub = session.subscribe(check);
      check();
    });

    if (!picked) {
      if (!opts?.auto) {
        toast(`No working backup server found for “${job.title}”`, { icon: "info" });
      }
      return false;
    }

    const updated = await switchDownloadSource(job.id, picked.next, picked.rest.slice(0, 5), targetQ);
    if (updated) {
      toast(
        opts?.auto
          ? `Switched “${job.title}” to ${picked.next.providerName}`
          : `Now downloading “${job.title}” from ${picked.next.providerName}`,
        { icon: "download" },
      );
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    setSwitching(job.id, false);
  }
}

export async function clearFailedDownloads(): Promise<void> {
  if (!isTauri()) return;
  try {
    const snap = await invoke<DownloadSnapshot>("download_clear_failed");
    applySnapshot(snap);
  } catch (e: unknown) {
    toast(`Couldn't clear failed downloads: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function pauseDownload(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const job = await invoke<DownloadJob | null>("download_pause", { id });
    if (job) {
      state = { ...state, jobs: state.jobs.map((j) => (j.id === job.id ? job : j)) };
      emit();
    }
  } catch (e: unknown) {
    toast(`Couldn't pause download: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function resumeDownload(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const job = await invoke<DownloadJob | null>("download_resume", { id });
    if (job) {
      state = { ...state, jobs: state.jobs.map((j) => (j.id === job.id ? job : j)) };
      emit();
    }
  } catch (e: unknown) {
    toast(`Couldn't resume download: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function cancelDownload(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("download_cancel", { id });
    state = { ...state, jobs: state.jobs.filter((j) => j.id !== id) };
    emit();
  } catch (e: unknown) {
    toast(`Couldn't cancel download: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function pauseAllDownloads(scope?: { canonicalKey?: string; season?: number }): Promise<void> {
  if (!isTauri()) return;
  try {
    const snap = await invoke<DownloadSnapshot>("download_pause_all", {
      canonicalKey: scope?.canonicalKey ?? null,
      season: scope?.season ?? null,
    });
    applySnapshot(snap);
    toast(
      scope?.season != null ? `Paused Season ${scope.season} downloads` : "Paused active downloads",
      { icon: "info" },
    );
  } catch (e: unknown) {
    toast(`Couldn't pause downloads: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function resumeAllDownloads(scope?: { canonicalKey?: string; season?: number }): Promise<void> {
  if (!isTauri()) return;
  try {
    const snap = await invoke<DownloadSnapshot>("download_resume_all", {
      canonicalKey: scope?.canonicalKey ?? null,
      season: scope?.season ?? null,
    });
    applySnapshot(snap);
    toast(
      scope?.season != null ? `Resumed Season ${scope.season} downloads` : "Resumed queued downloads",
      { icon: "download" },
    );
  } catch (e: unknown) {
    toast(`Couldn't resume downloads: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function cancelAllDownloads(scope?: { canonicalKey?: string; season?: number }): Promise<void> {
  batchCancelHook?.(scope);
  if (!isTauri()) return;
  try {
    const snap = await invoke<DownloadSnapshot>("download_cancel_all", {
      canonicalKey: scope?.canonicalKey ?? null,
      season: scope?.season ?? null,
    });
    applySnapshot({
      ...snap,
      jobs: (snap.jobs ?? []).filter((j) => j.status !== "cancelled"),
    });
    toast(
      scope?.season != null
        ? `Stopped & cleared Season ${scope.season} downloads`
        : "Stopped & cleared all downloads",
      { icon: "info" },
    );
  } catch (e: unknown) {
    toast(`Couldn't stop downloads: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function removeDownloadedItem(id: string, deleteFile = true): Promise<void> {
  if (!isTauri()) return;
  try {
    const snap = await invoke<DownloadSnapshot>("download_remove", { id, deleteFile });
    applySnapshot(snap);
    notifyDownloadsChanged();
  } catch (e: unknown) {
    toast(`Couldn't remove download: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export async function openDownloadsFolder(path?: string): Promise<void> {
  if (!isTauri()) return;
  const target = path || state.root || getSettings().downloadsPath || (await getDefaultDownloadsDir());
  if (!target) return;
  try {
    await invoke("download_open_folder", { path: target });
  } catch (e: unknown) {
    toast(`Couldn't open folder: ${e instanceof Error ? e.message : String(e)}`, { icon: "info" });
  }
}

export function clearDownloadsConfig(): void {
  initializedRoot = null;
  updateSettings({ downloadsPath: undefined });
  state = { ...state, root: null, jobs: [], items: [] };
  emit();
  notifyDownloadsChanged();
}

export function disposeDownloadsListener(): void {
  unlistenProgress?.();
  unlistenProgress = null;
  listenerReady = false;
}

/* --------------------------------------------------------- synchronous query helpers */

function keySetForReq(req: Pick<PlaybackRequest, "media">): Set<string> {
  const keys = new Set<string>([req.media.key]);
  const canonical = (req.media as Partial<MediaDetail>).canonicalKey;
  if (canonical) keys.add(canonical);
  return keys;
}

function entryMatchesKeys(entry: { mediaKey: string; canonicalKey: string }, keys: Set<string>): boolean {
  return keys.has(entry.canonicalKey) || keys.has(entry.mediaKey);
}

/** Match completed downloaded entries in the index for a playback request. */
export function findDownloadedEntries(
  req: PlaybackRequest,
  items: DownloadedEntry[] = state.items,
): DownloadedEntry[] {
  const keys = keySetForReq(req);
  const film = isFilm(req.media);
  return items.filter((e) => {
    if (!entryMatchesKeys(e, keys)) return false;
    if (film !== e.isFilm) return false;
    if (!film && req.episode != null) {
      if (req.season != null && e.season != null && e.season !== req.season) return false;
      if (e.episode != null && e.episode !== req.episode) return false;
    }
    if (req.audio && e.audio && e.audio !== "dual" && e.audio !== req.audio) return false;
    return true;
  });
}

/** Find an active, queued, paused, or completed download job for a request (optionally matching a server/URL). */
export function findDownloadJob(
  req: PlaybackRequest,
  candidate?: StreamCandidate,
  jobs: DownloadJob[] = state.jobs,
): DownloadJob | undefined {
  const keys = keySetForReq(req);
  const film = isFilm(req.media);
  const rawCand = candidate ? unwrapProxyUrl(candidate.downloadUrl ?? candidate.url).url : undefined;
  return jobs.find((j) => {
    if (j.status === "cancelled") return false;
    if (!entryMatchesKeys(j, keys)) return false;
    if (film !== j.isFilm) return false;
    if (!film && req.episode != null) {
      if (req.season != null && j.season != null && j.season !== req.season) return false;
      if (j.episode != null && j.episode !== req.episode) return false;
    }
    if (req.audio && j.audio && j.audio !== "dual" && j.audio !== req.audio) return false;
    if (rawCand) {
      return j.url === rawCand || j.providerId === candidate?.providerId;
    }
    return true;
  });
}

function detailMatchesKey(entry: DownloadedEntry, key: string): boolean {
  if (entry.canonicalKey === key || entry.mediaKey === key) return true;
  const snap = entry.mediaSnapshot;
  if (!snap) return false;
  if (snap.canonicalKey === key || snap.key === key) return true;
  for (const s of [...(snap.seasons ?? []), ...(snap.specials ?? [])]) {
    if (s.key === key) return true;
    if (s.cours?.some((c) => c.key === key)) return true;
  }
  return false;
}

/** Reconstruct cached `MediaDetail` from downloaded items so Title/Watch pages work fully offline. */
export function findOfflineDetail(key: string, items: DownloadedEntry[] = state.items): MediaDetail | undefined {
  const mine = items.filter((e) => detailMatchesKey(e, key));
  if (!mine.length) return undefined;
  const primary = mine[0];
  const snap = primary.mediaSnapshot ?? {};
  const localPoster = mine.map((m) => localArtUrl(m.posterPath)).find(Boolean);
  const localBackdrop = mine.map((m) => localArtUrl(m.backdropPath)).find(Boolean);

  const seasons = snap.seasons && snap.seasons.length > 0
    ? snap.seasons
    : !primary.isFilm
      ? [...new Set(mine.map((m) => m.season ?? 1))]
          .sort((a, b) => a - b)
          .map((num) => ({
            number: num,
            name: num === 0 ? "Specials" : `Season ${num}`,
            episodeCount: Math.max(...mine.filter((m) => (m.season ?? 1) === num).map((m) => m.episode ?? 1)),
            status: (num === 0 ? "special" : "aired") as "special" | "aired",
          }))
      : undefined;

  return {
    key: snap.key ?? primary.mediaKey,
    canonicalKey: snap.canonicalKey ?? primary.canonicalKey,
    kind: (snap.kind ?? primary.mediaKind) as Media["kind"],
    title: snap.title ?? primary.title,
    originalTitle: snap.originalTitle,
    overview: snap.overview ?? "Saved in your Downloads vault for offline playback.",
    poster: localPoster ?? snap.poster,
    backdrop: localBackdrop ?? snap.backdrop,
    year: snap.year ?? primary.year,
    rating: snap.rating,
    genres: snap.genres ?? [],
    runtime: snap.runtime,
    format: snap.format,
    episodeCount: snap.episodeCount ?? seasons?.[0]?.episodeCount,
    totalEpisodes: snap.totalEpisodes,
    status: snap.status ?? "RELEASED",
    originalLanguage: snap.originalLanguage,
    certification: snap.certification,
    tmdbId: snap.tmdbId,
    imdbId: snap.imdbId,
    anilistId: snap.anilistId,
    malId: snap.malId,
    seasons,
    specials: snap.specials,
    initialSeason: snap.initialSeason ?? seasons?.[0]?.number,
    cast: snap.cast ?? [],
    crew: snap.crew ?? [],
    related: snap.related ?? [],
  };
}

/** Synthesize an episode list from downloaded files when offline catalog fetches fail. */
export function findOfflineSeasonEpisodes(
  key: string,
  season = 1,
  items: DownloadedEntry[] = state.items,
): Episode[] {
  const seen = new Map<number, DownloadedEntry>();
  for (const e of items) {
    if (e.isFilm || !detailMatchesKey(e, key)) continue;
    if ((e.season ?? 1) !== season || e.episode == null) continue;
    if (!seen.has(e.episode)) seen.set(e.episode, e);
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([num, e]) => ({
      season: e.season ?? season,
      number: num,
      title: e.episodeTitle || `Episode ${num}`,
      overview: `Saved offline (${e.providerName})`,
      sourceKey: e.mediaKey,
      courEpisode: num,
    }));
}

export interface DownloadedTitleGroup {
  canonicalKey: string;
  media: MediaDetail;
  entries: DownloadedEntry[];
  totalSize: number;
  bestQuality?: number;
  audioTags: string[];
  isFilm: boolean;
  latestAt: number;
}

/** Group downloaded episode/film entries into sorted per-title offline vault cards. */
export function groupDownloadedTitles(items: DownloadedEntry[] = state.items): DownloadedTitleGroup[] {
  const byKey = new Map<string, DownloadedEntry[]>();
  for (const it of items) {
    const k = it.canonicalKey || it.mediaKey;
    const arr = byKey.get(k);
    if (arr) arr.push(it);
    else byKey.set(k, [it]);
  }
  const groups: DownloadedTitleGroup[] = [];
  for (const [canonicalKey, entries] of byKey) {
    const sorted = [...entries].sort(
      (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || b.downloadedAt - a.downloadedAt,
    );
    const media = findOfflineDetail(canonicalKey, entries) ?? {
      key: sorted[0].mediaKey,
      canonicalKey,
      kind: sorted[0].mediaKind as Media["kind"],
      title: sorted[0].title,
      overview: "",
      genres: [],
      cast: [],
      crew: [],
      related: [],
    };
    const totalSize = sorted.reduce((sum, e) => sum + (e.fileSize || 0), 0);
    const bestQuality = sorted.reduce<number | undefined>(
      (max, e) => (e.quality ? Math.max(max ?? 0, e.quality) : max),
      undefined,
    );
    const audioTags = [...new Set(sorted.map((e) => e.audio).filter((a): a is string => Boolean(a && a !== "unknown")))];
    const latestAt = sorted.reduce((max, e) => Math.max(max, e.downloadedAt || 0), 0);
    groups.push({
      canonicalKey,
      media,
      entries: sorted,
      totalSize,
      bestQuality,
      audioTags,
      isFilm: sorted[0].isFilm,
      latestAt,
    });
  }
  return groups.sort((a, b) => b.latestAt - a.latestAt || a.media.title.localeCompare(b.media.title));
}

/** Return the saved offline entry for a specific episode (and optional audio variant), if present. */
export function findDownloadedEpisode(
  canonicalKey: string,
  season: number | undefined,
  episode: number,
  audio?: string,
  items: DownloadedEntry[] = state.items,
): DownloadedEntry | undefined {
  return items.find((e) => {
    if (e.isFilm) return false;
    if (e.canonicalKey !== canonicalKey && e.mediaKey !== canonicalKey) return false;
    if (season != null && e.season != null && e.season !== season) return false;
    if (e.episode !== episode) return false;
    if (audio && e.audio && e.audio !== "dual" && e.audio !== audio) return false;
    return true;
  });
}

/** Check whether a specific episode (and optional audio variant) is already saved offline. */
export function hasDownloadedEpisode(
  canonicalKey: string,
  season: number | undefined,
  episode: number,
  audio?: string,
  items: DownloadedEntry[] = state.items,
): boolean {
  return Boolean(findDownloadedEpisode(canonicalKey, season, episode, audio, items));
}

/** Compact resolution tag such as "4K ✓" or "1080p" for episode pills and summary cards. */
export function formatQualityTag(quality?: number, verified?: boolean): string | null {
  if (!quality || quality <= 0) return null;
  const label = quality >= 2160 ? "4K" : `${quality}p`;
  return verified ? `${label} ✓` : label;
}

export interface SeasonDownloadProgress {
  total: number;
  completed: number;
  active: number;
  paused: number;
  failed: number;
  percent: number;
  completedPercent: number;
  speedBps: number;
  downloadingQualities: string[];
  downloadedQualities: string[];
}

/** Aggregate live download progress, completed ratio, and quality tags across all aired episodes in a season. */
export function computeSeasonDownloadProgress(
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
): SeasonDownloadProgress {
  const aired = episodes.filter(
    (ep) => !isUnairedEpisode(ep, { airedCount: opts.airedCount, seriesStatus: opts.seriesStatus }),
  );
  const total = aired.length;
  let completed = 0;
  let active = 0;
  let paused = 0;
  let failed = 0;
  let fractional = 0;
  let speedBps = 0;
  const dlQuals = new Set<string>();
  const savedQuals = new Set<string>();

  for (const ep of aired) {
    const saved = findDownloadedEpisode(opts.canonicalKey, opts.season, ep.number, opts.audio, opts.items);
    if (saved) {
      completed++;
      fractional += 1;
      const q = formatQualityTag(saved.quality, saved.qualityVerified);
      if (q) savedQuals.add(q);
      continue;
    }
    const job = opts.jobs.find(
      (j) =>
        !j.isFilm &&
        j.status !== "cancelled" &&
        j.status !== "completed" &&
        (j.canonicalKey === opts.canonicalKey || j.mediaKey === opts.canonicalKey) &&
        (j.season == null || j.season === opts.season) &&
        j.episode === ep.number &&
        (!opts.audio || !j.audio || j.audio === "dual" || j.audio === opts.audio),
    );
    if (!job) continue;
    if (job.status === "failed") {
      failed++;
      continue;
    }
    if (job.status === "paused") {
      paused++;
    } else {
      active++;
      speedBps += job.speedBps || 0;
    }
    fractional += Math.max(0, Math.min(0.99, (job.percent || 0) / 100));
    const qInfo = formatDownloadQuality(job);
    if (qInfo.label) dlQuals.add(qInfo.verified ? `${qInfo.label} ✓` : qInfo.label);
  }

  const percent = total > 0 ? Math.max(0, Math.min(100, (fractional / total) * 100)) : 0;
  const completedPercent = total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
  return {
    total,
    completed,
    active,
    paused,
    failed,
    percent,
    completedPercent,
    speedBps,
    downloadingQualities: [...dlQuals],
    downloadedQualities: [...savedQuals],
  };
}

/** Human-readable transfer speed ("12.4 MB/s"). */
export function fmtSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

/** Compact remaining-time string ("1m 14s", "42s", "1h 04m"). */
export function fmtEta(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "";
  const s = Math.ceil(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

/** Compact, user-friendly quality label & verification status for UI badges and toasts. */
export function formatDownloadQuality(
  job: Pick<DownloadJob, "resolvedQuality" | "quality" | "preferredQuality" | "qualityVerified">,
): { label: string; verified: boolean; title: string } {
  const q = job.resolvedQuality ?? job.quality;
  const pref = job.preferredQuality;
  const fmtQ = (n: number) => (n >= 2160 ? "4K" : `${n}p`);
  if (q && q > 0) {
    const qStr = fmtQ(q);
    if (job.qualityVerified) {
      const prefNote = pref ? ` (target: ${fmtQ(pref)})` : "";
      return { label: qStr, verified: true, title: `Verified ${qStr} stream${prefNote}` };
    }
    return { label: `~${qStr}`, verified: false, title: `Reported ${qStr} stream` };
  }
  if (pref && pref > 0) {
    const pStr = fmtQ(pref);
    return { label: `Up to ${pStr}`, verified: false, title: `Targeting ${pStr} quality` };
  }
  return { label: "Auto", verified: false, title: "Best available quality" };
}

/** Seed test snapshot directly in Vitest without needing Tauri IPC. */
export function __setDownloadsStateForTest(next: Partial<DownloadsStoreState>) {
  state = { ...state, ...next };
  emit();
}
