import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Bridge to the Rust media layer (src-tauri/src/stream.rs, shield.rs):
 * - httpFetch: fetch any page/API without CORS and with any Referer;
 * - proxyUrl: play a stream through the header-adding proxy;
 * - sniff: load an embed off-screen and capture the stream it plays.
 * Outside the desktop app (plain `vite` in a browser) none of this exists, and the source
 * layer falls back to embeds.
 */

export const native = isTauri();

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface StreamHeaders {
  referer?: string;
  origin?: string;
  ua?: string;
}

export interface Sniffed {
  url: string;
  kind: "hls" | "dash" | "mp4";
  headers: StreamHeaders;
  subtitles: string[];
  /** HLS: playlist fetched and checked in Rust right after capture (null when not checked). */
  verified: boolean | null;
  quality: number | null;
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function unb64(s: string): string | null {
  try {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
    const bin = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** WebView2 exposes custom schemes as http://<scheme>.localhost; other platforms as <scheme>://localhost. */
const PROXY_BASE = navigator.userAgent.includes("Windows") ? "http://abxs.localhost" : "abxs://localhost";

function safeOrigin(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.origin && u.origin !== "null" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure Referer, Origin, and User-Agent are consistently populated.
 * Many embed CDNs reject stream/segment requests missing either Referer or Origin.
 */
export function normalizeHeaders(headers: StreamHeaders = {}, fallbackPageUrl?: string): StreamHeaders {
  const fallbackOrigin = safeOrigin(fallbackPageUrl);
  const rawReferer = headers.referer?.trim() || (fallbackOrigin ? `${fallbackOrigin}/` : undefined);
  const refererOrigin = safeOrigin(rawReferer);
  const referer = rawReferer && refererOrigin ? rawReferer : fallbackOrigin ? `${fallbackOrigin}/` : undefined;
  const origin = safeOrigin(headers.origin?.trim()) ?? refererOrigin ?? fallbackOrigin;
  const ua = headers.ua?.trim() || (referer || origin ? DEFAULT_UA : undefined);
  return {
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
    ...(ua ? { ua } : {}),
  };
}

/** Extract the raw target URL and headers if `url` is wrapped in the local `abxs` stream proxy. */
export function unwrapProxyUrl(url: string): { url: string; headers: StreamHeaders; proxied: boolean } {
  if (/^(?:http:\/\/abxs\.localhost|abxs:\/\/localhost)\/p\?/i.test(url)) {
    try {
      const qs = new URL(url.replace(/^abxs:\/\//i, "http://")).searchParams;
      const rawU = qs.get("u");
      const rawH = qs.get("h");
      const target = rawU ? unb64(rawU) : null;
      const parsedH = rawH ? unb64(rawH) : null;
      const headers: StreamHeaders = parsedH ? JSON.parse(parsedH) : {};
      if (target) return { url: target, headers, proxied: true };
    } catch {
      /* fall through */
    }
  }
  return { url, headers: {}, proxied: false };
}

export function proxyUrl(url: string, headers: StreamHeaders = {}, fallbackPageUrl?: string) {
  const unwrapped = unwrapProxyUrl(url);
  const merged = normalizeHeaders({ ...unwrapped.headers, ...headers }, fallbackPageUrl);
  const h = Object.fromEntries(Object.entries(merged).filter(([, v]) => v));
  return `${PROXY_BASE}/p?u=${b64(unwrapped.url)}&h=${b64(JSON.stringify(h))}`;
}

const EXP_PARAM_NAMES = new Set(["exp", "expires", "e", "token_exp", "validto", "endtime", "etime", "until"]);

function parseEpochMs(raw: string): number | null {
  if (!/^\d{10,13}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const ms = raw.length === 10 ? n * 1000 : raw.length === 13 ? n : null;
  if (ms == null) return null;
  // Plausible token window: 2020-01-01 to 2100-01-01
  return ms >= 1_577_836_800_000 && ms <= 4_102_444_800_000 ? ms : null;
}

/**
 * Inspect a stream URL (unwrapping the local proxy if present) for embedded expiration
 * timestamps in query parameters or path segments. Returns true when the token is already expired.
 */
export function isUrlTokenExpired(url: string, now = Date.now()): boolean {
  const { url: target } = unwrapProxyUrl(url);
  try {
    const u = new URL(target);
    for (const [k, v] of u.searchParams.entries()) {
      if (EXP_PARAM_NAMES.has(k.toLowerCase())) {
        const expMs = parseEpochMs(v.trim());
        if (expMs != null && expMs <= now + 5_000) return true;
      }
    }
    const pathMatch = u.pathname.match(/(?:\/|[=;])(?:exp|expires|validto)[=/](\d{10,13})(?:\/|[;&]|$)/i);
    if (pathMatch) {
      const expMs = parseEpochMs(pathMatch[1]);
      if (expMs != null && expMs <= now + 5_000) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export interface FetchResult {
  status: number;
  url: string;
  body: string;
}

export function httpFetch(url: string, headers?: Record<string, string>, init?: { method?: string; body?: string }): Promise<FetchResult> {
  if (!native) return fetch(url, { headers, method: init?.method, body: init?.body }).then(async (r) => ({ status: r.status, url: r.url, body: await r.text() }));
  return invoke<FetchResult>("http_fetch", { url, headers, method: init?.method, body: init?.body });
}

let nextSniffId = 0;

export function sniff(url: string, timeoutMs = 14_000, signal?: AbortSignal): Promise<Sniffed | null> {
  if (!native || signal?.aborted) return Promise.resolve(null);
  const cancelId = `sniff-req-${++nextSniffId}`;
  const call = invoke<Sniffed | null>("sniff_media", { url, timeoutMs, cancelId });
  if (!signal) return call;
  return new Promise<Sniffed | null>((resolve, reject) => {
    const onAbort = () => {
      invoke("cancel_sniff", { cancelId }).catch(() => {});
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? null : v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) resolve(null);
        else reject(e);
      },
    );
  });
}

export const shieldStats = () => (native ? invoke<number>("shield_stats") : Promise.resolve(0));
