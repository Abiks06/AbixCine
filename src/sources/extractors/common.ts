import { hasTmdb, tmdbDetail } from "../../lib/tmdb";
import { langBase } from "../../lib/subtitles";
import type { Settings } from "../../lib/settings";
import { isFilm, type MediaDetail, type PlaybackRequest } from "../../lib/types";
import { resolveTmdbId } from "../embeds";
import { DEFAULT_UA, httpFetch, httpFetchBytes, native, normalizeHeaders, proxyUrl, type FetchResult, type StreamHeaders } from "../native";
import { inferSubtitleMeta, isThumbnailSubtitleUrl, type StreamKind, type SubtitleTrack } from "../types";

/** The strict "is this catalog entry the title being played?" matcher every title search uses. */
export {
  assessTitleMatch,
  matchTargetFor,
  normalizeMatchTitle,
  parseYear,
  pickTitleMatch,
  splitSeasonSuffix,
  type MatchCandidate,
  type MatchTarget,
  type TitleMatch,
} from "../titleMatch";

export const DEFAULT_TIMEOUT_MS = 10_000;

export const ASIAN_DRAMA_LANGS = new Set(["ko", "zh", "cn", "ja", "th", "tw", "tl", "id", "vi"]);

export interface RawSubtitleInput {
  url?: string;
  lang?: string;
  label?: string;
  kind?: string;
  isDefault?: boolean;
  isForced?: boolean;
}

export interface ResolvedMediaIds {
  tmdbId: string | null;
  imdbId: string | null;
  title: string;
  originalTitle?: string;
  year?: number;
  releaseDate: string;
}

export function isDirectExtractorEnabled(id: string, s: Settings, aliases: string[] = []): boolean {
  if (!native) return false;
  const disabled = s.disabledSources ?? [];
  if (disabled.includes(id)) return false;
  for (const alias of aliases) {
    if (disabled.includes(alias)) return false;
  }
  return true;
}

export function isAnimeRequest(req: PlaybackRequest): boolean {
  return req.media.kind === "anime" || req.media.key.startsWith("anilist:");
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /aborted/i.test(err.message))
  );
}

/**
 * Execute `httpFetch` with strict `AbortSignal` propagation and timeout cleanup.
 * Rejects immediately with AbortError if `signal` is already aborted or aborts mid-flight.
 */
export async function fetchWithAbort(
  url: string,
  headers?: Record<string, string>,
  init?: { method?: string; body?: string },
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  if (signal?.aborted) throw abortError(signal);

  const call = httpFetch(url, headers, init);
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
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    call.then(
      (res) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted) reject(abortError(signal));
        else resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.aborted ? abortError(signal) : err);
      },
    );
  });
}

export async function fetchJsonWithAbort<T = unknown>(
  url: string,
  headers?: Record<string, string>,
  init?: { method?: string; body?: string },
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number; url: string; data: T | null }> {
  const res = await fetchWithAbort(url, headers, init, signal, timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    return { status: res.status, url: res.url, data: null };
  }
  try {
    return { status: res.status, url: res.url, data: JSON.parse(res.body) as T };
  } catch {
    return { status: res.status, url: res.url, data: null };
  }
}

/**
 * `httpFetchBytes` with a timeout and abort propagation, for binary request/response protocols.
 * Rejects with AbortError on abort and with a timeout error after `timeoutMs`.
 */
export async function fetchBytesWithAbort(
  url: string,
  headers: Record<string, string> | undefined,
  init: { method?: string; bodyBytes?: Uint8Array } | undefined,
  signal: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number; url: string; bytes: Uint8Array }> {
  if (signal.aborted) throw abortError(signal);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
  }, timeoutMs);
  try {
    const res = await httpFetchBytes(url, headers, { signal: ctl.signal, ...init });
    return { status: res.status, url: res.url, bytes: new Uint8Array(res.bytes) };
  } catch (err) {
    if (signal.aborted) throw abortError(signal);
    if (timedOut) throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Random lowercase hex string of `byteLength` bytes. */
export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** True when the request targets a film (including anime movies via `format` or `isAnimeMovie`). */
export function isMovieRequest(req: PlaybackRequest): boolean {
  return (
    isFilm(req.media)
    || Boolean((req as { isAnimeMovie?: boolean }).isAnimeMovie)
    || Boolean((req.media as { isAnimeMovie?: boolean }).isAnimeMovie)
  );
}

/**
 * Resolve TMDB ID, IMDb ID, title, year, and release date for a playback request
 * without triggering unnecessary network requests when the caller already supplied them.
 */
export async function resolveMediaIds(req: PlaybackRequest, signal?: AbortSignal): Promise<ResolvedMediaIds> {
  const detail = req.media as MediaDetail;
  let tmdbId = await resolveTmdbId(req, signal);
  let imdbId = detail.imdbId?.trim() || null;
  let title = detail.title || detail.originalTitle || "";
  let originalTitle = detail.originalTitle;
  let year = detail.year;
  let releaseDate = detail.releaseDate?.slice(0, 10) || "";

  if (!signal?.aborted && (!imdbId || !releaseDate) && tmdbId && hasTmdb()) {
    const kind = isMovieRequest(req) ? "movie" : "tv";
    try {
      const fetched = await tmdbDetail(`tmdb:${kind}:${tmdbId}`);
      if (!signal?.aborted) {
        imdbId = imdbId || fetched.imdbId || null;
        title = title || fetched.title;
        originalTitle = originalTitle || fetched.originalTitle;
        year = year ?? fetched.year;
        releaseDate = releaseDate || fetched.releaseDate?.slice(0, 10) || "";
      }
    } catch {
      /* ignore optional TMDB enrichment failure */
    }
  }

  if (!releaseDate && year) releaseDate = `${year}-01-01`;
  return { tmdbId, imdbId, title, originalTitle, year, releaseDate };
}

export function inferStreamKind(url: string, hint?: string): StreamKind {
  const h = (hint ?? "").toLowerCase();
  if (h === "hls" || h === "m3u8") return "hls";
  if (h === "dash" || h === "mpd") return "dash";
  if (h === "mp4" || h === "file" || h === "mkv") return "file";
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".mpd")) return "dash";
  if (clean.endsWith(".mp4") || clean.endsWith(".mkv") || clean.endsWith(".webm")) return "file";
  return "hls";
}

export function normalizeQuality(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw === 0) return 240;
    if (raw === 1) return 480;
    if (raw === 2) return 720;
    if (raw === 3) return 1080;
    if (raw === 4) return 2160;
    return raw >= 144 && raw <= 4320 ? Math.round(raw) : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (!s || s === "auto" || s === "unknown") return undefined;
  if (/\b(?:4k|2160p?|uhd)\b/.test(s)) return 2160;
  const m = s.match(/\b(2160|1440|1080|720|540|480|360|240)p?\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Convert provider-supplied subtitle objects into AbixCine `SubtitleTrack[]`,
 * filtering thumbnails/sprites, deduplicating URLs, and wrapping via `proxyUrl`.
 */
export function buildSubtitleTracks(
  rawTracks: RawSubtitleInput[] | undefined,
  headers: StreamHeaders,
  fallbackPageUrl?: string,
): SubtitleTrack[] {
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) return [];
  const seen = new Set<string>();
  const out: SubtitleTrack[] = [];

  for (const t of rawTracks) {
    let rawUrl = t?.url?.trim();
    if (!rawUrl) continue;
    if (!/^https?:\/\//i.test(rawUrl)) {
      if (rawUrl.startsWith("//")) rawUrl = `https:${rawUrl}`;
      else if (fallbackPageUrl && /^https?:\/\//i.test(fallbackPageUrl)) {
        try {
          rawUrl = new URL(rawUrl, fallbackPageUrl).toString();
        } catch {
          continue;
        }
      } else {
        continue;
      }
    }
    if (seen.has(rawUrl) || isThumbnailSubtitleUrl(rawUrl, t.kind)) continue;
    seen.add(rawUrl);

    const cleanLabel = String(t.label ?? "").replace(/\s*\(-.*\)$/, "").trim();
    const meta = inferSubtitleMeta(rawUrl, t.lang, cleanLabel || undefined);
    const resolvedLang = meta.lang !== "und" ? meta.lang : t.lang ? langBase(t.lang) : "und";
    const label =
      cleanLabel && !/^(?:track\s*\d+|subtitles?|captions?|und|unknown)$/i.test(cleanLabel)
        ? cleanLabel
        : meta.label;

    out.push({
      lang: resolvedLang,
      label,
      url: proxyUrl(rawUrl, headers, fallbackPageUrl),
      ...(meta.format ? { format: meta.format } : {}),
      isDefault: Boolean(t.isDefault || meta.isDefault),
      isForced: Boolean(t.isForced || meta.isForced),
      isHearingImpaired: meta.isHearingImpaired,
      source: "stream",
    });
  }

  return out;
}

export function buildStreamHeaders(referer: string, origin?: string, ua = DEFAULT_UA): StreamHeaders {
  return normalizeHeaders({ referer, origin: origin ?? new URL(referer).origin, ua }, referer);
}

export const NON_BROWSER_STREAM_UA = "Lavf/60.3.100";

export function isNoRefererMediaHost(streamUrl: string): boolean {
  try {
    const host = new URL(streamUrl).hostname.toLowerCase();
    return host === "hakunaymatata.com" || host.endsWith(".hakunaymatata.com");
  } catch {
    return false;
  }
}

export function resolveExtractorStreamHeaders(
  streamUrl: string,
  defaultReferer: string,
  defaultOrigin?: string,
  explicitHeaders?: Record<string, string | undefined>,
): { headers: StreamHeaders; fallbackReferer?: string } {
  if (isNoRefererMediaHost(streamUrl)) {
    return { headers: { ua: NON_BROWSER_STREAM_UA } };
  }
  if (explicitHeaders) {
    const referer = explicitHeaders.Referer ?? explicitHeaders.referer ?? defaultReferer;
    const origin = explicitHeaders.Origin ?? explicitHeaders.origin ?? defaultOrigin;
    const ua = explicitHeaders["User-Agent"] ?? explicitHeaders.ua ?? DEFAULT_UA;
    const picked = normalizeHeaders({ referer, origin, ua }, referer);
    return { headers: picked, fallbackReferer: picked.referer ?? defaultReferer };
  }
  return {
    headers: buildStreamHeaders(defaultReferer, defaultOrigin),
    fallbackReferer: defaultReferer,
  };
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Single-pass HTML entity decoder so sequences like `&amp;quot;` are never double-decoded. */
export function decodeHtmlEntities(s: string): string {
  return (s || "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(?:x([0-9a-f]+)|(\d+));/gi, (m, named: string | undefined, hex: string | undefined, dec: string | undefined) => {
      if (named) return HTML_ENTITIES[named.toLowerCase()] ?? m;
      const code = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .trim();
}

/**
 * Unescape a JS single-quoted string literal so it remains valid JSON for `JSON.parse`:
 * decodes `\\`, `\'`, `\/`, and non-control `\uXXXX`/`\xXX` while keeping JSON string escapes
 * (`\"`, `\n`, `\r`, `\t`, `\b`, `\f`) intact.
 */
export function unescapeJsString(escaped: string): string {
  return escaped.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
    if (esc.startsWith("u") && esc.length === 5) {
      const code = parseInt(esc.slice(1), 16);
      return code >= 0x20 ? String.fromCharCode(code) : `\\${esc}`;
    }
    if (esc.startsWith("x") && esc.length === 3) {
      const code = parseInt(esc.slice(1), 16);
      if (code >= 0x20 && code !== 0x22 && code !== 0x5c) return String.fromCharCode(code);
      if (code === 0x22) return '"';
      if (code === 0x5c) return "\\";
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    if (esc === "n" || esc === "r" || esc === "t" || esc === "b" || esc === "f" || esc === '"') {
      return `\\${esc}`;
    }
    if (esc === "'" || esc === "/" || esc === "\\") return esc;
    return esc;
  });
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const na = norm(a);
  const nb = norm(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(na, nb) / maxLen;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + "=".repeat(4 - pad);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function sha512Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-512", toExactArrayBuffer(data));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function aes256GcmDecrypt(
  keyBytes: Uint8Array,
  ivBytes: Uint8Array,
  ciphertextWithTag: Uint8Array,
): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      toExactArrayBuffer(keyBytes),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toExactArrayBuffer(ivBytes), tagLength: 128 },
      key,
      toExactArrayBuffer(ciphertextWithTag),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function aesCbcDecrypt(
  keyBytes: Uint8Array,
  ivBytes: Uint8Array,
  ciphertext: Uint8Array,
): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      toExactArrayBuffer(keyBytes),
      { name: "AES-CBC" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: toExactArrayBuffer(ivBytes) },
      key,
      toExactArrayBuffer(ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export const aes256CbcDecrypt = aesCbcDecrypt;

/* ------------------------------------------------------------------ */
/* Pure TypeScript XSalsa20-Poly1305 (NaCl SecretBox)                  */
/* ------------------------------------------------------------------ */

function rotl32(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function writeU32LE(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
  out[off + 2] = (v >>> 16) & 0xff;
  out[off + 3] = (v >>> 24) & 0xff;
}

function salsa20Core(state: Uint32Array, addInput: boolean): Uint32Array {
  const x = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    // Column rounds
    x[4] ^= rotl32((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotl32((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl32((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotl32((x[12] + x[8]) >>> 0, 18);

    x[9] ^= rotl32((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotl32((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl32((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotl32((x[1] + x[13]) >>> 0, 18);

    x[14] ^= rotl32((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotl32((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl32((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotl32((x[6] + x[2]) >>> 0, 18);

    x[3] ^= rotl32((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotl32((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl32((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotl32((x[11] + x[7]) >>> 0, 18);

    // Row rounds
    x[1] ^= rotl32((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotl32((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl32((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotl32((x[3] + x[2]) >>> 0, 18);

    x[6] ^= rotl32((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotl32((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl32((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotl32((x[4] + x[7]) >>> 0, 18);

    x[11] ^= rotl32((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotl32((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl32((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotl32((x[9] + x[8]) >>> 0, 18);

    x[12] ^= rotl32((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotl32((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl32((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotl32((x[14] + x[13]) >>> 0, 18);
  }
  if (addInput) {
    for (let i = 0; i < 16; i++) x[i] = (x[i] + state[i]) >>> 0;
  }
  return x;
}

const SALSA_SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;

function hsalsa20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const st = new Uint32Array(16);
  st[0] = SALSA_SIGMA[0];
  st[1] = readU32LE(key, 0);
  st[2] = readU32LE(key, 4);
  st[3] = readU32LE(key, 8);
  st[4] = readU32LE(key, 12);
  st[5] = SALSA_SIGMA[1];
  st[6] = readU32LE(nonce16, 0);
  st[7] = readU32LE(nonce16, 4);
  st[8] = readU32LE(nonce16, 8);
  st[9] = readU32LE(nonce16, 12);
  st[10] = SALSA_SIGMA[2];
  st[11] = readU32LE(key, 16);
  st[12] = readU32LE(key, 20);
  st[13] = readU32LE(key, 24);
  st[14] = readU32LE(key, 28);
  st[15] = SALSA_SIGMA[3];

  const x = salsa20Core(st, false);
  const out = new Uint8Array(32);
  const picks = [0, 5, 10, 15, 6, 7, 8, 9];
  for (let i = 0; i < 8; i++) writeU32LE(out, i * 4, x[picks[i]]);
  return out;
}

function salsa20Block(subkey: Uint8Array, nonce8: Uint8Array, counter: number): Uint8Array {
  const st = new Uint32Array(16);
  st[0] = SALSA_SIGMA[0];
  st[1] = readU32LE(subkey, 0);
  st[2] = readU32LE(subkey, 4);
  st[3] = readU32LE(subkey, 8);
  st[4] = readU32LE(subkey, 12);
  st[5] = SALSA_SIGMA[1];
  st[6] = readU32LE(nonce8, 0);
  st[7] = readU32LE(nonce8, 4);
  st[8] = counter >>> 0;
  st[9] = Math.floor(counter / 0x1_0000_0000) >>> 0;
  st[10] = SALSA_SIGMA[2];
  st[11] = readU32LE(subkey, 16);
  st[12] = readU32LE(subkey, 20);
  st[13] = readU32LE(subkey, 24);
  st[14] = readU32LE(subkey, 28);
  st[15] = SALSA_SIGMA[3];

  const x = salsa20Core(st, true);
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) writeU32LE(out, i * 4, x[i]);
  return out;
}

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    acc = (acc << 8n) | BigInt(bytes[i]);
  }
  return acc;
}

function poly1305Mac(key32: Uint8Array, msg: Uint8Array): Uint8Array {
  const r = leBytesToBigInt(key32.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBytesToBigInt(key32.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let acc = 0n;

  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, Math.min(i + 16, msg.length));
    const n = leBytesToBigInt(chunk) + (1n << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % p;
  }

  const tagInt = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  let tmp = tagInt;
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return tag;
}

/**
 * Pure TypeScript NaCl `crypto_secretbox_xsalsa20poly1305` seal.
 * Returns `[16-byte Poly1305 tag || ciphertext]`, matching `nacl.secret.SecretBox.encrypt(...).ciphertext`.
 */
export function xsalsa20Poly1305Seal(key32: Uint8Array, nonce24: Uint8Array, message: Uint8Array): Uint8Array {
  if (key32.length !== 32) throw new Error("XSalsa20 key must be 32 bytes");
  if (nonce24.length !== 24) throw new Error("XSalsa20 nonce must be 24 bytes");

  const subkey = hsalsa20(key32, nonce24.subarray(0, 16));
  const nonce8 = nonce24.subarray(16, 24);
  const out = new Uint8Array(16 + message.length);
  const ciphertext = out.subarray(16);

  const block0 = salsa20Block(subkey, nonce8, 0);
  const polyKey = block0.subarray(0, 32);

  let offset = 0;
  for (let i = 0; i < 32 && offset < message.length; i++, offset++) {
    ciphertext[offset] = message[offset] ^ block0[32 + i];
  }

  let counter = 1;
  while (offset < message.length) {
    const block = salsa20Block(subkey, nonce8, counter++);
    for (let i = 0; i < 64 && offset < message.length; i++, offset++) {
      ciphertext[offset] = message[offset] ^ block[i];
    }
  }

  const tag = poly1305Mac(polyKey, ciphertext);
  out.set(tag, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Pure TypeScript MD5 & OpenSSL EVP_BytesToKey AES-256-CBC Decrypt    */
/* ------------------------------------------------------------------ */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000) >>> 0);

/** Compute a 16-byte RFC 1321 MD5 digest (needed in browser/WebView where SubtleCrypto omits MD5). */
export function md5Bytes(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const padLen = ((56 - ((input.length + 1) % 64)) + 64) % 64;
  const padded = new Uint8Array(input.length + 1 + padLen + 8);
  padded.set(input, 0);
  padded[input.length] = 0x80;
  writeU32LE(padded, padded.length - 8, bitLen >>> 0);
  writeU32LE(padded, padded.length - 4, Math.floor(bitLen / 0x1_0000_0000) >>> 0);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = readU32LE(padded, off + j * 4);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const sum = (A + F + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(sum, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  writeU32LE(out, 0, a0);
  writeU32LE(out, 4, b0);
  writeU32LE(out, 8, c0);
  writeU32LE(out, 12, d0);
  return out;
}

/**
 * Decrypt an OpenSSL CryptoJS-formatted AES-256-CBC string (`Salted__` + 8-byte salt + ciphertext)
 * using MD5 `EVP_BytesToKey` key/IV derivation.
 */
export async function openSslAes256CbcDecrypt(b64: string, passphrase: string): Promise<string | null> {
  try {
    const raw = base64ToBytes(b64);
    if (raw.length <= 16) return null;
    const header = String.fromCharCode(...raw.subarray(0, 8));
    if (header !== "Salted__") return null;

    const salt = raw.subarray(8, 16);
    const ciphertext = raw.subarray(16);
    const passBytes = new TextEncoder().encode(passphrase);

    // Derive 32-byte key + 16-byte IV (48 bytes total) via OpenSSL MD5 EVP_BytesToKey.
    const derived = new Uint8Array(48);
    let filled = 0;
    let prev: Uint8Array = new Uint8Array(0);
    while (filled < 48) {
      const chunkInput = new Uint8Array(prev.length + passBytes.length + salt.length);
      chunkInput.set(prev, 0);
      chunkInput.set(passBytes, prev.length);
      chunkInput.set(salt, prev.length + passBytes.length);
      prev = md5Bytes(chunkInput);
      const take = Math.min(prev.length, 48 - filled);
      derived.set(prev.subarray(0, take), filled);
      filled += take;
    }

    return await aes256CbcDecrypt(derived.subarray(0, 32), derived.subarray(32, 48), ciphertext);
  } catch {
    return null;
  }
}
