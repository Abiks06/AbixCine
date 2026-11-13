import { httpFetch, type FetchResult } from "../sources/native";

export type DebridProvider = "realdebrid" | "torbox" | "alldebrid";

export interface DebridConfig {
  provider: DebridProvider;
  apiKey: string;
  enabled?: boolean;
}

export type DebridErrorCode =
  | "INVALID_KEY"
  | "RATE_LIMIT"
  | "UNCACHED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "BAD_INPUT"
  | "NETWORK_ERROR";

export class DebridError extends Error {
  readonly code: DebridErrorCode;
  readonly provider: DebridProvider;
  readonly status?: number;

  constructor(code: DebridErrorCode, provider: DebridProvider, message: string, status?: number) {
    super(message);
    this.name = "DebridError";
    this.code = code;
    this.provider = provider;
    this.status = status;
  }
}

export interface DebridCachedFile {
  id?: number | string;
  filename: string;
  sizeBytes?: number;
}

export interface DebridCacheStatus {
  infoHash: string;
  cached: boolean;
  files?: DebridCachedFile[];
}

export interface ResolvedDebridStream {
  url: string;
  filename?: string;
  sizeBytes?: number;
}

const DEBRID_STORAGE_KEY = "abx.debrid.v1";
const REQUEST_TIMEOUT_MS = 12_000;
const RD_BASE = "https://api.real-debrid.com/rest/1.0";
const TB_BASE = "https://api.torbox.app/v1/api";
const AD_BASE = "https://api.alldebrid.com/v4";
const AD_AGENT = "AbixCine";

const VIDEO_EXT_RX = /\.(?:mkv|mp4|avi|mov|webm|m4v|ts|m2ts)$/i;
const SAMPLE_RX = /\bsample\b/i;

function makeAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function isAbortErr(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError(signal);
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchDebrid(
  provider: DebridProvider,
  url: string,
  headers?: Record<string, string>,
  init?: { method?: string; body?: string },
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<FetchResult> {
  throwIfAborted(signal);
  let call: Promise<FetchResult>;
  try {
    call = httpFetch(url, headers, init);
  } catch (err) {
    if (signal?.aborted || isAbortErr(err)) throw makeAbortError(signal);
    throw new DebridError("NETWORK_ERROR", provider, err instanceof Error ? err.message : "Request failed");
  }

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
      reject(new DebridError("TIMEOUT", provider, `${provider} request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    call.then(
      (res) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted) {
          reject(makeAbortError(signal));
        } else {
          resolve(res);
        }
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted || isAbortErr(err)) {
          reject(makeAbortError(signal));
          return;
        }
        if (err instanceof DebridError) {
          reject(err);
          return;
        }
        reject(new DebridError("NETWORK_ERROR", provider, err instanceof Error ? err.message : "Network error"));
      },
    );
  });
}

function parseJsonSafe<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function assertHttpStatus(provider: DebridProvider, res: FetchResult): void {
  if (res.status === 401 || res.status === 403) {
    throw new DebridError("INVALID_KEY", provider, `${provider} rejected API key (HTTP ${res.status})`, res.status);
  }
  if (res.status === 429) {
    throw new DebridError("RATE_LIMIT", provider, `${provider} rate limit exceeded (HTTP 429)`, 429);
  }
  if (res.status === 404) {
    throw new DebridError("NOT_FOUND", provider, `${provider} resource not found (HTTP 404)`, 404);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DebridError("HTTP_ERROR", provider, `${provider} returned HTTP ${res.status}`, res.status);
  }
}

async function requestJson<T>(
  provider: DebridProvider,
  url: string,
  headers?: Record<string, string>,
  init?: { method?: string; body?: string },
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchDebrid(provider, url, headers, init, signal);
  if (res.status < 200 || res.status >= 300) {
    const parsedErr = parseJsonSafe<{ error?: string | { message?: string; code?: string }; detail?: string }>(res.body);
    const detail =
      typeof parsedErr?.error === "string"
        ? parsedErr.error
        : parsedErr?.error?.message ?? parsedErr?.detail ?? "";
    if (res.status === 401 || res.status === 403) {
      throw new DebridError("INVALID_KEY", provider, detail || `${provider} rejected API key (HTTP ${res.status})`, res.status);
    }
    if (res.status === 429) {
      throw new DebridError("RATE_LIMIT", provider, detail || `${provider} rate limit exceeded (HTTP 429)`, 429);
    }
    assertHttpStatus(provider, res);
  }
  const parsed = parseJsonSafe<T>(res.body);
  if (parsed == null) {
    throw new DebridError("HTTP_ERROR", provider, `${provider} returned malformed JSON`, res.status);
  }
  return parsed;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32ToHex(b32: string): string | null {
  const clean = b32.trim().toUpperCase().replace(/=+$/, "");
  if (clean.length !== 32) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length !== 20) return null;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize a 40-char hex hash, 32-char base32 hash, or magnet URI into a lowercase 40-char hex infoHash. */
export function normalizeInfoHash(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^[A-Za-z2-7]{32}$/.test(trimmed)) return base32ToHex(trimmed);

  const match = trimmed.match(/urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})/i);
  if (!match) return null;
  const rawHash = match[1];
  return rawHash.length === 40 ? rawHash.toLowerCase() : base32ToHex(rawHash);
}

/** Build a magnet URI from a raw infoHash or preserve/normalize an existing magnet URI. */
export function toMagnetUri(magnetOrHash: string, trackers: string[] = []): { magnetUri: string; infoHash: string } | null {
  const trimmed = magnetOrHash.trim();
  const infoHash = normalizeInfoHash(trimmed);
  if (!infoHash) return null;

  if (/^magnet:\?/i.test(trimmed)) {
    if (!trackers.length) return { magnetUri: trimmed, infoHash };
    const extra = trackers
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `&tr=${encodeURIComponent(t)}`)
      .join("");
    return { magnetUri: `${trimmed}${extra}`, infoHash };
  }

  const trParams = trackers
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join("");
  return { magnetUri: `magnet:?xt=urn:btih:${infoHash}${trParams}`, infoHash };
}

interface SelectableFile {
  id?: number | string;
  filename: string;
  sizeBytes?: number;
  index: number;
}

function selectBestFile<T extends SelectableFile>(files: T[], fileIdx?: number): T | undefined {
  if (!files.length) return undefined;
  if (fileIdx != null && Number.isInteger(fileIdx) && fileIdx >= 0) {
    if (fileIdx < files.length) return files[fileIdx];
    const byId = files.find((f) => f.id === fileIdx || f.id === fileIdx + 1);
    if (byId) return byId;
  }

  const videos = files.filter((f) => VIDEO_EXT_RX.test(f.filename));
  const nonSampleVideos = videos.filter((f) => !SAMPLE_RX.test(f.filename));
  const pool = nonSampleVideos.length ? nonSampleVideos : videos.length ? videos : files;

  return pool.reduce((best, cur) => ((cur.sizeBytes ?? 0) > (best.sizeBytes ?? 0) ? cur : best), pool[0]);
}

function bearerHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey.trim()}`,
    ...extra,
  };
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function assertApiKey(provider: DebridProvider, apiKey: string): string {
  const key = apiKey.trim();
  if (!key) {
    throw new DebridError("INVALID_KEY", provider, `Missing ${provider} API key`);
  }
  return key;
}

/* ------------------------------------------------------------------ */
/* Real-Debrid                                                        */
/* ------------------------------------------------------------------ */

type RdInstantEntry = {
  rd?: Array<Record<string, { filename?: string; filesize?: number }>>;
};

async function rdCheckCache(
  apiKey: string,
  hashes: string[],
  signal?: AbortSignal,
): Promise<Record<string, DebridCacheStatus>> {
  const out: Record<string, DebridCacheStatus> = {};
  for (const h of hashes) out[h] = { infoHash: h, cached: false };

  const chunkSize = 40;
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const batch = hashes.slice(i, i + chunkSize);
    const data = await requestJson<Record<string, RdInstantEntry | unknown[]>>(
      "realdebrid",
      `${RD_BASE}/torrents/instantAvailability/${batch.join("/")}`,
      bearerHeaders(apiKey),
      undefined,
      signal,
    );
    for (const h of batch) {
      const entry = data[h];
      if (!entry || Array.isArray(entry) || !Array.isArray(entry.rd) || entry.rd.length === 0) continue;
      const firstVariant = entry.rd[0];
      const files: DebridCachedFile[] = firstVariant
        ? Object.entries(firstVariant).map(([id, f]) => ({
            id: Number(id) || id,
            filename: f.filename ?? `file-${id}`,
            sizeBytes: typeof f.filesize === "number" ? f.filesize : undefined,
          }))
        : [];
      out[h] = { infoHash: h, cached: true, ...(files.length ? { files } : {}) };
    }
  }
  return out;
}

interface RdTorrentInfo {
  id: string;
  status: string;
  files?: Array<{ id: number; path: string; bytes: number; selected: number }>;
  links?: string[];
}

async function rdResolveStream(
  apiKey: string,
  magnetUri: string,
  fileIdx?: number,
  signal?: AbortSignal,
): Promise<ResolvedDebridStream> {
  const added = await requestJson<{ id?: string }>(
    "realdebrid",
    `${RD_BASE}/torrents/addMagnet`,
    bearerHeaders(apiKey, { "Content-Type": "application/x-www-form-urlencoded" }),
    { method: "POST", body: formBody({ magnet: magnetUri }) },
    signal,
  );
  if (!added.id) {
    throw new DebridError("HTTP_ERROR", "realdebrid", "Real-Debrid did not return a torrent ID");
  }

  let info = await requestJson<RdTorrentInfo>(
    "realdebrid",
    `${RD_BASE}/torrents/info/${encodeURIComponent(added.id)}`,
    bearerHeaders(apiKey),
    undefined,
    signal,
  );

  let chosenFile: SelectableFile | undefined;
  if (info.status === "waiting_files_selection") {
    const files: SelectableFile[] = (info.files ?? []).map((f, index) => ({
      id: f.id,
      filename: f.path.replace(/^\/+/, ""),
      sizeBytes: f.bytes,
      index,
    }));
    chosenFile = selectBestFile(files, fileIdx);
    const selectParam = chosenFile?.id != null ? String(chosenFile.id) : "all";

    const selectRes = await fetchDebrid(
      "realdebrid",
      `${RD_BASE}/torrents/selectFiles/${encodeURIComponent(added.id)}`,
      bearerHeaders(apiKey, { "Content-Type": "application/x-www-form-urlencoded" }),
      { method: "POST", body: formBody({ files: selectParam }) },
      signal,
    );
    assertHttpStatus("realdebrid", selectRes);

    info = await requestJson<RdTorrentInfo>(
      "realdebrid",
      `${RD_BASE}/torrents/info/${encodeURIComponent(added.id)}`,
      bearerHeaders(apiKey),
      undefined,
      signal,
    );
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    if (info.status === "downloaded" && info.links?.length) break;
    if (["downloading", "magnet_error", "error", "virus", "dead"].includes(info.status)) {
      throw new DebridError("UNCACHED", "realdebrid", `Torrent is not cached on Real-Debrid (${info.status})`);
    }
    await sleepWithSignal(250, signal);
    info = await requestJson<RdTorrentInfo>(
      "realdebrid",
      `${RD_BASE}/torrents/info/${encodeURIComponent(added.id)}`,
      bearerHeaders(apiKey),
      undefined,
      signal,
    );
  }

  if (info.status !== "downloaded" || !info.links?.length) {
    throw new DebridError("UNCACHED", "realdebrid", `Torrent is not cached on Real-Debrid (${info.status})`);
  }

  let linkIndex = 0;
  if (chosenFile?.id != null && info.files?.length) {
    const selectedFiles = info.files.filter((f) => f.selected === 1);
    const pos = selectedFiles.findIndex((f) => f.id === chosenFile!.id);
    if (pos >= 0 && pos < info.links.length) linkIndex = pos;
  }

  const targetLink = info.links[linkIndex] ?? info.links[0];
  const unrestricted = await requestJson<{ download?: string; filename?: string; filesize?: number }>(
    "realdebrid",
    `${RD_BASE}/unrestrict/link`,
    bearerHeaders(apiKey, { "Content-Type": "application/x-www-form-urlencoded" }),
    { method: "POST", body: formBody({ link: targetLink }) },
    signal,
  );
  if (!unrestricted.download) {
    throw new DebridError("HTTP_ERROR", "realdebrid", "Real-Debrid unrestrict returned no download URL");
  }

  return {
    url: unrestricted.download,
    filename: unrestricted.filename ?? chosenFile?.filename,
    sizeBytes: unrestricted.filesize ?? chosenFile?.sizeBytes,
  };
}

/* ------------------------------------------------------------------ */
/* TorBox                                                             */
/* ------------------------------------------------------------------ */

interface TorBoxEnvelope<T> {
  success?: boolean;
  error?: string | null;
  detail?: string;
  data?: T;
}

interface TorBoxCachedItem {
  hash?: string;
  name?: string;
  size?: number;
  files?: Array<{ id?: number; name?: string; short_name?: string; size?: number }>;
}

function assertTorBoxOk<T>(res: TorBoxEnvelope<T>): T | undefined {
  if (res.success === false) {
    const errCode = (res.error ?? "").toUpperCase();
    const msg = res.detail || res.error || "TorBox request failed";
    if (/AUTH|TOKEN|API_KEY|UNAUTHORIZED/.test(errCode)) {
      throw new DebridError("INVALID_KEY", "torbox", msg, 401);
    }
    if (/RATE_LIMIT|TOO_MANY/.test(errCode)) {
      throw new DebridError("RATE_LIMIT", "torbox", msg, 429);
    }
    throw new DebridError("HTTP_ERROR", "torbox", msg);
  }
  return res.data;
}

async function tbCheckCache(
  apiKey: string,
  hashes: string[],
  signal?: AbortSignal,
): Promise<Record<string, DebridCacheStatus>> {
  const out: Record<string, DebridCacheStatus> = {};
  for (const h of hashes) out[h] = { infoHash: h, cached: false };

  const chunkSize = 50;
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const batch = hashes.slice(i, i + chunkSize);
    const url = `${TB_BASE}/torrents/checkcached?hash=${encodeURIComponent(batch.join(","))}&format=list&list_files=true`;
    const env = await requestJson<TorBoxEnvelope<TorBoxCachedItem[] | Record<string, TorBoxCachedItem>>>(
      "torbox",
      url,
      bearerHeaders(apiKey),
      undefined,
      signal,
    );
    const data = assertTorBoxOk(env);
    if (!data) continue;

    if (Array.isArray(data)) {
      for (const item of data) {
        const h = item.hash?.toLowerCase();
        if (!h || !(h in out)) continue;
        const files: DebridCachedFile[] = (item.files ?? []).map((f, idx) => ({
          id: f.id ?? idx,
          filename: f.short_name || f.name || `file-${idx}`,
          sizeBytes: typeof f.size === "number" ? f.size : undefined,
        }));
        out[h] = { infoHash: h, cached: true, ...(files.length ? { files } : {}) };
      }
    } else if (typeof data === "object") {
      for (const [key, item] of Object.entries(data)) {
        const h = (item?.hash ?? key).toLowerCase();
        if (!h || !(h in out) || !item) continue;
        const files: DebridCachedFile[] = (item.files ?? []).map((f, idx) => ({
          id: f.id ?? idx,
          filename: f.short_name || f.name || `file-${idx}`,
          sizeBytes: typeof f.size === "number" ? f.size : undefined,
        }));
        out[h] = { infoHash: h, cached: true, ...(files.length ? { files } : {}) };
      }
    }
  }
  return out;
}

interface TorBoxTorrentItem {
  id: number;
  hash?: string;
  cached?: boolean;
  download_present?: boolean;
  download_finished?: boolean;
  files?: Array<{ id: number; name?: string; short_name?: string; size?: number }>;
}

async function tbResolveStream(
  apiKey: string,
  magnetUri: string,
  fileIdx?: number,
  signal?: AbortSignal,
): Promise<ResolvedDebridStream> {
  const createdEnv = await requestJson<TorBoxEnvelope<{ torrent_id?: number; id?: number }>>(
    "torbox",
    `${TB_BASE}/torrents/createtorrent`,
    bearerHeaders(apiKey, { "Content-Type": "application/x-www-form-urlencoded" }),
    { method: "POST", body: formBody({ magnet: magnetUri, allow_zip: "false" }) },
    signal,
  );
  const created = assertTorBoxOk(createdEnv);
  const torrentId = created?.torrent_id ?? created?.id;
  if (torrentId == null) {
    throw new DebridError("HTTP_ERROR", "torbox", "TorBox did not return a torrent ID");
  }

  const listEnv = await requestJson<TorBoxEnvelope<TorBoxTorrentItem | TorBoxTorrentItem[]>>(
    "torbox",
    `${TB_BASE}/torrents/mylist?id=${encodeURIComponent(String(torrentId))}&bypass_cache=true`,
    bearerHeaders(apiKey),
    undefined,
    signal,
  );
  const listData = assertTorBoxOk(listEnv);
  const torrent = Array.isArray(listData)
    ? listData.find((t) => t.id === torrentId) ?? listData[0]
    : listData;

  if (!torrent || (!torrent.download_present && !torrent.cached && !torrent.download_finished)) {
    throw new DebridError("UNCACHED", "torbox", "Torrent is not cached on TorBox");
  }

  const files: SelectableFile[] = (torrent.files ?? []).map((f, index) => ({
    id: f.id,
    filename: f.short_name || f.name || `file-${index}`,
    sizeBytes: f.size,
    index,
  }));
  const chosen = selectBestFile(files, fileIdx);
  if (!chosen || chosen.id == null) {
    throw new DebridError("UNCACHED", "torbox", "TorBox torrent contains no selectable files");
  }

  const dlEnv = await requestJson<TorBoxEnvelope<string>>(
    "torbox",
    `${TB_BASE}/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${encodeURIComponent(String(torrentId))}&file_id=${encodeURIComponent(String(chosen.id))}`,
    bearerHeaders(apiKey),
    undefined,
    signal,
  );
  const dlUrl = assertTorBoxOk(dlEnv);
  if (typeof dlUrl !== "string" || !dlUrl) {
    throw new DebridError("HTTP_ERROR", "torbox", "TorBox did not return a download URL");
  }

  return {
    url: dlUrl,
    filename: chosen.filename,
    sizeBytes: chosen.sizeBytes,
  };
}

/* ------------------------------------------------------------------ */
/* AllDebrid                                                          */
/* ------------------------------------------------------------------ */

interface AllDebridEnvelope<T> {
  status?: string;
  error?: { code?: string; message?: string };
  data?: T;
}

function assertAllDebridOk<T>(env: AllDebridEnvelope<T>): T {
  if (env.status === "error" || env.error) {
    const code = (env.error?.code ?? "").toUpperCase();
    const msg = env.error?.message || code || "AllDebrid request failed";
    if (code.startsWith("AUTH_") || /APIKEY|TOKEN/.test(code)) {
      throw new DebridError("INVALID_KEY", "alldebrid", msg, 401);
    }
    if (/RATE_LIMIT|TOO_MANY/.test(code)) {
      throw new DebridError("RATE_LIMIT", "alldebrid", msg, 429);
    }
    if (/MAGNET_INVALID|NOT_FOUND/.test(code)) {
      throw new DebridError("BAD_INPUT", "alldebrid", msg);
    }
    throw new DebridError("HTTP_ERROR", "alldebrid", msg);
  }
  if (env.data == null) {
    throw new DebridError("HTTP_ERROR", "alldebrid", "AllDebrid returned empty data");
  }
  return env.data;
}

async function adCheckCache(
  apiKey: string,
  hashes: string[],
  signal?: AbortSignal,
): Promise<Record<string, DebridCacheStatus>> {
  const out: Record<string, DebridCacheStatus> = {};
  for (const h of hashes) out[h] = { infoHash: h, cached: false };

  const chunkSize = 40;
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const batch = hashes.slice(i, i + chunkSize);
    const body = batch.map((h) => `magnets[]=${encodeURIComponent(h)}`).join("&");
    const env = await requestJson<
      AllDebridEnvelope<{
        magnets?: Array<{
          magnet?: string;
          hash?: string;
          instant?: boolean;
          files?: Array<{ n?: string; s?: number }>;
        }>;
      }>
    >(
      "alldebrid",
      `${AD_BASE}/magnet/instant?agent=${encodeURIComponent(AD_AGENT)}`,
      bearerHeaders(apiKey, { "Content-Type": "application/x-www-form-urlencoded" }),
      { method: "POST", body },
      signal,
    );
    const data = assertAllDebridOk(env);
    for (const item of data.magnets ?? []) {
      const h = (item.hash ?? normalizeInfoHash(item.magnet ?? "") ?? "").toLowerCase();
      if (!h || !(h in out)) continue;
      const files: DebridCachedFile[] = (item.files ?? []).map((f, idx) => ({
        id: idx,
        filename: f.n ?? `file-${idx}`,
        sizeBytes: typeof f.s === "number" ? f.s : undefined,
      }));
      out[h] = {
        infoHash: h,
        cached: Boolean(item.instant),
        ...(files.length ? { files } : {}),
      };
    }
  }
  return out;
}

interface AllDebridLinkEntry {
  link?: string;
  filename?: string;
  size?: number;
}

interface AllDebridStatusMagnet {
  id?: number;
  statusCode?: number;
  status?: string;
  links?: AllDebridLinkEntry[];
}

async function adResolveStream(
  apiKey: string,
  magnetUri: string,
  fileIdx?: number,
  signal?: AbortSignal,
): Promise<ResolvedDebridStream> {
  const uploadEnv = await requestJson<
    AllDebridEnvelope<{
      magnets?: Array<{ id?: number; ready?: boolean; error?: { code?: string; message?: string } }>;
    }>
  >(
    "alldebrid",
    `${AD_BASE}/magnet/upload?agent=${encodeURIComponent(AD_AGENT)}`,
    bearerHeaders(apiKey, { "Content-Type": "application/x-www-form-urlencoded" }),
    { method: "POST", body: `magnets[]=${encodeURIComponent(magnetUri)}` },
    signal,
  );
  const uploadData = assertAllDebridOk(uploadEnv);
  const uploaded = uploadData.magnets?.[0];
  if (uploaded?.error) {
    const code = (uploaded.error.code ?? "").toUpperCase();
    const msg = uploaded.error.message || "AllDebrid upload failed";
    if (code.startsWith("AUTH_")) throw new DebridError("INVALID_KEY", "alldebrid", msg, 401);
    throw new DebridError("UNCACHED", "alldebrid", msg);
  }
  if (uploaded?.id == null) {
    throw new DebridError("HTTP_ERROR", "alldebrid", "AllDebrid did not return a magnet ID");
  }
  if (uploaded.ready === false) {
    throw new DebridError("UNCACHED", "alldebrid", "Torrent is not cached on AllDebrid");
  }

  const statusEnv = await requestJson<
    AllDebridEnvelope<{ magnets?: AllDebridStatusMagnet | AllDebridStatusMagnet[] }>
  >(
    "alldebrid",
    `${AD_BASE}/magnet/status?agent=${encodeURIComponent(AD_AGENT)}&id=${encodeURIComponent(String(uploaded.id))}`,
    bearerHeaders(apiKey),
    undefined,
    signal,
  );
  const statusData = assertAllDebridOk(statusEnv);
  const magnet = Array.isArray(statusData.magnets) ? statusData.magnets[0] : statusData.magnets;
  const rawLinks = (magnet?.links ?? []).filter((l): l is AllDebridLinkEntry & { link: string } => Boolean(l?.link));

  if ((magnet?.statusCode != null && magnet.statusCode !== 4) || !rawLinks.length) {
    throw new DebridError("UNCACHED", "alldebrid", `Torrent is not cached on AllDebrid (${magnet?.status ?? "not ready"})`);
  }

  const selectable: SelectableFile[] = rawLinks.map((l, index) => ({
    id: index,
    filename: l.filename ?? `file-${index}`,
    sizeBytes: l.size,
    index,
  }));
  const chosen = selectBestFile(selectable, fileIdx);
  const targetLink = chosen ? rawLinks[chosen.index].link : rawLinks[0].link;

  const unlockEnv = await requestJson<
    AllDebridEnvelope<{ link?: string; filename?: string; filesize?: number }>
  >(
    "alldebrid",
    `${AD_BASE}/link/unlock?agent=${encodeURIComponent(AD_AGENT)}&link=${encodeURIComponent(targetLink)}`,
    bearerHeaders(apiKey),
    undefined,
    signal,
  );
  const unlocked = assertAllDebridOk(unlockEnv);
  if (!unlocked.link) {
    throw new DebridError("HTTP_ERROR", "alldebrid", "AllDebrid link unlock returned no URL");
  }

  return {
    url: unlocked.link,
    filename: unlocked.filename ?? chosen?.filename,
    sizeBytes: unlocked.filesize ?? chosen?.sizeBytes,
  };
}

/* ------------------------------------------------------------------ */
/* Public API & Config Storage                                        */
/* ------------------------------------------------------------------ */

/**
 * Check whether one or more torrent infoHashes are instantly cached on the given Debrid provider.
 * Returns a map keyed by lowercase 40-char hex infoHash.
 */
export async function checkDebridInstantCache(
  provider: DebridProvider,
  apiKey: string,
  infoHashes: string[],
  signal?: AbortSignal,
): Promise<Record<string, DebridCacheStatus>> {
  throwIfAborted(signal);
  const key = assertApiKey(provider, apiKey);
  const normalized = [...new Set(infoHashes.map(normalizeInfoHash).filter((h): h is string => h !== null))];
  if (!normalized.length) return {};

  switch (provider) {
    case "realdebrid":
      return rdCheckCache(key, normalized, signal);
    case "torbox":
      return tbCheckCache(key, normalized, signal);
    case "alldebrid":
      return adCheckCache(key, normalized, signal);
  }
}

/**
 * Resolve a magnet URI or infoHash (with optional 0-based `fileIdx`) to a direct playable HTTP(S) URL
 * via the configured Debrid provider. Throws `DebridError` on invalid key, rate limit, uncached torrent, or timeout.
 */
export async function resolveDebridStream(
  provider: DebridProvider,
  apiKey: string,
  magnetOrHash: string,
  fileIdx?: number,
  signal?: AbortSignal,
): Promise<ResolvedDebridStream> {
  throwIfAborted(signal);
  const key = assertApiKey(provider, apiKey);
  const parsed = toMagnetUri(magnetOrHash);
  if (!parsed) {
    throw new DebridError("BAD_INPUT", provider, "Invalid magnet URI or torrent infoHash");
  }

  switch (provider) {
    case "realdebrid":
      return rdResolveStream(key, parsed.magnetUri, fileIdx, signal);
    case "torbox":
      return tbResolveStream(key, parsed.magnetUri, fileIdx, signal);
    case "alldebrid":
      return adResolveStream(key, parsed.magnetUri, fileIdx, signal);
  }
}

export function loadDebridConfig(): DebridConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(DEBRID_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DebridConfig>;
    if (
      (parsed.provider === "realdebrid" || parsed.provider === "torbox" || parsed.provider === "alldebrid") &&
      typeof parsed.apiKey === "string"
    ) {
      return {
        provider: parsed.provider,
        apiKey: parsed.apiKey.trim(),
        enabled: parsed.enabled !== false,
      };
    }
  } catch {
    /* ignore storage errors */
  }
  return null;
}

export function saveDebridConfig(config: DebridConfig | null): void {
  try {
    if (!config) {
      globalThis.localStorage?.removeItem(DEBRID_STORAGE_KEY);
      return;
    }
    globalThis.localStorage?.setItem(
      DEBRID_STORAGE_KEY,
      JSON.stringify({
        provider: config.provider,
        apiKey: config.apiKey.trim(),
        enabled: config.enabled !== false,
      }),
    );
  } catch {
    /* ignore storage errors */
  }
}
