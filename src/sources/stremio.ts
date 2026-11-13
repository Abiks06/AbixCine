import { resolveAnimeIdsSync } from "../lib/animeMapping";
import {
  checkDebridInstantCache,
  loadDebridConfig,
  resolveDebridStream,
  toMagnetUri,
  type DebridConfig,
  type DebridProvider,
} from "../lib/debrid";
import type { Settings } from "../lib/settings";
import { langLabel, normalizeSubLang } from "../lib/subtitles";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { normalizeQuality, resolveMediaIds } from "./extractors/common";
import { httpFetch, normalizeHeaders, proxyUrl, type FetchResult, type StreamHeaders } from "./native";
import {
  inferSubtitleMeta,
  isThumbnailSubtitleUrl,
  type SourceProvider,
  type StreamCandidate,
  type StreamKind,
  type SubtitleTrack,
} from "./types";

export const STREMIO_STORAGE_KEY = "abx.stremio.v1";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEBRID_RESOLVE_CONCURRENCY = 4;
const DEBRID_MAX_CANDIDATES = 8;

export interface StremioResourceSpec {
  name: string;
  types?: string[];
  idPrefixes?: string[];
}

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  resources: Array<string | StremioResourceSpec>;
  types: string[];
  idPrefixes?: string[];
  behaviorHints?: {
    configurable?: boolean;
    configurationRequired?: boolean;
  };
}

export interface StremioAddonConfig {
  id: string;
  name: string;
  manifestUrl: string;
  baseUrl: string;
  enabled: boolean;
  version?: string;
  description?: string;
  resources?: Array<string | StremioResourceSpec>;
  types?: string[];
  idPrefixes?: string[];
  addedAt?: number;
}

export interface StremioStorageState {
  addons: StremioAddonConfig[];
  debrid?: DebridConfig | null;
  torrentMode?: boolean;
}

export interface StremioSettingsOverride {
  stremio?: Partial<StremioStorageState>;
  stremioAddons?: StremioAddonConfig[];
  debrid?: DebridConfig | null;
  torrentMode?: boolean;
}

export interface StremioStreamBehaviorHints {
  notWebReady?: boolean;
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
  proxyHeaders?: {
    request?: Record<string, string>;
    response?: Record<string, string>;
  };
}

export interface StremioSubtitleEntry {
  id?: string;
  url: string;
  lang: string;
}

export interface StremioStreamObject {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  externalUrl?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  subtitles?: StremioSubtitleEntry[];
  behaviorHints?: StremioStreamBehaviorHints;
}

export interface StremioStreamCandidate extends StreamCandidate {
  addonId?: string;
  infoHash?: string;
  fileIdx?: number;
  magnet?: string;
  trackers?: string[];
  sizeBytes?: number;
  notWebReady?: boolean;
  debridProvider?: DebridProvider;
}

export interface StremioSubtitleQuery {
  imdbId?: string;
  kind?: "movie" | "tv" | "anime";
  season?: number;
  episode?: number;
  videoHash?: string;
  videoSize?: number;
  filename?: string;
}

export interface StremioSubtitleResult extends SubtitleTrack {
  id: string;
  addonId: string;
  addonName: string;
  langName: string;
}

export interface StremioResolveOptions {
  addons?: StremioAddonConfig[];
  debrid?: DebridConfig | null;
  torrentMode?: boolean;
  settings?: Partial<Settings> & StremioSettingsOverride;
}

function makeAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function isAbortErr(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

async function fetchWithAbort(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  if (signal?.aborted) throw makeAbortError(signal);
  const call = httpFetch(url, headers);
  return new Promise<FetchResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(makeAbortError(signal));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Stremio request timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    call.then(
      (res) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted) reject(makeAbortError(signal));
        else resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.aborted ? makeAbortError(signal) : err);
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* URL & Manifest Normalization                                       */
/* ------------------------------------------------------------------ */

export function normalizeManifestUrl(rawUrl: string): { manifestUrl: string; baseUrl: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("Stremio addon URL is empty");
  const httpUrl = trimmed.replace(/^stremio:\/\//i, "https://");
  let parsed: URL;
  try {
    parsed = new URL(httpUrl);
  } catch {
    throw new Error(`Invalid Stremio addon URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported Stremio addon protocol: ${parsed.protocol}`);
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!/\/manifest\.json$/i.test(pathname)) {
    pathname = `${pathname}/manifest.json`;
  }
  const manifestUrl = `${parsed.origin}${pathname}${parsed.search}`;
  const basePath = pathname.replace(/\/manifest\.json$/i, "");
  const baseUrl = `${parsed.origin}${basePath}`;
  return { manifestUrl, baseUrl };
}

function buildAddonEndpoint(baseUrl: string, path: string, manifestUrl?: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  let search = "";
  if (manifestUrl) {
    try {
      search = new URL(manifestUrl).search;
    } catch {
      /* ignore */
    }
  }
  return `${cleanBase}${path}${search}`;
}

function isValidHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/\S+/i.test(url.trim());
}

/**
 * Fetch and validate a Stremio addon `manifest.json`.
 * Accepts `https://...`, `http://...`, or `stremio://...` URLs.
 */
export async function fetchStremioManifest(url: string, signal?: AbortSignal): Promise<StremioAddonConfig> {
  const { manifestUrl, baseUrl } = normalizeManifestUrl(url);
  const res = await fetchWithAbort(manifestUrl, { Accept: "application/json" }, signal);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to fetch Stremio manifest (HTTP ${res.status})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error("Stremio manifest returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Stremio manifest payload");
  }

  const m = parsed as Partial<StremioManifest>;
  if (typeof m.id !== "string" || !m.id.trim()) {
    throw new Error("Stremio manifest is missing a valid 'id'");
  }
  if (typeof m.name !== "string" || !m.name.trim()) {
    throw new Error("Stremio manifest is missing a valid 'name'");
  }
  if (!Array.isArray(m.resources) || !Array.isArray(m.types)) {
    throw new Error("Stremio manifest must declare 'resources' and 'types' arrays");
  }

  return {
    id: m.id.trim(),
    name: m.name.trim(),
    manifestUrl,
    baseUrl,
    enabled: true,
    version: typeof m.version === "string" ? m.version : undefined,
    description: typeof m.description === "string" ? m.description : undefined,
    resources: m.resources,
    types: m.types.filter((t): t is string => typeof t === "string"),
    idPrefixes: Array.isArray(m.idPrefixes)
      ? m.idPrefixes.filter((p): p is string => typeof p === "string")
      : undefined,
    addedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Configuration Storage (`abx.stremio.v1`) + Settings Overrides      */
/* ------------------------------------------------------------------ */

function sanitizeAddonConfig(raw: unknown): StremioAddonConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Partial<StremioAddonConfig>;
  if (typeof rec.manifestUrl !== "string" || !rec.manifestUrl.trim()) return null;
  try {
    const normalized = normalizeManifestUrl(rec.manifestUrl);
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : normalized.baseUrl;
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    return {
      id,
      name,
      manifestUrl: normalized.manifestUrl,
      baseUrl: typeof rec.baseUrl === "string" && rec.baseUrl.trim() ? rec.baseUrl.replace(/\/+$/, "") : normalized.baseUrl,
      enabled: rec.enabled !== false,
      ...(typeof rec.version === "string" ? { version: rec.version } : {}),
      ...(typeof rec.description === "string" ? { description: rec.description } : {}),
      ...(Array.isArray(rec.resources) ? { resources: rec.resources } : {}),
      ...(Array.isArray(rec.types) ? { types: rec.types } : {}),
      ...(Array.isArray(rec.idPrefixes) ? { idPrefixes: rec.idPrefixes } : {}),
      ...(typeof rec.addedAt === "number" ? { addedAt: rec.addedAt } : {}),
    };
  } catch {
    return null;
  }
}

function readStoredState(): StremioStorageState {
  try {
    const raw = globalThis.localStorage?.getItem(STREMIO_STORAGE_KEY);
    if (!raw) return { addons: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        addons: parsed.map(sanitizeAddonConfig).filter((a): a is StremioAddonConfig => a !== null),
      };
    }
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Partial<StremioStorageState>;
      const addons = Array.isArray(rec.addons)
        ? rec.addons.map(sanitizeAddonConfig).filter((a): a is StremioAddonConfig => a !== null)
        : [];
      return {
        addons,
        debrid: rec.debrid ?? undefined,
        torrentMode: Boolean(rec.torrentMode),
      };
    }
  } catch {
    /* ignore storage errors */
  }
  return { addons: [] };
}

function writeStoredState(state: StremioStorageState): void {
  try {
    globalThis.localStorage?.setItem(STREMIO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore storage errors */
  }
}

export function getStremioConfig(override?: Partial<Settings> & StremioSettingsOverride): StremioStorageState {
  const stored = readStoredState();
  const overrideAddons = override?.stremio?.addons ?? override?.stremioAddons;
  const addons = Array.isArray(overrideAddons)
    ? overrideAddons.map(sanitizeAddonConfig).filter((a): a is StremioAddonConfig => a !== null)
    : stored.addons;
  const debrid =
    override?.stremio?.debrid !== undefined
      ? override.stremio.debrid
      : override?.debrid !== undefined
        ? override.debrid
        : stored.debrid ?? loadDebridConfig();
  const torrentMode =
    override?.stremio?.torrentMode !== undefined
      ? Boolean(override.stremio.torrentMode)
      : override?.torrentMode !== undefined
        ? Boolean(override.torrentMode)
        : Boolean(stored.torrentMode);
  return { addons, debrid, torrentMode };
}

export function updateStremioConfig(patch: Partial<StremioStorageState>): StremioStorageState {
  const prev = readStoredState();
  const next: StremioStorageState = {
    addons: patch.addons !== undefined
      ? patch.addons.map(sanitizeAddonConfig).filter((a): a is StremioAddonConfig => a !== null)
      : prev.addons,
    debrid: patch.debrid !== undefined ? patch.debrid : prev.debrid,
    torrentMode: patch.torrentMode !== undefined ? Boolean(patch.torrentMode) : prev.torrentMode,
  };
  writeStoredState(next);
  return next;
}

export function listStremioAddons(override?: Partial<Settings> & StremioSettingsOverride): StremioAddonConfig[] {
  return getStremioConfig(override).addons;
}

export function saveStremioAddons(addons: StremioAddonConfig[]): StremioAddonConfig[] {
  return updateStremioConfig({ addons }).addons;
}

export async function addStremioAddon(manifestUrl: string, signal?: AbortSignal): Promise<StremioAddonConfig> {
  const addon = await fetchStremioManifest(manifestUrl, signal);
  const existing = listStremioAddons();
  const idx = existing.findIndex((a) => a.manifestUrl === addon.manifestUrl || a.id === addon.id);
  const next = idx >= 0 ? existing.map((a, i) => (i === idx ? addon : a)) : [...existing, addon];
  saveStremioAddons(next);
  return addon;
}

export function removeStremioAddon(idOrUrl: string): StremioAddonConfig[] {
  const target = idOrUrl.trim();
  const next = listStremioAddons().filter((a) => a.id !== target && a.manifestUrl !== target && a.baseUrl !== target);
  return saveStremioAddons(next);
}

export function toggleStremioAddon(idOrUrl: string, enabled: boolean): StremioAddonConfig[] {
  const target = idOrUrl.trim();
  const next = listStremioAddons().map((a) =>
    a.id === target || a.manifestUrl === target || a.baseUrl === target ? { ...a, enabled } : a,
  );
  return saveStremioAddons(next);
}

/* ------------------------------------------------------------------ */
/* Addon Capability & ID Resolution                                   */
/* ------------------------------------------------------------------ */

function supportsAddonResource(
  addon: StremioAddonConfig,
  resourceName: string,
  stremioType: string,
  contentId: string,
): boolean {
  if (addon.enabled === false) return false;
  const resources = addon.resources;
  let resourceSpec: StremioResourceSpec | undefined;

  if (Array.isArray(resources) && resources.length > 0) {
    let matched = false;
    for (const r of resources) {
      if (typeof r === "string") {
        if (r === resourceName) {
          matched = true;
          break;
        }
      } else if (r && typeof r === "object" && r.name === resourceName) {
        matched = true;
        resourceSpec = r;
        break;
      }
    }
    if (!matched) return false;
  } else if (resourceName !== "stream") {
    return false;
  }

  const allowedTypes = resourceSpec?.types?.length ? resourceSpec.types : addon.types;
  if (Array.isArray(allowedTypes) && allowedTypes.length > 0 && !allowedTypes.includes(stremioType)) {
    return false;
  }

  const prefixes = resourceSpec?.idPrefixes?.length ? resourceSpec.idPrefixes : addon.idPrefixes;
  if (Array.isArray(prefixes) && prefixes.length > 0 && !prefixes.some((p) => contentId.startsWith(p))) {
    return false;
  }

  return true;
}

function normalizeImdbId(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^tt\d+$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^\d+$/.test(trimmed)) return `tt${trimmed}`;
  return null;
}

async function resolveImdbIdForRequest(req: PlaybackRequest, signal?: AbortSignal): Promise<string | null> {
  const detail = req.media as MediaDetail;
  const direct = normalizeImdbId(detail.imdbId);
  if (direct) return direct;

  if (req.media.key.startsWith("imdb:")) {
    const fromKey = normalizeImdbId(req.media.key.slice("imdb:".length));
    if (fromKey) return fromKey;
  }

  if (req.media.kind === "anime" || req.media.key.startsWith("anilist:")) {
    const syncAnime = resolveAnimeIdsSync(req);
    const fromSync = normalizeImdbId(syncAnime.imdbId);
    if (fromSync) return fromSync;
  }

  const resolved = await resolveMediaIds(req, signal);
  return normalizeImdbId(resolved.imdbId);
}

function buildStremioTarget(
  kind: "movie" | "tv" | "anime",
  imdbId: string,
  season?: number,
  episode?: number,
): { stremioType: "movie" | "series"; stremioId: string } {
  const isEpisodic = kind === "tv" || (kind === "anime" && (episode != null || season != null));
  if (!isEpisodic) {
    return { stremioType: "movie", stremioId: imdbId };
  }
  const s = season ?? 1;
  const e = episode ?? 1;
  return { stremioType: "series", stremioId: `${imdbId}:${s}:${e}` };
}

function pickTypeForAddon(addon: StremioAddonConfig, kind: "movie" | "tv" | "anime", defaultType: "movie" | "series"): string {
  if (kind === "anime" && defaultType === "series") {
    const streamRes = addon.resources?.find(
      (r): r is StremioResourceSpec => typeof r === "object" && r !== null && r.name === "stream",
    );
    const types = streamRes?.types?.length ? streamRes.types : addon.types;
    if (Array.isArray(types) && !types.includes("series") && types.includes("anime")) {
      return "anime";
    }
  }
  return defaultType;
}

/* ------------------------------------------------------------------ */
/* Stream Parsing Helpers                                             */
/* ------------------------------------------------------------------ */

function extractProxyHeaders(stream: StremioStreamObject): StreamHeaders {
  const raw = stream.behaviorHints?.proxyHeaders?.request;
  if (!raw || typeof raw !== "object") return {};

  let referer: string | undefined;
  let origin: string | undefined;
  let ua: string | undefined;

  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const lower = k.toLowerCase().trim();
    if (lower === "referer" || lower === "referrer") referer = v.trim();
    else if (lower === "origin") origin = v.trim();
    else if (lower === "user-agent" || lower === "ua") ua = v.trim();
  }

  if (!referer && !origin && !ua) return {};
  return normalizeHeaders({ referer, origin, ua }, referer ?? origin);
}

function hasAnyHeader(h: StreamHeaders): boolean {
  return Boolean(h.referer || h.origin || h.ua);
}

function inferStremioStreamKind(url: string, filename?: string, notWebReady?: boolean): StreamKind {
  const cleanUrl = url.split(/[?#]/)[0].toLowerCase();
  const cleanName = (filename ?? "").split(/[?#]/)[0].toLowerCase();
  if (cleanUrl.endsWith(".m3u8") || cleanName.endsWith(".m3u8") || /[?&](?:format|type)=m3u8\b/i.test(url)) {
    return "hls";
  }
  if (cleanUrl.endsWith(".mpd") || cleanName.endsWith(".mpd") || /[?&](?:format|type)=mpd\b/i.test(url)) {
    return "dash";
  }
  if (
    notWebReady ||
    /\.(?:mp4|mkv|webm|avi|mov|m4v|ts|m2ts)$/i.test(cleanUrl) ||
    /\.(?:mp4|mkv|webm|avi|mov|m4v|ts|m2ts)$/i.test(cleanName)
  ) {
    return "file";
  }
  return "file";
}

function parseStreamSubtitles(
  entries: StremioSubtitleEntry[] | undefined,
  headers: StreamHeaders,
): SubtitleTrack[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const seen = new Set<string>();
  const tracks: SubtitleTrack[] = [];
  const wrapWithProxy = hasAnyHeader(headers);

  for (const entry of entries) {
    if (!entry || !isValidHttpUrl(entry.url)) continue;
    const rawUrl = entry.url.trim();
    if (seen.has(rawUrl) || isThumbnailSubtitleUrl(rawUrl)) continue;
    seen.add(rawUrl);

    const hintLang = typeof entry.lang === "string" ? entry.lang.trim() : undefined;
    const meta = inferSubtitleMeta(rawUrl, hintLang);
    const normLang = normalizeSubLang(hintLang || meta.lang);
    const lang = normLang !== "und" ? normLang : meta.lang;

    tracks.push({
      lang,
      label: meta.label !== "Subtitles" ? meta.label : langLabel(lang),
      url: wrapWithProxy ? proxyUrl(rawUrl, headers) : rawUrl,
      ...(meta.format ? { format: meta.format } : {}),
      isDefault: meta.isDefault,
      isForced: meta.isForced,
      isHearingImpaired: meta.isHearingImpaired,
      source: "stream",
    });
  }

  return tracks.length ? tracks : undefined;
}

function extractTrackers(sources?: string[]): string[] {
  if (!Array.isArray(sources)) return [];
  const out: string[] = [];
  for (const s of sources) {
    if (typeof s !== "string") continue;
    const trimmed = s.trim();
    if (trimmed.startsWith("tracker:")) {
      const tr = trimmed.slice("tracker:".length).trim();
      if (tr) out.push(tr);
    } else if (/^(?:udp|https?|wss?):\/\//i.test(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

function formatStreamLabel(addonName: string, stream: StremioStreamObject, filename?: string, badge?: string): string {
  const parts: string[] = [addonName];
  const primary = [stream.name, stream.title, stream.description]
    .map((s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""))
    .find(Boolean);
  if (primary) {
    parts.push(primary.length > 90 ? `${primary.slice(0, 87)}...` : primary);
  } else if (filename) {
    parts.push(filename);
  }
  if (badge) parts.push(badge);
  return parts.join(" · ");
}

function inferStreamQuality(stream: StremioStreamObject, filename?: string): number | undefined {
  const hay = [stream.name, stream.title, stream.description, filename, stream.behaviorHints?.filename]
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .join(" ");
  return normalizeQuality(hay);
}

const DEBRID_BADGES: Record<DebridProvider, string> = {
  realdebrid: "RD",
  torbox: "TB",
  alldebrid: "AD",
};

interface PendingTorrentStream {
  addon: StremioAddonConfig;
  stream: StremioStreamObject;
  infoHash: string;
  magnetUri: string;
  trackers: string[];
  quality?: number;
  subtitles?: SubtitleTrack[];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */
/* Main Stremio Source Resolution                                     */
/* ------------------------------------------------------------------ */

async function queryAddonStreams(
  addon: StremioAddonConfig,
  kind: "movie" | "tv" | "anime",
  defaultType: "movie" | "series",
  stremioId: string,
  signal?: AbortSignal,
): Promise<{ addon: StremioAddonConfig; streams: StremioStreamObject[] }> {
  const addonType = pickTypeForAddon(addon, kind, defaultType);
  if (!supportsAddonResource(addon, "stream", addonType, stremioId)) {
    return { addon, streams: [] };
  }

  const encodedId = stremioId
    .split(":")
    .map((part) => encodeURIComponent(part))
    .join(":");
  const url = buildAddonEndpoint(addon.baseUrl, `/stream/${encodeURIComponent(addonType)}/${encodedId}.json`, addon.manifestUrl);
  const res = await fetchWithAbort(url, { Accept: "application/json" }, signal);
  if (res.status < 200 || res.status >= 300) return { addon, streams: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { addon, streams: [] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { streams?: unknown }).streams)) {
    return { addon, streams: [] };
  }
  const streams = (parsed as { streams: unknown[] }).streams.filter(
    (s): s is StremioStreamObject => Boolean(s && typeof s === "object"),
  );
  return { addon, streams };
}

/**
 * Query enabled Stremio addons in parallel for streams matching `req`, resolving direct HTTP(S)
 * URLs (with `proxyHeaders` -> `abxs:` proxy) and torrent `infoHash` streams (via Debrid or torrent mode).
 */
export async function resolveStremioStreams(
  req: PlaybackRequest,
  options?: StremioResolveOptions,
  signal?: AbortSignal,
): Promise<StremioStreamCandidate[]> {
  if (signal?.aborted) return [];

  const cfg = getStremioConfig(options?.settings);
  const addons = (options?.addons ?? cfg.addons).filter((a) => a.enabled !== false);
  if (!addons.length) return [];

  const debrid = options?.debrid !== undefined ? options.debrid : cfg.debrid;
  const torrentMode = options?.torrentMode !== undefined ? options.torrentMode : Boolean(cfg.torrentMode);

  let imdbId: string | null = null;
  try {
    imdbId = await resolveImdbIdForRequest(req, signal);
  } catch (err) {
    if (signal?.aborted || isAbortErr(err)) return [];
    return [];
  }
  if (!imdbId || signal?.aborted) return [];

  const { stremioType, stremioId } = buildStremioTarget(req.media.kind, imdbId, req.season, req.episode);

  const settled = await Promise.allSettled(
    addons.map((addon) => queryAddonStreams(addon, req.media.kind, stremioType, stremioId, signal)),
  );
  if (signal?.aborted) return [];

  const candidates: StremioStreamCandidate[] = [];
  const pendingTorrents: PendingTorrentStream[] = [];

  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    const { addon, streams } = outcome.value;

    for (const stream of streams) {
      const headers = extractProxyHeaders(stream);
      const hasHeaders = hasAnyHeader(headers);
      const notWebReady = Boolean(stream.behaviorHints?.notWebReady);
      const hintFilename = stream.behaviorHints?.filename;
      const subtitles = parseStreamSubtitles(stream.subtitles, headers);
      const quality = inferStreamQuality(stream, hintFilename);

      if (isValidHttpUrl(stream.url)) {
        const rawUrl = stream.url.trim();
        const kind = inferStremioStreamKind(rawUrl, hintFilename, notWebReady);
        candidates.push({
          providerId: "stremio",
          providerName: addon.name,
          addonId: addon.id,
          label: formatStreamLabel(addon.name, stream, hintFilename),
          url: hasHeaders ? proxyUrl(rawUrl, headers) : rawUrl,
          kind,
          via: "direct",
          ...(quality ? { quality } : {}),
          ...(hasHeaders ? { headers } : {}),
          ...(subtitles ? { subtitles } : {}),
          ...(notWebReady ? { notWebReady: true } : {}),
          ...(stream.behaviorHints?.videoSize ? { sizeBytes: stream.behaviorHints.videoSize } : {}),
        });
        continue;
      }

      if (typeof stream.infoHash === "string" && stream.infoHash.trim()) {
        const trackers = extractTrackers(stream.sources);
        const magnetInfo = toMagnetUri(stream.infoHash, trackers);
        if (!magnetInfo) continue;

        const magnetWithName =
          hintFilename && !magnetInfo.magnetUri.includes("&dn=")
            ? `${magnetInfo.magnetUri}&dn=${encodeURIComponent(hintFilename)}`
            : magnetInfo.magnetUri;

        pendingTorrents.push({
          addon,
          stream,
          infoHash: magnetInfo.infoHash,
          magnetUri: magnetWithName,
          trackers,
          quality,
          subtitles,
        });
      }
    }
  }

  if (!pendingTorrents.length || signal?.aborted) {
    return candidates;
  }

  const debridActive = Boolean(debrid && debrid.enabled !== false && debrid.apiKey.trim());
  const resolvedHashes = new Set<string>();

  if (debridActive && debrid) {
    const uniqueHashes = [...new Set(pendingTorrents.map((t) => t.infoHash))];
    try {
      const cacheMap = await checkDebridInstantCache(debrid.provider, debrid.apiKey, uniqueHashes, signal);
      if (signal?.aborted) return candidates;

      const cachedItems = pendingTorrents
        .filter((item) => cacheMap[item.infoHash]?.cached)
        .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))
        .slice(0, DEBRID_MAX_CANDIDATES);

      const resolved = await mapWithConcurrency(cachedItems, DEBRID_RESOLVE_CONCURRENCY, async (item) => {
        if (signal?.aborted) return null;
        try {
          const res = await resolveDebridStream(
            debrid.provider,
            debrid.apiKey,
            item.magnetUri,
            item.stream.fileIdx,
            signal,
          );
          return { item, res };
        } catch (err) {
          if (signal?.aborted || isAbortErr(err)) throw err;
          return null;
        }
      });

      if (signal?.aborted) return candidates;

      for (const entry of resolved) {
        if (!entry) continue;
        const { item, res } = entry;
        resolvedHashes.add(`${item.infoHash}:${item.stream.fileIdx ?? ""}`);
        const filename = res.filename ?? item.stream.behaviorHints?.filename;
        const quality = item.quality ?? normalizeQuality(filename);
        const kind = inferStremioStreamKind(res.url, filename, item.stream.behaviorHints?.notWebReady);

        candidates.push({
          providerId: "stremio",
          providerName: item.addon.name,
          addonId: item.addon.id,
          label: formatStreamLabel(item.addon.name, item.stream, filename, DEBRID_BADGES[debrid.provider]),
          url: res.url,
          kind,
          via: "direct",
          debridProvider: debrid.provider,
          infoHash: item.infoHash,
          ...(item.stream.fileIdx != null ? { fileIdx: item.stream.fileIdx } : {}),
          ...(quality ? { quality } : {}),
          ...(res.sizeBytes ?? item.stream.behaviorHints?.videoSize
            ? { sizeBytes: res.sizeBytes ?? item.stream.behaviorHints?.videoSize }
            : {}),
          ...(item.subtitles ? { subtitles: item.subtitles } : {}),
        });
      }
    } catch (err) {
      if (signal?.aborted || isAbortErr(err)) return candidates;
      // Non-fatal Debrid error (invalid key, rate limit, network): keep any direct HTTP streams and fall through to torrentMode if enabled.
    }
  }

  if (torrentMode) {
    for (const item of pendingTorrents) {
      const key = `${item.infoHash}:${item.stream.fileIdx ?? ""}`;
      if (resolvedHashes.has(key)) continue;
      const hintFilename = item.stream.behaviorHints?.filename;
      candidates.push({
        providerId: "stremio",
        providerName: item.addon.name,
        addonId: item.addon.id,
        label: formatStreamLabel(item.addon.name, item.stream, hintFilename, "Torrent"),
        url: item.magnetUri,
        magnet: item.magnetUri,
        infoHash: item.infoHash,
        ...(item.stream.fileIdx != null ? { fileIdx: item.stream.fileIdx } : {}),
        ...(item.trackers.length ? { trackers: item.trackers } : {}),
        kind: "file",
        notWebReady: true,
        ...(item.quality ? { quality: item.quality } : {}),
        ...(item.stream.behaviorHints?.videoSize ? { sizeBytes: item.stream.behaviorHints.videoSize } : {}),
        ...(item.subtitles ? { subtitles: item.subtitles } : {}),
      });
    }
  }

  return candidates;
}

export const stremioProvider: SourceProvider = {
  id: "stremio",
  name: "Stremio Addons",
  category: "external",
  priority: 22,
  timeoutMs: 14_000,
  isEnabled: (s) => {
    if (s.disabledSources?.includes("stremio")) return false;
    return listStremioAddons(s as Partial<Settings> & StremioSettingsOverride).some((a) => a.enabled !== false);
  },
  find: (req, s, signal) =>
    resolveStremioStreams(req, { settings: s as Partial<Settings> & StremioSettingsOverride }, signal),
};

/* ------------------------------------------------------------------ */
/* Stremio Subtitles (`/subtitles/{type}/{id}.json`)                  */
/* ------------------------------------------------------------------ */

async function queryAddonSubtitles(
  addon: StremioAddonConfig,
  kind: "movie" | "tv" | "anime",
  defaultType: "movie" | "series",
  stremioId: string,
  extraSegment: string,
  signal?: AbortSignal,
): Promise<StremioSubtitleResult[]> {
  const addonType = pickTypeForAddon(addon, kind, defaultType);
  if (!supportsAddonResource(addon, "subtitles", addonType, stremioId)) return [];

  const encodedId = stremioId
    .split(":")
    .map((part) => encodeURIComponent(part))
    .join(":");
  const path = `/subtitles/${encodeURIComponent(addonType)}/${encodedId}${extraSegment}.json`;
  const url = buildAddonEndpoint(addon.baseUrl, path, addon.manifestUrl);

  const res = await fetchWithAbort(url, { Accept: "application/json" }, signal);
  if (res.status < 200 || res.status >= 300) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { subtitles?: unknown }).subtitles)) {
    return [];
  }

  const list = (parsed as { subtitles: unknown[] }).subtitles;
  const results: StremioSubtitleResult[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (!isValidHttpUrl(rec.url)) continue;

    const rawUrl = rec.url.trim();
    if (seen.has(rawUrl) || isThumbnailSubtitleUrl(rawUrl)) continue;
    seen.add(rawUrl);

    const hintLang = typeof rec.lang === "string" ? rec.lang.trim() : undefined;
    const hintLabel =
      (typeof rec.SubFileName === "string" && rec.SubFileName.trim()) ||
      (typeof rec.subtitleFileName === "string" && rec.subtitleFileName.trim()) ||
      (typeof rec.release === "string" && rec.release.trim()) ||
      (typeof rec.title === "string" && rec.title.trim()) ||
      (typeof rec.name === "string" && rec.name.trim()) ||
      undefined;

    const meta = inferSubtitleMeta(rawUrl, hintLang, hintLabel);
    const normLang = normalizeSubLang(hintLang || meta.lang);
    const lang = normLang !== "und" ? normLang : meta.lang;
    const displayName = langLabel(lang);

    results.push({
      id: `stremio-${addon.id}-${typeof rec.id === "string" || typeof rec.id === "number" ? String(rec.id) : i}`,
      addonId: addon.id,
      addonName: addon.name,
      lang,
      langName: displayName,
      label: hintLabel || (meta.label !== "Subtitles" ? meta.label : displayName),
      url: rawUrl,
      ...(meta.format ? { format: meta.format } : {}),
      isDefault: meta.isDefault,
      isForced: meta.isForced,
      isHearingImpaired: meta.isHearingImpaired,
      source: "online",
    });
  }

  return results;
}

/**
 * Query enabled Stremio addons supporting the `subtitles` resource in parallel
 * via `/subtitles/{type}/{id}.json`.
 */
export async function fetchStremioSubtitles(
  addons: StremioAddonConfig[],
  query: StremioSubtitleQuery,
  signal?: AbortSignal,
): Promise<StremioSubtitleResult[]> {
  if (signal?.aborted) return [];
  const enabledAddons = addons.filter((a) => a.enabled !== false);
  if (!enabledAddons.length) return [];

  const imdbId = normalizeImdbId(query.imdbId);
  if (!imdbId && !query.videoHash) return [];

  const idForPath = imdbId ?? "tt0000000";
  const kind = query.kind ?? (query.episode != null || query.season != null ? "tv" : "movie");
  const { stremioType, stremioId } = buildStremioTarget(kind, idForPath, query.season, query.episode);

  const extraParts: string[] = [];
  if (query.videoHash) extraParts.push(`videoHash=${encodeURIComponent(query.videoHash)}`);
  if (query.videoSize != null && Number.isFinite(query.videoSize) && query.videoSize > 0) {
    extraParts.push(`videoSize=${Math.floor(query.videoSize)}`);
  }
  if (query.filename?.trim()) {
    extraParts.push(`filename=${encodeURIComponent(query.filename.trim())}`);
  }
  const extraSegment = extraParts.length ? `/${extraParts.join("&")}` : "";

  const settled = await Promise.allSettled(
    enabledAddons.map((addon) => queryAddonSubtitles(addon, kind, stremioType, stremioId, extraSegment, signal)),
  );
  if (signal?.aborted) return [];

  const seenUrls = new Set<string>();
  const out: StremioSubtitleResult[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const sub of outcome.value) {
      if (seenUrls.has(sub.url)) continue;
      seenUrls.add(sub.url);
      out.push(sub);
    }
  }
  return out;
}
