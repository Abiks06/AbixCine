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

export interface StreamHeaders {
  referer?: string;
  origin?: string;
  ua?: string;
}

export interface Sniffed {
  url: string;
  kind: "hls" | "mp4";
  headers: StreamHeaders;
  subtitles: string[];
  /** HLS: playlist fetched and checked in Rust right after capture (null when not checked). */
  verified: boolean | null;
  quality: number | null;
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** WebView2 exposes custom schemes as http://<scheme>.localhost; other platforms as <scheme>://localhost. */
const PROXY_BASE = navigator.userAgent.includes("Windows") ? "http://abxs.localhost" : "abxs://localhost";

export function proxyUrl(url: string, headers: StreamHeaders = {}) {
  const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v));
  return `${PROXY_BASE}/p?u=${b64(url)}&h=${b64(JSON.stringify(h))}`;
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

export function sniff(url: string, timeoutMs = 14_000): Promise<Sniffed | null> {
  if (!native) return Promise.resolve(null);
  return invoke<Sniffed | null>("sniff_media", { url, timeoutMs });
}

export const shieldStats = () => (native ? invoke<number>("shield_stats") : Promise.resolve(0));
