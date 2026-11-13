/**
 * Online subtitle discovery & downloading across Wyzie Subs and OpenSubtitles v3 (Stremio API).
 * Uses `httpFetch` from `../sources/native` to bypass webview CORS on desktop, with timeout,
 * AbortSignal cancellation, LRU caching, language normalization, scoring, and deduplication.
 */

import { httpFetch, httpFetchBytes, unwrapProxyUrl } from "../sources/native";
import {
  decodeSubtitle,
  langBase,
  langLabel,
  normalizeSubLang,
  parseSubtitles,
  type ParsedSubtitles,
  type SubHIFilter,
} from "./subtitles";

export interface OnlineSubtitleQuery {
  tmdbId?: number;
  imdbId?: string;
  title?: string;
  year?: number;
  kind?: "movie" | "tv" | "anime";
  season?: number;
  episode?: number;
  languages?: string[];
  preferHearingImpaired?: SubHIFilter;
}

export interface OnlineSubtitleResult {
  id: string;
  provider: "wyzie" | "opensubtitles";
  lang: string;
  langName: string;
  release: string;
  format: "srt" | "vtt" | "ass" | "ssa";
  url: string;
  hearingImpaired: boolean;
  forced: boolean;
  downloads?: number;
  score: number;
}

const PROVIDER_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 50;

const searchCache = new Map<string, { at: number; results: OnlineSubtitleResult[] }>();

/** Clear in-memory online subtitle search cache. */
export function clearSubtitleSearchCache(): void {
  searchCache.clear();
}

/**
 * Normalize ISO-639-1/2/3 and regional language codes:
 * `eng` -> `en`, `spa` -> `es`, `jpn` -> `ja`, `fre`/`fra` -> `fr`, `ger`/`deu` -> `de`,
 * `por` -> `pt`, `pob` -> `pt-br`, `kor` -> `ko`, `zho`/`chi` -> `zh`, `ara` -> `ar`,
 * `hin` -> `hi`, `rus` -> `ru`, `ita` -> `it`, etc.
 */
export function normalizeLangCode(code?: string): string {
  return normalizeSubLang(code);
}

function abortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("Aborted", "AbortError")
    : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function withTimeoutAndAbort<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    work.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Subtitle request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

function inferOnlineFormat(rawFormat?: unknown, url?: string, release?: string): "srt" | "vtt" | "ass" | "ssa" {
  const fmt = typeof rawFormat === "string" ? rawFormat.trim().toLowerCase() : "";
  if (fmt === "ass" || fmt === "ssa" || fmt === "vtt" || fmt === "srt") return fmt;
  if (fmt === "subrip") return "srt";
  if (fmt === "webvtt") return "vtt";

  const inspect = `${url ?? ""} ${release ?? ""}`.toLowerCase();
  if (/\.ass(?:$|[?#\s])/.test(inspect)) return "ass";
  if (/\.ssa(?:$|[?#\s])/.test(inspect)) return "ssa";
  if (/\.vtt(?:$|[?#\s])/.test(inspect)) return "vtt";
  return "srt";
}

function isValidHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/\S+/i.test(url.trim());
}

function normalizeImdbId(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^tt\d+$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^\d+$/.test(trimmed)) return `tt${trimmed}`;
  return trimmed;
}

interface RawOnlineSub {
  id: string;
  provider: "wyzie" | "opensubtitles";
  lang: string;
  langName: string;
  release: string;
  format: "srt" | "vtt" | "ass" | "ssa";
  url: string;
  hearingImpaired: boolean;
  forced: boolean;
  downloads?: number;
}

async function queryWyzie(query: OnlineSubtitleQuery, signal?: AbortSignal): Promise<{ ok: boolean; items: RawOnlineSub[] }> {
  const imdb = normalizeImdbId(query.imdbId);
  const idParam = query.tmdbId != null && Number.isFinite(query.tmdbId) && query.tmdbId > 0 ? String(query.tmdbId) : imdb;
  if (!idParam) return { ok: true, items: [] };

  const params = new URLSearchParams({ id: idParam });
  if (query.season != null && query.episode != null) {
    params.set("season", String(query.season));
    params.set("episode", String(query.episode));
  }
  const url = `https://sub.wyzie.ru/search?${params.toString()}`;

  const res = await withTimeoutAndAbort(
    httpFetch(url, { Accept: "application/json" }),
    PROVIDER_TIMEOUT_MS,
    signal,
  );
  if (res.status < 200 || res.status >= 300) return { ok: false, items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { ok: false, items: [] };
  }
  if (!Array.isArray(parsed)) return { ok: false, items: [] };

  const items: RawOnlineSub[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (!isValidHttpUrl(rec.url)) continue;

    const lang = normalizeLangCode(
      typeof rec.language === "string"
        ? rec.language
        : typeof rec.lang === "string"
          ? rec.lang
          : typeof rec.iso639 === "string"
            ? rec.iso639
            : undefined,
    );
    const releaseRaw =
      (typeof rec.release === "string" && rec.release.trim()) ||
      (typeof rec.fileName === "string" && rec.fileName.trim()) ||
      (typeof rec.title === "string" && rec.title.trim()) ||
      (typeof rec.media === "string" && rec.media.trim()) ||
      "Wyzie";
    const format = inferOnlineFormat(rec.format, rec.url, releaseRaw);
    const downloads =
      typeof rec.downloads === "number" && Number.isFinite(rec.downloads)
        ? rec.downloads
        : typeof rec.downloadCount === "number" && Number.isFinite(rec.downloadCount)
          ? rec.downloadCount
          : undefined;
    const hearingImpaired = Boolean(rec.isHearingImpaired ?? rec.hearingImpaired ?? rec.hi) || /\b(sdh|cc|hi)\b/i.test(releaseRaw);
    const forced = Boolean(rec.isForced ?? rec.forced) || /\bforced\b/i.test(releaseRaw);
    const display = typeof rec.display === "string" && rec.display.trim() ? rec.display.trim() : langLabel(lang);

    items.push({
      id: `wyzie-${typeof rec.id === "string" || typeof rec.id === "number" ? String(rec.id) : i}`,
      provider: "wyzie",
      lang,
      langName: lang === "und" ? display : langLabel(lang),
      release: releaseRaw,
      format,
      url: rec.url.trim(),
      hearingImpaired,
      forced,
      ...(downloads !== undefined ? { downloads } : {}),
    });
  }
  return { ok: true, items };
}

async function queryOpenSubtitles(query: OnlineSubtitleQuery, signal?: AbortSignal): Promise<{ ok: boolean; items: RawOnlineSub[] }> {
  const imdb = normalizeImdbId(query.imdbId);
  if (!imdb) return { ok: true, items: [] };

  const isEpisodic = query.kind === "tv" || query.season != null || query.episode != null;
  if (isEpisodic && query.episode == null) return { ok: true, items: [] };

  const target = isEpisodic
    ? `series/${encodeURIComponent(imdb)}:${query.season ?? 1}:${query.episode}.json`
    : `movie/${encodeURIComponent(imdb)}.json`;
  const url = `https://opensubtitles-v3.strem.io/subtitles/${target}`;

  const res = await withTimeoutAndAbort(
    httpFetch(url, { Accept: "application/json" }),
    PROVIDER_TIMEOUT_MS,
    signal,
  );
  if (res.status < 200 || res.status >= 300) return { ok: false, items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { ok: false, items: [] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { subtitles?: unknown }).subtitles)) {
    return { ok: false, items: [] };
  }

  const list = (parsed as { subtitles: unknown[] }).subtitles;
  const items: RawOnlineSub[] = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (!isValidHttpUrl(rec.url)) continue;

    const lang = normalizeLangCode(typeof rec.lang === "string" ? rec.lang : undefined);
    const releaseRaw =
      (typeof rec.SubFileName === "string" && rec.SubFileName.trim()) ||
      (typeof rec.release === "string" && rec.release.trim()) ||
      (typeof rec.title === "string" && rec.title.trim()) ||
      (typeof rec.name === "string" && rec.name.trim()) ||
      "OpenSubtitles";
    const format = inferOnlineFormat(rec.format, rec.url, releaseRaw);
    const downloads =
      typeof rec.downloads === "number" && Number.isFinite(rec.downloads) ? rec.downloads : undefined;
    const hearingImpaired = Boolean(rec.hearingImpaired ?? rec.hi) || /\b(sdh|cc|hi)\b/i.test(releaseRaw);
    const forced = Boolean(rec.forced) || /\bforced\b/i.test(releaseRaw);

    items.push({
      id: `os-${typeof rec.id === "string" || typeof rec.id === "number" ? String(rec.id) : i}`,
      provider: "opensubtitles",
      lang,
      langName: langLabel(lang),
      release: releaseRaw,
      format,
      url: rec.url.trim(),
      hearingImpaired,
      forced,
      ...(downloads !== undefined ? { downloads } : {}),
    });
  }
  return { ok: true, items };
}

function scoreOnlineSub(
  item: RawOnlineSub,
  preferredLangs: string[],
  hiFilter: SubHIFilter,
): number {
  let score = 0;

  if (preferredLangs.length) {
    let langPoints = 0;
    for (let i = 0; i < preferredLangs.length; i++) {
      const want = preferredLangs[i];
      if (item.lang === want) {
        langPoints = Math.max(langPoints, 500 - i * 40);
        break;
      }
      if (langBase(item.lang) !== "und" && langBase(item.lang) === langBase(want)) {
        langPoints = Math.max(langPoints, 380 - i * 40);
      }
    }
    score += langPoints;
  }

  if (hiFilter === "prefer") score += item.hearingImpaired ? 80 : 0;
  else if (hiFilter === "avoid") score += item.hearingImpaired ? -90 : 20;
  else score += item.hearingImpaired ? 0 : 5;

  score += item.forced ? -60 : 25;

  if (item.format === "ass" || item.format === "ssa") score += 20;
  else if (item.format === "vtt") score += 12;
  else score += 8;

  if (item.downloads && item.downloads > 0) {
    score += Math.round(Math.min(30, Math.log10(item.downloads + 1) * 8) * 10) / 10;
  }

  return score;
}

function deduplicateResults(results: OnlineSubtitleResult[]): OnlineSubtitleResult[] {
  const byUrl = new Map<string, OnlineSubtitleResult>();
  for (const r of results) {
    const key = r.url.trim();
    const prev = byUrl.get(key);
    if (!prev || r.score > prev.score) byUrl.set(key, r);
  }

  const byRelease = new Map<string, OnlineSubtitleResult>();
  const genericReleases = new Set(["wyzie", "opensubtitles", "subtitles", "subtitle"]);
  const out: OnlineSubtitleResult[] = [];

  for (const r of byUrl.values()) {
    const normRelease = r.release.toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, "").replace(/\s+/g, " ").trim();
    if (normRelease.length >= 6 && !genericReleases.has(normRelease)) {
      const dedupKey = `${r.lang}|${r.format}|${r.hearingImpaired ? 1 : 0}|${r.forced ? 1 : 0}|${normRelease}`;
      const prev = byRelease.get(dedupKey);
      if (prev) {
        if (r.score > prev.score) byRelease.set(dedupKey, r);
        continue;
      }
      byRelease.set(dedupKey, r);
    } else {
      out.push(r);
    }
  }

  return [...byRelease.values(), ...out];
}

function buildCacheKey(query: OnlineSubtitleQuery, preferredLangs: string[], hiFilter: SubHIFilter): string {
  return JSON.stringify({
    tmdbId: query.tmdbId ?? null,
    imdbId: normalizeImdbId(query.imdbId) ?? null,
    kind: query.kind ?? null,
    season: query.season ?? null,
    episode: query.episode ?? null,
    languages: preferredLangs,
    hiFilter,
  });
}

/**
 * Search Wyzie Subs and OpenSubtitles v3 in parallel, score and rank matches,
 * deduplicate cleanly, and never throw on partial provider errors or malformed JSON.
 */
export async function searchOnlineSubtitles(
  query: OnlineSubtitleQuery,
  signal?: AbortSignal,
): Promise<OnlineSubtitleResult[]> {
  if (signal?.aborted) return [];

  const preferredLangs = (query.languages ?? [])
    .map((l) => normalizeLangCode(l))
    .filter((l) => l && l !== "und");
  const hiFilter: SubHIFilter = query.preferHearingImpaired ?? "any";
  const cacheKey = buildCacheKey(query, preferredLangs, hiFilter);

  const now = Date.now();
  const cached = searchCache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    // Refresh LRU position
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, cached);
    return cached.results.map((r) => ({ ...r }));
  }

  const settled = await Promise.allSettled([
    queryWyzie(query, signal),
    queryOpenSubtitles(query, signal),
  ]);

  if (signal?.aborted) return [];

  let anySucceeded = false;
  const raw: RawOnlineSub[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value.ok) {
      anySucceeded = true;
      raw.push(...outcome.value.items);
    }
  }

  const scored: OnlineSubtitleResult[] = raw.map((item) => ({
    ...item,
    score: scoreOnlineSub(item, preferredLangs, hiFilter),
  }));

  const deduped = deduplicateResults(scored).sort(
    (a, b) => b.score - a.score || (b.downloads ?? 0) - (a.downloads ?? 0) || a.id.localeCompare(b.id),
  );

  if (anySucceeded) {
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, { at: now, results: deduped });
    while (searchCache.size > CACHE_MAX) {
      const oldest = searchCache.keys().next();
      if (oldest.done) break;
      searchCache.delete(oldest.value);
    }
  }

  return deduped.map((r) => ({ ...r }));
}

function isWebviewLocalOrProxyUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^(?:blob:|data:|asset:|abxs:|file:|\/)/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return host === "abxs.localhost" || host === "asset.localhost";
  } catch {
    return true;
  }
}

function inferFormatHintFromUrl(url: string, explicitHint?: string): string | undefined {
  if (explicitHint) return explicitHint;
  const unwrapped = unwrapProxyUrl(url).url;
  const path = unwrapped.split(/[?#]/)[0].toLowerCase();
  const m = path.match(/\.(vtt|srt|ass|ssa)$/);
  return m?.[1];
}

export interface FetchedSubtitle extends ParsedSubtitles {
  raw: string;
}

/**
 * Fetch and parse a subtitle from remote HTTP/HTTPS (via `httpFetch`) or local/blob/asset/abxs URLs.
 */
export async function fetchAndParseSubtitle(
  url: string,
  opts?: { formatHint?: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<FetchedSubtitle> {
  if (opts?.signal?.aborted) throw abortError();
  const hint = inferFormatHintFromUrl(url, opts?.formatHint);

  let text: string;
  if (isWebviewLocalOrProxyUrl(url)) {
    const res = await fetch(url, { headers: opts?.headers, signal: opts?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = decodeSubtitle(await res.arrayBuffer());
  } else {
    const res = await withTimeoutAndAbort(
      httpFetchBytes(url, opts?.headers, { signal: opts?.signal }),
      FETCH_TIMEOUT_MS,
      opts?.signal,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    text = decodeSubtitle(res.bytes);
  }
  return { ...parseSubtitles(text, hint), raw: text };
}
