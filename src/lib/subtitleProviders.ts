/**
 * Online subtitle discovery & downloading across Wyzie Subs, OpenSubtitles v3 (Stremio API,
 * including local-file OSHash matching), and SubDL (with optional API key + ZIP extraction).
 * Uses `httpFetch` / `httpFetchBytes` from `../sources/native` to bypass webview CORS on desktop,
 * with timeout, AbortSignal cancellation, LRU caching, language normalization, scoring, and dedup.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { DEFAULT_UA, httpFetch, httpFetchBytes, unwrapProxyUrl } from "../sources/native";
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
  /** Absolute local file path for computing OpenSubtitles 64-bit OSHash on desktop. */
  localPath?: string;
  /** Precomputed 16-char lowercase hex OpenSubtitles hash. */
  oshash?: string;
  /** Exact local video file size in bytes (paired with `oshash` for Stremio OpenSubtitles v3). */
  fileSize?: number;
  /** Optional filename hint (auto-derived from `localPath` if omitted). */
  filename?: string;
  /** Optional SubDL API key; overrides stored/env settings when provided. */
  subdlApiKey?: string;
}

export interface OnlineSubtitleResult {
  id: string;
  provider: "wyzie" | "opensubtitles" | "subdl";
  lang: string;
  langName: string;
  release: string;
  format: "srt" | "vtt" | "ass" | "ssa";
  url: string;
  hearingImpaired: boolean;
  forced: boolean;
  downloads?: number;
  hashMatched?: boolean;
  score: number;
}

const PROVIDER_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 50;
const WYZIE_HOSTS = ["https://sub.wyzie.io", "https://sub.wyzie.ru"] as const;
const SUBDL_API_URL = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DL_BASE = "https://dl.subdl.com";

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

function basenameFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const clean = path.trim().split(/[\\/]/).pop()?.trim();
  return clean || undefined;
}

function normalizeOshash(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(trimmed) ? trimmed : undefined;
}

async function resolveOshash(query: OnlineSubtitleQuery): Promise<string | undefined> {
  const explicit = normalizeOshash(query.oshash);
  if (explicit) return explicit;
  if (!query.localPath || !isTauri()) return undefined;
  try {
    const hash = await invoke<string>("compute_oshash", { path: query.localPath });
    return normalizeOshash(hash);
  } catch {
    return undefined;
  }
}

function resolveSubdlApiKey(query: OnlineSubtitleQuery): string | undefined {
  const direct = query.subdlApiKey?.trim();
  if (direct) return direct;
  try {
    const storedKey = globalThis.localStorage?.getItem("abx.subdl.apiKey")?.trim();
    if (storedKey) return storedKey;
    const rawSettings = globalThis.localStorage?.getItem("abx.settings.v1");
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings) as { subdlApiKey?: unknown };
      if (typeof parsed?.subdlApiKey === "string" && parsed.subdlApiKey.trim()) {
        return parsed.subdlApiKey.trim();
      }
    }
  } catch {
    /* ignore storage errors */
  }
  const envKey = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SUBDL_API_KEY?.trim();
  return envKey || undefined;
}

interface RawOnlineSub {
  id: string;
  provider: "wyzie" | "opensubtitles" | "subdl";
  lang: string;
  langName: string;
  release: string;
  format: "srt" | "vtt" | "ass" | "ssa";
  url: string;
  hearingImpaired: boolean;
  forced: boolean;
  downloads?: number;
  hashMatched?: boolean;
}

function parseWyzieItems(parsed: unknown[]): RawOnlineSub[] {
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
  return items;
}

interface ProviderOutcome {
  ok: boolean;
  queried: boolean;
  items: RawOnlineSub[];
}

async function queryWyzie(query: OnlineSubtitleQuery, signal?: AbortSignal): Promise<ProviderOutcome> {
  const imdb = normalizeImdbId(query.imdbId);
  const idParam = query.tmdbId != null && Number.isFinite(query.tmdbId) && query.tmdbId > 0 ? String(query.tmdbId) : imdb;
  if (!idParam) return { ok: true, queried: false, items: [] };

  const params = new URLSearchParams({ id: idParam });
  if (query.season != null && query.episode != null) {
    params.set("season", String(query.season));
    params.set("episode", String(query.episode));
  }
  const qs = params.toString();

  for (const host of WYZIE_HOSTS) {
    if (signal?.aborted) throw abortError();
    try {
      const url = `${host}/search?${qs}`;
      const res = await withTimeoutAndAbort(
        httpFetch(url, { Accept: "application/json", "User-Agent": DEFAULT_UA }),
        PROVIDER_TIMEOUT_MS,
        signal,
      );
      if (res.status < 200 || res.status >= 300) continue;
      const parsed = JSON.parse(res.body) as unknown;
      if (!Array.isArray(parsed)) continue;
      return { ok: true, queried: true, items: parseWyzieItems(parsed) };
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
    }
  }
  return { ok: false, queried: true, items: [] };
}

async function queryOpenSubtitles(
  query: OnlineSubtitleQuery,
  oshash: string | undefined,
  signal?: AbortSignal,
): Promise<ProviderOutcome> {
  const imdb = normalizeImdbId(query.imdbId);
  if (!imdb && !oshash) return { ok: true, queried: false, items: [] };

  const isEpisodic = query.kind === "tv" || query.season != null || query.episode != null;
  if (isEpisodic && query.episode == null && !oshash) return { ok: true, queried: false, items: [] };

  const idForPath = imdb ?? "tt0000000";
  const targetBase =
    isEpisodic && query.episode != null
      ? `series/${encodeURIComponent(idForPath)}:${query.season ?? 1}:${query.episode}`
      : `movie/${encodeURIComponent(idForPath)}`;

  const extraParts: string[] = [];
  if (oshash) extraParts.push(`videoHash=${encodeURIComponent(oshash)}`);
  if (query.fileSize != null && Number.isFinite(query.fileSize) && query.fileSize > 0) {
    extraParts.push(`videoSize=${Math.floor(query.fileSize)}`);
  }
  const filename = query.filename?.trim() || basenameFromPath(query.localPath);
  if (filename && oshash) {
    extraParts.push(`filename=${encodeURIComponent(filename)}`);
  }
  const extraSegment = extraParts.length ? `/${extraParts.join("&")}` : "";
  const url = `https://opensubtitles-v3.strem.io/subtitles/${targetBase}${extraSegment}.json`;

  const res = await withTimeoutAndAbort(
    httpFetch(url, { Accept: "application/json", "User-Agent": DEFAULT_UA }),
    PROVIDER_TIMEOUT_MS,
    signal,
  );
  if (res.status < 200 || res.status >= 300) return { ok: false, queried: true, items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { ok: false, queried: true, items: [] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { subtitles?: unknown }).subtitles)) {
    return { ok: false, queried: true, items: [] };
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
      (typeof rec.subtitleFileName === "string" && rec.subtitleFileName.trim()) ||
      (typeof rec.SubFileName === "string" && rec.SubFileName.trim()) ||
      (typeof rec.release === "string" && rec.release.trim()) ||
      (typeof rec.movieReleaseName === "string" && rec.movieReleaseName.trim()) ||
      (typeof rec.title === "string" && rec.title.trim()) ||
      (typeof rec.name === "string" && rec.name.trim()) ||
      "OpenSubtitles";
    const format = inferOnlineFormat(rec.format, rec.url, releaseRaw);
    const downloads =
      typeof rec.downloads === "number" && Number.isFinite(rec.downloads) ? rec.downloads : undefined;
    const hearingImpaired = Boolean(rec.hearingImpaired ?? rec.hi) || /\b(sdh|cc|hi)\b/i.test(releaseRaw);
    const forced = Boolean(rec.forced) || /\bforced\b/i.test(releaseRaw);
    const hashMatched = rec.m === "h" || rec.matchedBy === "moviehash";

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
      ...(hashMatched ? { hashMatched: true } : {}),
    });
  }
  return { ok: true, queried: true, items };
}

function resolveSubdlDownloadUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `${SUBDL_DL_BASE}${trimmed}`;
  return `${SUBDL_DL_BASE}/${trimmed}`;
}

function pickSubdlUnpackEntry(
  unpackFiles: unknown,
  episode?: number,
  season?: number,
): { url: string; name?: string; format?: string } | null {
  if (!Array.isArray(unpackFiles) || unpackFiles.length === 0) return null;
  const entries = unpackFiles
    .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === "object"))
    .map((f) => ({
      url: resolveSubdlDownloadUrl(f.url),
      name: typeof f.name === "string" ? f.name : typeof f.release_name === "string" ? f.release_name : undefined,
      format: typeof f.format === "string" ? f.format : undefined,
      season: typeof f.season === "number" ? f.season : undefined,
      episode: typeof f.episode === "number" ? f.episode : undefined,
    }))
    .filter((e): e is typeof e & { url: string } => Boolean(e.url));

  if (!entries.length) return null;
  if (episode != null) {
    const exactEp = entries.find(
      (e) => e.episode === episode && (season == null || e.season == null || e.season === season),
    );
    if (exactEp) return exactEp;
  }
  return entries[0];
}

async function querySubDL(query: OnlineSubtitleQuery, signal?: AbortSignal): Promise<ProviderOutcome> {
  const apiKey = resolveSubdlApiKey(query);
  if (!apiKey) return { ok: true, queried: false, items: [] };

  const imdb = normalizeImdbId(query.imdbId);
  const tmdb = query.tmdbId != null && Number.isFinite(query.tmdbId) && query.tmdbId > 0 ? String(query.tmdbId) : undefined;
  const title = query.title?.trim() || undefined;
  const fileName = query.filename?.trim() || basenameFromPath(query.localPath);
  if (!imdb && !tmdb && !title && !fileName) return { ok: true, queried: false, items: [] };

  const params = new URLSearchParams({ api_key: apiKey, unpack: "1" });
  if (imdb) params.set("imdb_id", imdb);
  else if (tmdb) params.set("tmdb_id", tmdb);
  else if (title) params.set("film_name", title);
  if (fileName) params.set("file_name", fileName);
  if (query.year != null && Number.isFinite(query.year)) params.set("year", String(query.year));

  const isEpisodic = query.kind === "tv" || query.season != null || query.episode != null;
  if (isEpisodic) {
    params.set("type", "tv");
    if (query.season != null) params.set("season_number", String(query.season));
    if (query.episode != null) params.set("episode_number", String(query.episode));
  } else if (query.kind === "movie") {
    params.set("type", "movie");
  }

  if (query.languages?.length) {
    const langs = query.languages
      .map((l) => langBase(normalizeLangCode(l)).toUpperCase())
      .filter((l) => l && l !== "UND");
    if (langs.length) params.set("languages", [...new Set(langs)].join(","));
  }
  if (query.preferHearingImpaired === "prefer") params.set("hi", "1");
  else if (query.preferHearingImpaired === "avoid") params.set("hi", "0");

  const url = `${SUBDL_API_URL}?${params.toString()}`;
  const res = await withTimeoutAndAbort(
    httpFetch(url, { Accept: "application/json", "User-Agent": DEFAULT_UA }),
    PROVIDER_TIMEOUT_MS,
    signal,
  );
  if (res.status < 200 || res.status >= 300) return { ok: false, queried: true, items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { ok: false, queried: true, items: [] };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, queried: true, items: [] };
  const payload = parsed as { status?: unknown; subtitles?: unknown };
  if (payload.status === false || !Array.isArray(payload.subtitles)) {
    return { ok: false, queried: true, items: [] };
  }

  const items: RawOnlineSub[] = [];
  for (let i = 0; i < payload.subtitles.length; i++) {
    const row = payload.subtitles[i];
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;

    const unpacked = pickSubdlUnpackEntry(rec.unpack_files, query.episode, query.season);
    const dlUrl = unpacked?.url ?? resolveSubdlDownloadUrl(rec.url_download) ?? resolveSubdlDownloadUrl(rec.url);
    if (!dlUrl || !isValidHttpUrl(dlUrl)) continue;

    const lang = normalizeLangCode(
      typeof rec.language === "string"
        ? rec.language
        : typeof rec.lang === "string"
          ? rec.lang
          : undefined,
    );
    const releaseRaw =
      unpacked?.name?.trim() ||
      (typeof rec.release_name === "string" && rec.release_name.trim()) ||
      (typeof rec.name === "string" && rec.name.trim()) ||
      (typeof rec.display_name === "string" && rec.display_name.trim()) ||
      "SubDL";
    const format = inferOnlineFormat(unpacked?.format ?? rec.fmt ?? rec.format, dlUrl, releaseRaw);
    const downloads =
      typeof rec.download_count === "number" && Number.isFinite(rec.download_count)
        ? rec.download_count
        : typeof rec.downloads === "number" && Number.isFinite(rec.downloads)
          ? rec.downloads
          : undefined;
    const hearingImpaired = Boolean(rec.hi ?? rec.hearingImpaired) || /\b(sdh|cc|hi)\b/i.test(releaseRaw);
    const forced = Boolean(rec.forced) || /\bforced\b/i.test(releaseRaw);

    items.push({
      id: `subdl-${typeof rec.subtitle_id === "string" || typeof rec.subtitle_id === "number" ? String(rec.subtitle_id) : i}`,
      provider: "subdl",
      lang,
      langName: langLabel(lang),
      release: releaseRaw,
      format,
      url: dlUrl,
      hearingImpaired,
      forced,
      ...(downloads !== undefined ? { downloads } : {}),
    });
  }
  return { ok: true, queried: true, items };
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

  if (item.hashMatched) score += 250;

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
  const genericReleases = new Set(["wyzie", "opensubtitles", "subdl", "subtitles", "subtitle"]);
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

function buildCacheKey(
  query: OnlineSubtitleQuery,
  preferredLangs: string[],
  hiFilter: SubHIFilter,
  oshash: string | undefined,
): string {
  return JSON.stringify({
    tmdbId: query.tmdbId ?? null,
    imdbId: normalizeImdbId(query.imdbId) ?? null,
    title: query.title?.trim().toLowerCase() ?? null,
    year: query.year ?? null,
    kind: query.kind ?? null,
    season: query.season ?? null,
    episode: query.episode ?? null,
    oshash: oshash ?? null,
    fileSize: query.fileSize ?? null,
    hasSubdlKey: Boolean(resolveSubdlApiKey(query)),
    languages: preferredLangs,
    hiFilter,
  });
}

/**
 * Search Wyzie Subs, OpenSubtitles v3 (with optional OSHash matching), and SubDL in parallel,
 * score and rank matches, deduplicate cleanly, and never throw on partial provider errors.
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
  const oshash = await resolveOshash(query);
  if (signal?.aborted) return [];

  const cacheKey = buildCacheKey(query, preferredLangs, hiFilter, oshash);

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
    queryOpenSubtitles(query, oshash, signal),
    querySubDL(query, signal),
  ]);

  if (signal?.aborted) return [];

  let anySucceeded = false;
  const raw: RawOnlineSub[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value.ok && outcome.value.queried) {
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

function isZipBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

const SUB_EXT_PRIORITY: Record<string, number> = { ass: 4, ssa: 3, vtt: 2, srt: 1 };

async function extractFirstSubtitleFromZip(
  buf: ArrayBuffer,
): Promise<{ bytes: ArrayBuffer; formatHint?: string } | null> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  // Locate End of Central Directory (PK\x05\x06) scanning backwards up to 65 KiB + 22 bytes.
  let eocdOffset = -1;
  const minStart = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset >= bytes.length) return null;

  interface ZipEntry {
    name: string;
    ext: string;
    method: number;
    compressedSize: number;
    localHeaderOffset: number;
  }
  const candidates: ZipEntry[] = [];
  let cursor = cdOffset;
  const td = new TextDecoder("utf-8", { fatal: false });

  for (let n = 0; n < totalEntries && cursor + 46 <= bytes.length; n++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    if (cursor + 46 + nameLen > bytes.length) break;
    const name = td.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || name.includes("__MACOSX/")) continue;
    const extMatch = name.toLowerCase().match(/\.(srt|vtt|ass|ssa)$/);
    if (!extMatch) continue;
    if (method !== 0 && method !== 8) continue;
    candidates.push({ name, ext: extMatch[1], method, compressedSize, localHeaderOffset });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (SUB_EXT_PRIORITY[b.ext] ?? 0) - (SUB_EXT_PRIORITY[a.ext] ?? 0));
  const best = candidates[0];

  const lh = best.localHeaderOffset;
  if (lh + 30 > bytes.length || view.getUint32(lh, true) !== 0x04034b50) return null;
  const lhNameLen = view.getUint16(lh + 26, true);
  const lhExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const dataEnd = dataStart + best.compressedSize;
  if (dataEnd > bytes.length) return null;

  const compressed = bytes.slice(dataStart, dataEnd);
  if (best.method === 0) {
    return { bytes: compressed.buffer, formatHint: best.ext };
  }
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const decompressed = await new Response(stream).arrayBuffer();
  return { bytes: decompressed, formatHint: best.ext };
}

export interface FetchedSubtitle extends ParsedSubtitles {
  raw: string;
}

/**
 * Fetch and parse a subtitle from remote HTTP/HTTPS (via `httpFetchBytes`) or local/blob/asset/abxs URLs.
 * Automatically extracts `.srt`/`.vtt`/`.ass`/`.ssa` payloads from `.zip` archives (e.g., SubDL).
 */
export async function fetchAndParseSubtitle(
  url: string,
  opts?: { formatHint?: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<FetchedSubtitle> {
  if (opts?.signal?.aborted) throw abortError();
  let hint = inferFormatHintFromUrl(url, opts?.formatHint);

  let rawBytes: ArrayBuffer;
  if (isWebviewLocalOrProxyUrl(url)) {
    const res = await fetch(url, { headers: opts?.headers, signal: opts?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rawBytes = await res.arrayBuffer();
  } else {
    const res = await withTimeoutAndAbort(
      httpFetchBytes(url, opts?.headers, { signal: opts?.signal }),
      FETCH_TIMEOUT_MS,
      opts?.signal,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    rawBytes = res.bytes;
  }

  if (isZipBuffer(rawBytes)) {
    const extracted = await extractFirstSubtitleFromZip(rawBytes);
    if (!extracted) throw new Error("ZIP archive contained no supported subtitle file");
    rawBytes = extracted.bytes;
    if (extracted.formatHint) hint = extracted.formatHint;
  }

  const text = decodeSubtitle(rawBytes);
  return { ...parseSubtitles(text, hint), raw: text };
}
