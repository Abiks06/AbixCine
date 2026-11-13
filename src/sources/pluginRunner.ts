import type { Settings } from "../lib/settings";
import type { MediaDetail, MediaKind, PlaybackRequest } from "../lib/types";
import { buildSubtitleTracks, fetchWithAbort, inferStreamKind, isAbortError, normalizeQuality, type RawSubtitleInput } from "./extractors/common";
import { normalizeHeaders, proxyUrl, type FetchResult, type StreamHeaders } from "./native";
import type { SourceProvider, StreamCandidate, StreamKind } from "./types";

export const PLUGINS_STORAGE_KEY = "abx.plugins.v1";
export const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000;
export const MIN_PLUGIN_TIMEOUT_MS = 50;
export const MAX_PLUGIN_TIMEOUT_MS = 30_000;
export const DEFAULT_PLUGIN_FETCH_TIMEOUT_MS = 8_000;
export const MAX_PLUGIN_SCRIPT_BYTES = 512 * 1024;
export const MAX_PLUGIN_HTTP_CALLS = 20;
export const MAX_PLUGIN_CANDIDATES = 25;

const VALID_MEDIA_TYPES = new Set<MediaKind>(["movie", "tv", "anime"]);
const VALID_PLUGIN_ID_RX = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const VALID_HOST_PATTERN_RX = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const SAFE_HTTP_METHODS = new Set(["GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"]);

export type PluginMediaType = MediaKind;

export interface ProviderPluginManifest {
  id: string;
  name: string;
  version: string;
  mediaTypes: PluginMediaType[];
  allowedHosts: string[];
  script?: string;
  scriptUrl?: string;
  enabled: boolean;
  priority: number;
  timeoutMs?: number;
  isFrench?: boolean;
  description?: string;
  author?: string;
}

export interface PluginFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface PluginPlaybackContext {
  media: {
    key: string;
    kind: MediaKind;
    title: string;
    originalTitle?: string;
    year?: number;
    malId?: number;
    anilistId?: number;
    tmdbId?: number;
    imdbId?: string;
    originalLanguage?: string;
  };
  season?: number;
  episode?: number;
  courEpisode?: number;
  absolute?: number;
  audio?: "sub" | "dub";
}

export interface PluginStreamOutput {
  url: string;
  kind?: StreamKind | string;
  label?: string;
  quality?: number | string;
  headers?: Record<string, string>;
  pageUrl?: string;
  subtitles?: RawSubtitleInput[];
  audio?: "sub" | "dub" | "dual" | "unknown";
  skip?: { intro?: [number, number]; outro?: [number, number] };
}

export type HostToWorkerMessage =
  | { type: "run"; runId: string; request: PluginPlaybackContext }
  | { type: "httpFetchResult"; callId: string; ok: true; result: FetchResult }
  | { type: "httpFetchResult"; callId: string; ok: false; error: string };

export type WorkerToHostMessage =
  | { type: "ready" }
  | { type: "httpFetch"; callId: string; url: string; opts?: PluginFetchOptions }
  | { type: "result"; runId: string; ok: true; streams: unknown[] }
  | { type: "result"; runId: string; ok: false; error: string };

const scriptCache = new Map<string, string>();
let runCounter = 0;

export function clearPluginScriptCache(): void {
  scriptCache.clear();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function clampTimeout(ms?: number): number {
  if (ms == null || !Number.isFinite(ms)) return DEFAULT_PLUGIN_TIMEOUT_MS;
  return Math.max(MIN_PLUGIN_TIMEOUT_MS, Math.min(MAX_PLUGIN_TIMEOUT_MS, Math.round(ms)));
}

/* ------------------------------------------------------------------ */
/* SSRF & Host Allowlist Validation                                   */
/* ------------------------------------------------------------------ */

function parseIPv4Octets(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split(".");
  if (parts.length === 1) {
    // Single-integer or hex IPv4 (e.g. 2130706433 or 0x7f000001)
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) return null;
    const n = host.toLowerCase().startsWith("0x") ? Number.parseInt(host, 16) : Number(host);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let val: number;
    if (/^0x[0-9a-f]+$/i.test(p)) val = Number.parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) val = Number.parseInt(p, 8);
    else if (/^(?:0|[1-9]\d*)$/.test(p)) val = Number(p);
    else return null;
    if (!Number.isInteger(val) || val < 0 || val > 255) return null;
    out.push(val);
  }
  return [out[0], out[1], out[2], out[3]];
}

function isBlockedIPv4(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function parseIPv6Hextets(rawAddr: string): number[] | null {
  let addr = rawAddr.toLowerCase();
  if (addr.includes("%")) return null; // Reject zone identifiers

  // Handle embedded dotted-quad IPv4 suffix (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(":");
  if (lastColon >= 0 && addr.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4Octets(addr.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;

  const parseGroup = (g: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    return Number.parseInt(g, 16);
  };

  const out: number[] = [];
  for (const g of left) {
    const n = parseGroup(g);
    if (n == null) return null;
    out.push(n);
  }
  if (halves.length === 2) {
    const zeros = 8 - left.length - right.length;
    for (let i = 0; i < zeros; i++) out.push(0);
    for (const g of right) {
      const n = parseGroup(g);
      if (n == null) return null;
      out.push(n);
    }
  }
  return out.length === 8 ? out : null;
}

function isBlockedIPv6(groups: number[]): boolean {
  const allZeroExceptLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroExceptLast && (groups[7] === 0 || groups[7] === 1)) return true; // :: and ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), or NAT64 (64:ff9b::/96)
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isV4Compat = groups.slice(0, 6).every((g) => g === 0);
  const isNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (isV4Mapped || isV4Compat || isNat64) {
    const a = (groups[6] >>> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >>> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isBlockedIPv4(a, b, c, d);
  }
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const clean = hostname.replace(/\.+$/, "").toLowerCase();
  if (!clean) return true;
  if (
    clean === "localhost" ||
    clean.endsWith(".localhost") ||
    clean === "local" ||
    clean.endsWith(".local") ||
    clean === "internal" ||
    clean.endsWith(".internal") ||
    clean === "localdomain" ||
    clean.endsWith(".localdomain") ||
    clean === "home.arpa" ||
    clean.endsWith(".home.arpa")
  ) {
    return true;
  }

  if (clean.startsWith("[") && clean.endsWith("]")) {
    const groups = parseIPv6Hextets(clean.slice(1, -1));
    return !groups || isBlockedIPv6(groups);
  }
  if (clean.includes(":")) {
    const groups = parseIPv6Hextets(clean);
    return !groups || isBlockedIPv6(groups);
  }

  const ipv4 = parseIPv4Octets(clean);
  if (ipv4) return isBlockedIPv4(ipv4[0], ipv4[1], ipv4[2], ipv4[3]);

  return false;
}

function matchesAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  const clean = hostname.replace(/\.+$/, "").toLowerCase();
  for (const rawPattern of allowedHosts) {
    const pattern = rawPattern.trim().toLowerCase().replace(/\.+$/, "");
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (clean.endsWith(suffix) && clean.length > suffix.length) return true;
    } else if (clean === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a plugin network URL for protocol safety (`http:`/`https:` only),
 * SSRF protection (blocks `localhost`, `abxs.localhost`, private/loopback/link-local IPs),
 * and optional `manifest.allowedHosts` enforcement.
 */
export function validatePluginFetchUrl(rawUrl: string, allowedHosts: string[] = []): string {
  if (typeof rawUrl !== "string") throw new Error("URL must be a string");
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096) throw new Error("Invalid plugin URL");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Malformed URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed URL protocol "${parsed.protocol}" (only http/https allowed)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Disallowed credentials in plugin URL");
  }

  const hostname = parsed.hostname.replace(/\.+$/, "").toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked SSRF host "${hostname}"`);
  }
  if (allowedHosts.length > 0 && !matchesAllowedHost(hostname, allowedHosts)) {
    throw new Error(`Host "${hostname}" is not in plugin allowedHosts`);
  }

  return parsed.toString();
}

/* ------------------------------------------------------------------ */
/* Manifest Validation & localStorage Persistence                     */
/* ------------------------------------------------------------------ */

function normalizeAllowedHostEntry(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("allowedHosts entries must be strings");
  const clean = raw.trim().toLowerCase().replace(/\.+$/, "");
  if (!clean || !VALID_HOST_PATTERN_RX.test(clean)) {
    throw new Error(`Invalid allowedHosts entry: "${raw}"`);
  }
  const checkHost = clean.startsWith("*.") ? clean.slice(2) : clean;
  if (isBlockedHostname(checkHost)) {
    throw new Error(`Disallowed local/private host in allowedHosts: "${raw}"`);
  }
  return clean;
}

/** Validate and normalize an untrusted plugin manifest object. */
export function validatePluginManifest(raw: unknown): ProviderPluginManifest {
  if (!isPlainObject(raw)) {
    throw new Error("Plugin manifest must be an object");
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || !VALID_PLUGIN_ID_RX.test(id)) {
    throw new Error("Plugin manifest requires a valid alphanumeric id");
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 100) {
    throw new Error("Plugin manifest requires a non-empty name (max 100 chars)");
  }

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!version || version.length > 40 || /\s/.test(version)) {
    throw new Error("Plugin manifest requires a valid version string");
  }

  if (!Array.isArray(raw.mediaTypes) || raw.mediaTypes.length === 0) {
    throw new Error("Plugin manifest requires at least one mediaType");
  }
  const mediaTypes: PluginMediaType[] = [];
  for (const mt of raw.mediaTypes) {
    if (typeof mt !== "string" || !VALID_MEDIA_TYPES.has(mt as MediaKind)) {
      throw new Error(`Invalid mediaType "${String(mt)}"`);
    }
    if (!mediaTypes.includes(mt as MediaKind)) mediaTypes.push(mt as MediaKind);
  }

  if (!Array.isArray(raw.allowedHosts)) {
    throw new Error("Plugin manifest requires an allowedHosts array");
  }
  const allowedHosts: string[] = [];
  for (const h of raw.allowedHosts) {
    const norm = normalizeAllowedHostEntry(h);
    if (!allowedHosts.includes(norm)) allowedHosts.push(norm);
  }

  let script: string | undefined;
  if (raw.script !== undefined) {
    if (typeof raw.script !== "string") throw new Error("Plugin script must be a string");
    const trimmedScript = raw.script.trim();
    if (trimmedScript.length > 0) {
      if (new TextEncoder().encode(raw.script).byteLength > MAX_PLUGIN_SCRIPT_BYTES) {
        throw new Error(`Plugin script exceeds ${MAX_PLUGIN_SCRIPT_BYTES} byte limit`);
      }
      script = raw.script;
    }
  }

  let scriptUrl: string | undefined;
  if (raw.scriptUrl !== undefined) {
    if (typeof raw.scriptUrl !== "string") throw new Error("Plugin scriptUrl must be a string");
    const trimmedUrl = raw.scriptUrl.trim();
    if (trimmedUrl.length > 0) {
      scriptUrl = validatePluginFetchUrl(trimmedUrl);
    }
  }

  if (!script && !scriptUrl) {
    throw new Error("Plugin manifest requires either script or scriptUrl");
  }

  if (typeof raw.enabled !== "boolean") {
    throw new Error("Plugin manifest requires a boolean enabled field");
  }

  if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
    throw new Error("Plugin manifest requires a finite numeric priority");
  }

  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      throw new Error("Plugin timeoutMs must be a positive number");
    }
    timeoutMs = clampTimeout(raw.timeoutMs);
  }

  return {
    id,
    name,
    version,
    mediaTypes,
    allowedHosts,
    ...(script !== undefined ? { script } : {}),
    ...(scriptUrl !== undefined ? { scriptUrl } : {}),
    enabled: raw.enabled,
    priority: raw.priority,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof raw.isFrench === "boolean" ? { isFrench: raw.isFrench } : {}),
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(typeof raw.author === "string" && raw.author.trim() ? { author: raw.author.trim() } : {}),
  };
}

function readPluginsRaw(): ProviderPluginManifest[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PLUGINS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ProviderPluginManifest[] = [];
    const seenIds = new Set<string>();
    for (const item of parsed) {
      try {
        const valid = validatePluginManifest(item);
        if (!seenIds.has(valid.id)) {
          seenIds.add(valid.id);
          out.push(valid);
        }
      } catch {
        /* ignore corrupted plugin entries */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writePluginsRaw(plugins: ProviderPluginManifest[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PLUGINS_STORAGE_KEY, JSON.stringify(plugins));
  } catch {
    /* storage unavailable or quota exceeded */
  }
}

export function listPlugins(): ProviderPluginManifest[] {
  return readPluginsRaw().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

export function getPlugin(id: string): ProviderPluginManifest | undefined {
  return readPluginsRaw().find((p) => p.id === id);
}

export function installPlugin(manifest: ProviderPluginManifest): ProviderPluginManifest {
  const valid = validatePluginManifest(manifest);
  const existing = readPluginsRaw().filter((p) => p.id !== valid.id);
  existing.push(valid);
  writePluginsRaw(existing);
  for (const key of scriptCache.keys()) {
    if (key.startsWith(`${valid.id}:`)) scriptCache.delete(key);
  }
  return valid;
}

export function removePlugin(id: string): boolean {
  const existing = readPluginsRaw();
  const next = existing.filter((p) => p.id !== id);
  if (next.length === existing.length) return false;
  writePluginsRaw(next);
  for (const key of scriptCache.keys()) {
    if (key.startsWith(`${id}:`)) scriptCache.delete(key);
  }
  return true;
}

export function togglePlugin(id: string, enabled?: boolean): ProviderPluginManifest | null {
  const existing = readPluginsRaw();
  const idx = existing.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const current = existing[idx];
  const nextManifest: ProviderPluginManifest = {
    ...current,
    enabled: enabled !== undefined ? Boolean(enabled) : !current.enabled,
  };
  existing[idx] = nextManifest;
  writePluginsRaw(existing);
  return nextManifest;
}

export function clearPlugins(): void {
  scriptCache.clear();
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(PLUGINS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Isolated WebWorker Sandbox & Capability-Locked RPC                 */
/* ------------------------------------------------------------------ */

const BLOCKED_WORKER_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "caches",
  "indexedDB",
] as const;

const LOCKED_RPC_GLOBALS = [
  "postMessage",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "onmessage",
  "onmessageerror",
  "close",
] as const;

/**
 * Generate the self-contained sandbox worker script.
 * Strips/shadows ambient network and RPC globals before evaluating plugin code so all network
 * I/O must go through the capability-locked `host.httpFetch(url, opts)` bridge.
 */
export function buildSandboxWorkerScript(pluginScript: string): string {
  const blockedList = JSON.stringify(BLOCKED_WORKER_GLOBALS);
  const rpcList = JSON.stringify(LOCKED_RPC_GLOBALS);
  return `(function() {
  "use strict";
  const __global = typeof globalThis !== "undefined" ? globalThis : self;
  const __post = __global.postMessage.bind(__global);
  const __addListener = __global.addEventListener.bind(__global);
  const __pendingFetch = new Map();
  let __callSeq = 0;

  function __toErrMsg(err) {
    if (err && typeof err === "object" && typeof err.message === "string") return err.message;
    return String(err || "Unknown plugin error");
  }

  for (const __name of ${blockedList}) {
    try {
      Object.defineProperty(__global, __name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      try { __global[__name] = undefined; } catch {}
    }
  }

  try {
    if (__global.navigator && "sendBeacon" in __global.navigator) {
      Object.defineProperty(__global.navigator, "sendBeacon", {
        value: undefined,
        writable: false,
        configurable: false,
      });
    }
  } catch {}

  const __host = Object.freeze({
    httpFetch: function(url, opts) {
      return new Promise(function(resolve, reject) {
        if (typeof url !== "string" || !url.trim()) {
          reject(new Error("host.httpFetch requires a non-empty URL string"));
          return;
        }
        const callId = "c" + (++__callSeq);
        __pendingFetch.set(callId, { resolve, reject });
        const cleanOpts = opts && typeof opts === "object"
          ? {
              method: typeof opts.method === "string" ? opts.method : undefined,
              headers: opts.headers && typeof opts.headers === "object" ? opts.headers : undefined,
              body: typeof opts.body === "string" ? opts.body : undefined,
              timeoutMs: typeof opts.timeoutMs === "number" ? opts.timeoutMs : undefined,
            }
          : undefined;
        __post({ type: "httpFetch", callId, url, opts: cleanOpts });
      });
    },
  });

  const __module = { exports: {} };
  let __entry = null;
  let __loadError = null;

  try {
    let find;
    let getStreams;
    (function(
      host,
      module,
      exports,
      fetch,
      XMLHttpRequest,
      WebSocket,
      EventSource,
      importScripts,
      BroadcastChannel,
      Worker,
      SharedWorker,
      postMessage,
      addEventListener,
      close
    ) {
      "use strict";
${pluginScript}
      if (typeof find === "function" && typeof module.exports === "object" && module.exports && typeof module.exports.find !== "function") {
        module.exports.find = find;
      }
      if (typeof getStreams === "function" && typeof module.exports === "object" && module.exports && typeof module.exports.getStreams !== "function") {
        module.exports.getStreams = getStreams;
      }
    })(
      __host,
      __module,
      __module.exports,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );

    const exp = __module.exports;
    if (typeof exp === "function") {
      if (exp.prototype && (typeof exp.prototype.find === "function" || typeof exp.prototype.getStreams === "function")) {
        const inst = new exp();
        __entry = typeof inst.find === "function" ? inst.find.bind(inst) : inst.getStreams.bind(inst);
      } else {
        __entry = exp;
      }
    } else if (exp && typeof exp === "object") {
      if (typeof exp.find === "function") __entry = exp.find.bind(exp);
      else if (typeof exp.getStreams === "function") __entry = exp.getStreams.bind(exp);
    }
  } catch (err) {
    __loadError = __toErrMsg(err);
  }

  __addListener("message", async function(ev) {
    const msg = ev && ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "httpFetchResult") {
      const pending = __pendingFetch.get(msg.callId);
      if (!pending) return;
      __pendingFetch.delete(msg.callId);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(typeof msg.error === "string" ? msg.error : "host.httpFetch failed"));
      return;
    }

    if (msg.type === "run") {
      const runId = msg.runId;
      if (__loadError) {
        __post({ type: "result", runId, ok: false, error: __loadError });
        return;
      }
      if (typeof __entry !== "function") {
        __post({ type: "result", runId, ok: false, error: "Plugin must export find(req, host), getStreams(req, host), or a default function" });
        return;
      }
      try {
        const out = await __entry(msg.request, __host);
        const streams = Array.isArray(out)
          ? out
          : out && typeof out === "object" && Array.isArray(out.streams)
            ? out.streams
            : [];
        __post({ type: "result", runId, ok: true, streams });
      } catch (err) {
        __post({ type: "result", runId, ok: false, error: __toErrMsg(err) });
      }
    }
  });

  for (const __rpcProp of ${rpcList}) {
    try {
      Object.defineProperty(__global, __rpcProp, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      try { __global[__rpcProp] = undefined; } catch {}
    }
  }

  __post({ type: "ready" });
})();
`;
}

function toPluginPlaybackContext(req: PlaybackRequest): PluginPlaybackContext {
  const detail = req.media as MediaDetail;
  return {
    media: {
      key: req.media.key,
      kind: req.media.kind,
      title: req.media.title,
      ...(req.media.originalTitle ? { originalTitle: req.media.originalTitle } : {}),
      ...(req.media.year != null ? { year: req.media.year } : {}),
      ...(req.media.malId != null ? { malId: req.media.malId } : {}),
      ...(req.media.anilistId != null ? { anilistId: req.media.anilistId } : {}),
      ...(req.media.tmdbId != null ? { tmdbId: req.media.tmdbId } : {}),
      ...(detail.imdbId ? { imdbId: detail.imdbId } : {}),
      ...(req.media.originalLanguage ? { originalLanguage: req.media.originalLanguage } : {}),
    },
    ...(req.season != null ? { season: req.season } : {}),
    ...(req.episode != null ? { episode: req.episode } : {}),
    ...(req.courEpisode != null ? { courEpisode: req.courEpisode } : {}),
    ...(req.absolute != null ? { absolute: req.absolute } : {}),
    ...(req.audio ? { audio: req.audio } : {}),
  };
}

function sanitizePluginHeaders(raw?: Record<string, string>): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    const cleanKey = k.replace(/[\r\n:]/g, "").trim();
    const cleanVal = v.replace(/[\r\n]/g, "").trim();
    if (!cleanKey || !cleanVal) continue;
    out[cleanKey] = cleanVal;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickStreamHeaders(raw: unknown, fallbackPageUrl?: string): StreamHeaders {
  if (!isPlainObject(raw)) return normalizeHeaders({}, fallbackPageUrl);
  const referer = typeof raw.referer === "string" ? raw.referer : typeof raw.Referer === "string" ? raw.Referer : undefined;
  const origin = typeof raw.origin === "string" ? raw.origin : typeof raw.Origin === "string" ? raw.Origin : undefined;
  const ua = typeof raw.ua === "string" ? raw.ua : typeof raw["User-Agent"] === "string" ? raw["User-Agent"] : undefined;
  return normalizeHeaders({ referer, origin, ua }, fallbackPageUrl);
}

function normalizeSkipRange(raw: unknown): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [start, end] = raw;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return undefined;
  return [start, end];
}

/**
 * Convert raw stream entries returned by a sandboxed JS plugin into validated,
 * `abxs:`-proxied `StreamCandidate[]` ready for `probeHedged` and `health.ts`.
 */
export function normalizePluginCandidates(manifest: ProviderPluginManifest, rawStreams: unknown): StreamCandidate[] {
  if (!Array.isArray(rawStreams)) return [];
  const providerId = `plugin:${manifest.id}`;
  const seen = new Set<string>();
  const out: StreamCandidate[] = [];

  for (const raw of rawStreams) {
    if (out.length >= MAX_PLUGIN_CANDIDATES) break;
    if (!isPlainObject(raw) || typeof raw.url !== "string") continue;

    let safeUrl: string;
    try {
      safeUrl = validatePluginFetchUrl(raw.url);
    } catch {
      continue;
    }

    let safePageUrl: string | undefined;
    if (typeof raw.pageUrl === "string" && raw.pageUrl.trim()) {
      try {
        safePageUrl = validatePluginFetchUrl(raw.pageUrl);
      } catch {
        safePageUrl = undefined;
      }
    }

    const kindHint = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : undefined;
    const kind: StreamKind = kindHint === "embed" ? "embed" : inferStreamKind(safeUrl, kindHint);
    const via: StreamCandidate["via"] = kind === "embed" ? "embed" : "direct";
    const pageUrl = safePageUrl ?? (kind === "embed" ? safeUrl : undefined);
    const headers = pickStreamHeaders(raw.headers, pageUrl ?? safeUrl);
    const finalUrl = kind === "embed" ? safeUrl : proxyUrl(safeUrl, headers, pageUrl ?? headers.referer ?? safeUrl);

    const key = pageUrl ?? finalUrl;
    if (seen.has(key)) continue;
    seen.add(key);

    const quality = normalizeQuality(raw.quality);
    const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
    const label = rawLabel || `${manifest.name}${quality ? ` · ${quality}p` : ""} · ${kind.toUpperCase()}`;

    const rawSubs = Array.isArray(raw.subtitles) ? (raw.subtitles as RawSubtitleInput[]) : undefined;
    const subtitles = rawSubs ? buildSubtitleTracks(rawSubs, headers, pageUrl ?? headers.referer ?? safeUrl) : [];

    const audio =
      raw.audio === "sub" || raw.audio === "dub" || raw.audio === "dual" || raw.audio === "unknown"
        ? raw.audio
        : undefined;

    let skip: StreamCandidate["skip"];
    if (isPlainObject(raw.skip)) {
      const intro = normalizeSkipRange(raw.skip.intro);
      const outro = normalizeSkipRange(raw.skip.outro);
      if (intro || outro) {
        skip = { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) };
      }
    }

    out.push({
      providerId,
      providerName: manifest.name,
      label,
      url: finalUrl,
      kind,
      via,
      ...(quality != null ? { quality } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(subtitles.length > 0 ? { subtitles } : {}),
      ...(audio ? { audio } : {}),
      ...(skip ? { skip } : {}),
    });
  }

  return out;
}

async function resolvePluginScript(manifest: ProviderPluginManifest, signal?: AbortSignal): Promise<string> {
  if (manifest.script && manifest.script.trim()) return manifest.script;
  if (!manifest.scriptUrl) throw new Error(`Plugin "${manifest.id}" has no script or scriptUrl`);

  const safeUrl = validatePluginFetchUrl(manifest.scriptUrl);
  const cacheKey = `${manifest.id}:${manifest.version}:${safeUrl}`;
  const cached = scriptCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const timeoutMs = clampTimeout(manifest.timeoutMs);
  const res = await fetchWithAbort(safeUrl, { Accept: "application/javascript, text/javascript, text/plain" }, undefined, signal, timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to fetch plugin script (${res.status})`);
  }
  if (res.url) validatePluginFetchUrl(res.url);

  if (!res.body.trim()) throw new Error(`Plugin "${manifest.id}" scriptUrl returned empty body`);
  if (new TextEncoder().encode(res.body).byteLength > MAX_PLUGIN_SCRIPT_BYTES) {
    throw new Error(`Remote plugin script exceeds ${MAX_PLUGIN_SCRIPT_BYTES} byte limit`);
  }

  scriptCache.set(cacheKey, res.body);
  return res.body;
}

/**
 * Execute a single validated plugin inside an isolated Blob-URL WebWorker sandbox.
 * Terminates and cleans up the worker immediately on completion, error, timeout, or AbortSignal.
 */
export async function runPlugin(
  manifest: ProviderPluginManifest,
  req: PlaybackRequest,
  signal?: AbortSignal,
): Promise<StreamCandidate[]> {
  if (signal?.aborted) throw createAbortError(signal);

  const valid = validatePluginManifest(manifest);
  if (!valid.mediaTypes.includes(req.media.kind)) return [];

  const pluginScript = await resolvePluginScript(valid, signal);
  if (signal?.aborted) throw createAbortError(signal);

  if (typeof Worker !== "function") {
    throw new Error("WebWorker is unavailable in this environment");
  }
  if (typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") {
    throw new Error("Blob URL creation is unavailable in this environment");
  }

  const timeoutMs = clampTimeout(valid.timeoutMs);
  const runId = `run-${++runCounter}`;
  const wrappedScript = buildSandboxWorkerScript(pluginScript);
  const blobUrl = URL.createObjectURL(new Blob([wrappedScript], { type: "application/javascript" }));
  const worker = new Worker(blobUrl);

  return new Promise<StreamCandidate[]>((resolve, reject) => {
    let settled = false;
    let httpCalls = 0;
    const startedAt = Date.now();
    const inFlightFetches = new Set<AbortController>();
    let runTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (runTimer !== undefined) clearTimeout(runTimer);
      signal?.removeEventListener("abort", onAbort);
      for (const ctl of inFlightFetches) ctl.abort();
      inFlightFetches.clear();
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try {
        worker.terminate();
      } catch {
        /* ignore terminate failure */
      }
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* ignore revoke failure */
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (streams: StreamCandidate[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(streams);
    };

    const onAbort = () => {
      fail(createAbortError(signal));
    };

    runTimer = setTimeout(() => {
      fail(new Error(`Plugin "${valid.id}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    const replyFetch = (msg: Extract<HostToWorkerMessage, { type: "httpFetchResult" }>) => {
      if (settled) return;
      try {
        worker.postMessage(msg);
      } catch {
        /* worker already terminated */
      }
    };

    const handleHttpFetch = async (callId: string, rawUrl: string, opts?: PluginFetchOptions) => {
      httpCalls++;
      if (httpCalls > MAX_PLUGIN_HTTP_CALLS) {
        replyFetch({
          type: "httpFetchResult",
          callId,
          ok: false,
          error: `Exceeded max HTTP calls (${MAX_PLUGIN_HTTP_CALLS}) per plugin run`,
        });
        return;
      }

      let safeUrl: string;
      try {
        safeUrl = validatePluginFetchUrl(rawUrl, valid.allowedHosts);
      } catch (err) {
        replyFetch({
          type: "httpFetchResult",
          callId,
          ok: false,
          error: err instanceof Error ? err.message : "URL blocked by host sandbox",
        });
        return;
      }

      const rawMethod = typeof opts?.method === "string" ? opts.method.trim().toUpperCase() : "GET";
      if (!SAFE_HTTP_METHODS.has(rawMethod)) {
        replyFetch({
          type: "httpFetchResult",
          callId,
          ok: false,
          error: `Disallowed HTTP method "${rawMethod}"`,
        });
        return;
      }

      const cleanHeaders = sanitizePluginHeaders(opts?.headers);
      const body = typeof opts?.body === "string" ? opts.body : undefined;
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(MIN_PLUGIN_TIMEOUT_MS, timeoutMs - elapsed);
      const requestedTimeout =
        typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
          ? opts.timeoutMs
          : DEFAULT_PLUGIN_FETCH_TIMEOUT_MS;
      const callTimeout = Math.min(requestedTimeout, remaining);

      const callCtl = new AbortController();
      inFlightFetches.add(callCtl);
      try {
        const res = await fetchWithAbort(
          safeUrl,
          cleanHeaders,
          rawMethod === "GET" && body == null ? undefined : { method: rawMethod, body },
          callCtl.signal,
          callTimeout,
        );
        if (settled || callCtl.signal.aborted) return;
        if (res.url) {
          validatePluginFetchUrl(res.url, valid.allowedHosts);
        }
        replyFetch({ type: "httpFetchResult", callId, ok: true, result: res });
      } catch (err) {
        if (settled || callCtl.signal.aborted) return;
        replyFetch({
          type: "httpFetchResult",
          callId,
          ok: false,
          error: err instanceof Error ? err.message : "httpFetch failed",
        });
      } finally {
        inFlightFetches.delete(callCtl);
      }
    };

    worker.onmessage = (ev: MessageEvent<WorkerToHostMessage>) => {
      if (settled) return;
      const msg = ev?.data;
      if (!isPlainObject(msg) || typeof msg.type !== "string") return;

      if (msg.type === "ready") return;

      if (msg.type === "httpFetch") {
        if (typeof msg.callId !== "string" || typeof msg.url !== "string") return;
        void handleHttpFetch(msg.callId, msg.url, isPlainObject(msg.opts) ? (msg.opts as PluginFetchOptions) : undefined);
        return;
      }

      if (msg.type === "result") {
        if (msg.runId !== runId) return;
        if (msg.ok === true) {
          succeed(normalizePluginCandidates(valid, msg.streams));
        } else {
          fail(new Error(typeof msg.error === "string" ? msg.error : "Plugin execution failed"));
        }
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      fail(new Error(ev?.message || `Plugin "${valid.id}" worker crashed`));
    };

    worker.onmessageerror = () => {
      fail(new Error(`Plugin "${valid.id}" sent non-cloneable message`));
    };

    try {
      worker.postMessage({
        type: "run",
        runId,
        request: toPluginPlaybackContext(req),
      } satisfies HostToWorkerMessage);
    } catch (err) {
      fail(err instanceof Error ? err : new Error("Failed to dispatch run message to plugin worker"));
    }
  });
}

/* ------------------------------------------------------------------ */
/* AbixCine SourceProvider Exports                                    */
/* ------------------------------------------------------------------ */

function isPluginProviderEnabled(manifest: ProviderPluginManifest, s: Settings): boolean {
  if (!manifest.enabled) return false;
  const disabled = s.disabledSources ?? [];
  if (disabled.includes("plugins") || disabled.includes(`plugin:${manifest.id}`)) return false;
  return true;
}

/**
 * Create individual `SourceProvider` adapters for each installed plugin so they can participate
 * independently in `probeHedged`, `health.ts` circuit-breaking, and `abx.serverWins.v1`.
 */
export function createPluginProviders(): SourceProvider[] {
  return listPlugins().map((manifest) => ({
    id: `plugin:${manifest.id}`,
    name: manifest.name,
    category: "external",
    priority: manifest.priority,
    ...(manifest.isFrench ? { isFrench: true } : {}),
    timeoutMs: clampTimeout(manifest.timeoutMs),
    isEnabled: (s: Settings) => {
      const current = getPlugin(manifest.id);
      return current ? isPluginProviderEnabled(current, s) : false;
    },
    async find(req: PlaybackRequest, s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
      const current = getPlugin(manifest.id) ?? manifest;
      if (!isPluginProviderEnabled(current, s) || !current.mediaTypes.includes(req.media.kind) || signal.aborted) {
        return [];
      }
      try {
        return await runPlugin(current, req, signal);
      } catch (err) {
        if (isAbortError(err)) return [];
        throw err;
      }
    },
  }));
}

/**
 * Aggregate `SourceProvider` running all enabled installed JS plugins matching the request's
 * `media.kind` in parallel inside isolated WebWorker sandboxes.
 */
export const pluginProvidersSource: SourceProvider = {
  id: "plugins",
  name: "JS Plugins",
  category: "external",
  priority: 22,
  timeoutMs: 15_000,
  isEnabled: (s: Settings) =>
    !s.disabledSources?.includes("plugins") &&
    listPlugins().some((p) => isPluginProviderEnabled(p, s)),
  async find(req: PlaybackRequest, s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted || s.disabledSources?.includes("plugins")) return [];
    const active = listPlugins().filter(
      (p) => isPluginProviderEnabled(p, s) && p.mediaTypes.includes(req.media.kind),
    );
    if (active.length === 0) return [];

    const settled = await Promise.allSettled(active.map((p) => runPlugin(p, req, signal)));
    if (signal.aborted) return [];

    const seen = new Set<string>();
    const out: StreamCandidate[] = [];
    for (const res of settled) {
      if (res.status !== "fulfilled") continue;
      for (const c of res.value) {
        const key = c.pageUrl ?? c.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
    return out;
  },
};
