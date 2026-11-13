/**
 * Universal Intro / Outro / Recap skip segment lookup:
 * - AniSkip v2 (`https://api.aniskip.com/v2/skip-times/{malId}/{ep}`) for anime
 * - TheIntroDB v4 (`https://api.theintrodb.org/v4/media`) for movies, TV, dramas, Jellyfin, and local files
 *
 * Includes in-memory LRU+TTL caching, short timeouts, AbortSignal support, and graceful fallback.
 */

import { httpFetch, native } from "../sources/native";

export type SkipRange = [number, number];

export interface SkipSegments {
  intro?: SkipRange;
  outro?: SkipRange;
  recap?: SkipRange;
  preview?: SkipRange;
  source?: "aniskip" | "theintrodb" | "mixed";
}

export interface SkipSegmentsQuery {
  kind?: "movie" | "tv" | "anime" | string;
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  malId?: number;
  season?: number;
  episode?: number;
  /** Optional media duration in seconds (used for release-version matching & AniSkip episodeLength). */
  durationSec?: number;
}

export interface FetchSkipOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const THEINTRODB_MEDIA_URL = "https://api.theintrodb.org/v4/media";
const ANISKIP_BASE_URL = "https://api.aniskip.com/v2/skip-times";
const DEFAULT_TIMEOUT_MS = 4_500;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 200;

interface CacheEntry {
  at: number;
  data: SkipSegments;
}

const skipCache = new Map<string, CacheEntry>();

export function clearSkipSegmentsCache(): void {
  skipCache.clear();
}

function abortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function isValidRange(r?: SkipRange | null, allowInfiniteEnd = false): r is SkipRange {
  if (!r || r.length !== 2) return false;
  const [start, end] = r;
  if (!Number.isFinite(start) || start < 0) return false;
  if (end === Number.POSITIVE_INFINITY) return allowInfiniteEnd;
  return Number.isFinite(end) && end > start;
}

function sanitizeSkip(seg?: SkipSegments | null): SkipSegments {
  if (!seg) return {};
  const out: SkipSegments = {};
  if (isValidRange(seg.intro)) out.intro = [seg.intro[0], seg.intro[1]];
  if (isValidRange(seg.outro, true)) out.outro = [seg.outro[0], seg.outro[1]];
  if (isValidRange(seg.recap)) out.recap = [seg.recap[0], seg.recap[1]];
  if (isValidRange(seg.preview)) out.preview = [seg.preview[0], seg.preview[1]];
  if (seg.source && (out.intro || out.outro || out.recap || out.preview)) {
    out.source = seg.source;
  }
  return out;
}

/**
 * Merge candidate-provided skip ranges with externally fetched skip segments.
 * Candidate-provided ranges always take priority when valid.
 */
export function mergeSkipRanges(
  existing?: { intro?: SkipRange; outro?: SkipRange } | null,
  fetched?: SkipSegments | null,
): { intro?: SkipRange; outro?: SkipRange } | undefined {
  const intro = isValidRange(existing?.intro)
    ? existing!.intro
    : isValidRange(fetched?.intro)
      ? fetched!.intro
      : undefined;
  const outro = isValidRange(existing?.outro, true)
    ? existing!.outro
    : isValidRange(fetched?.outro, true)
      ? fetched!.outro
      : undefined;
  if (!intro && !outro) return undefined;
  return {
    ...(intro ? { intro } : {}),
    ...(outro ? { outro } : {}),
  };
}

function buildCacheKey(q: SkipSegmentsQuery): string | null {
  const kind = q.kind || (q.episode != null ? "tv" : "movie");
  const tvdb = toPositiveInt(q.tvdbId);
  const tmdb = toPositiveInt(q.tmdbId);
  const imdb = normalizeImdbId(q.imdbId);
  const mal = toPositiveInt(q.malId);
  const season = toNonNegInt(q.season);
  const episode = toNonNegInt(q.episode);
  if (!tvdb && !tmdb && !imdb && !mal) return null;
  return [
    kind,
    tvdb ?? "",
    tmdb ?? "",
    imdb ?? "",
    mal ?? "",
    season ?? "",
    episode ?? "",
  ].join("|");
}

function toPositiveInt(v?: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
}

function toNonNegInt(v?: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n >= 0 ? n : undefined;
}

function normalizeImdbId(v?: string): string | undefined {
  const s = v?.trim();
  return s && /^tt\d{5,10}$/i.test(s) ? s.toLowerCase() : undefined;
}

function getCached(key: string): SkipSegments | null {
  const entry = skipCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    skipCache.delete(key);
    return null;
  }
  // Refresh LRU position
  skipCache.delete(key);
  skipCache.set(key, entry);
  return entry.data;
}

function setCached(key: string, data: SkipSegments): void {
  if (skipCache.has(key)) skipCache.delete(key);
  while (skipCache.size >= CACHE_MAX) {
    const oldest = skipCache.keys().next().value;
    if (oldest == null) break;
    skipCache.delete(oldest);
  }
  skipCache.set(key, { at: Date.now(), data });
}

interface HttpJsonOutcome<T> {
  ok: boolean;
  status: number;
  data: T | null;
  definiteMiss?: boolean;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpJsonOutcome<T>> {
  if (signal?.aborted) throw abortError();

  if (!native) {
    const ctl = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => ctl.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);

    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: ctl.signal,
      });
      if (res.status === 404) {
        return { ok: false, status: 404, data: null, definiteMiss: true };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, data: null };
      }
      const data = (await res.json()) as T;
      return { ok: true, status: res.status, data };
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (timedOut || isAbortError(err)) {
        return { ok: false, status: 0, data: null };
      }
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  return await new Promise<HttpJsonOutcome<T>>((resolve, reject) => {
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
      resolve({ ok: false, status: 0, data: null });
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    httpFetch(url, { Accept: "application/json" })
      .then((res) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (res.status === 404) {
          resolve({ ok: false, status: 404, data: null, definiteMiss: true });
          return;
        }
        if (res.status < 200 || res.status >= 300) {
          resolve({ ok: false, status: res.status, data: null });
          return;
        }
        try {
          resolve({ ok: true, status: res.status, data: JSON.parse(res.body) as T });
        } catch {
          resolve({ ok: false, status: res.status, data: null });
        }
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted) reject(abortError());
        else resolve({ ok: false, status: 0, data: null });
      });
  });
}

interface TheIntroDbSegment {
  start_ms?: number | null;
  end_ms?: number | null;
}

interface TheIntroDbResponse {
  tvdb_id?: number;
  type?: string;
  intro?: TheIntroDbSegment[];
  credits?: TheIntroDbSegment[];
  recap?: TheIntroDbSegment[];
  preview?: TheIntroDbSegment[];
}

function pickTheIntroDbSegment(
  segments: TheIntroDbSegment[] | undefined,
  allowOpenEnd: boolean,
): SkipRange | undefined {
  if (!Array.isArray(segments)) return undefined;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const startSec = seg.start_ms == null ? 0 : seg.start_ms / 1000;
    if (!Number.isFinite(startSec) || startSec < 0) continue;
    if (seg.end_ms == null) {
      if (allowOpenEnd) return [startSec, Number.POSITIVE_INFINITY];
      continue;
    }
    const endSec = seg.end_ms / 1000;
    if (!Number.isFinite(endSec) || endSec <= startSec) continue;
    return [startSec, endSec];
  }
  return undefined;
}

async function queryTheIntroDb(
  q: SkipSegmentsQuery,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ segments: SkipSegments; cacheable: boolean }> {
  const tvdbId = toPositiveInt(q.tvdbId);
  const tmdbId = toPositiveInt(q.tmdbId);
  const imdbId = normalizeImdbId(q.imdbId);
  if (!tvdbId && !tmdbId && !imdbId) {
    return { segments: {}, cacheable: false };
  }

  const isMovie = q.kind === "movie";
  const season = toNonNegInt(q.season);
  const episode = toNonNegInt(q.episode);
  if (!isMovie && (season == null || episode == null)) {
    // TheIntroDB v4 rejects requests with only one of season/episode or TV metadata without episode coords.
    return { segments: {}, cacheable: false };
  }

  const params = new URLSearchParams();
  if (tvdbId) params.set("tvdb_id", String(tvdbId));
  else if (tmdbId) params.set("tmdb_id", String(tmdbId));
  else if (imdbId) params.set("imdb_id", imdbId);

  if (!isMovie && season != null && episode != null) {
    params.set("season", String(season));
    params.set("episode", String(episode));
  }
  if (typeof q.durationSec === "number" && Number.isFinite(q.durationSec) && q.durationSec > 0) {
    params.set("duration_ms", String(Math.round(q.durationSec * 1000)));
  }

  const url = `${THEINTRODB_MEDIA_URL}?${params.toString()}`;
  const res = await fetchJsonWithTimeout<TheIntroDbResponse>(url, timeoutMs, signal);
  if (res.definiteMiss) return { segments: {}, cacheable: true };
  if (!res.ok || !res.data) return { segments: {}, cacheable: false };

  const intro = pickTheIntroDbSegment(res.data.intro, false);
  const outro = pickTheIntroDbSegment(res.data.credits, true);
  const recap = pickTheIntroDbSegment(res.data.recap, false);
  const preview = pickTheIntroDbSegment(res.data.preview, false);

  const segments = sanitizeSkip({
    intro,
    outro,
    recap,
    preview,
    source: "theintrodb",
  });
  return { segments, cacheable: true };
}

interface AniSkipResult {
  skipType?: string;
  interval?: {
    startTime?: number;
    endTime?: number;
  };
}

interface AniSkipResponse {
  found?: boolean;
  results?: AniSkipResult[];
}

async function queryAniSkip(
  q: SkipSegmentsQuery,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ segments: SkipSegments; cacheable: boolean }> {
  const malId = toPositiveInt(q.malId);
  const ep = toPositiveInt(q.episode);
  if (!malId || !ep) {
    return { segments: {}, cacheable: false };
  }

  const epLen =
    typeof q.durationSec === "number" && Number.isFinite(q.durationSec) && q.durationSec > 0
      ? Math.round(q.durationSec)
      : 0;
  const url = `${ANISKIP_BASE_URL}/${malId}/${ep}?types[]=op&types[]=ed&types[]=recap&episodeLength=${epLen}`;

  const res = await fetchJsonWithTimeout<AniSkipResponse>(url, timeoutMs, signal);
  if (res.definiteMiss) return { segments: {}, cacheable: true };
  if (!res.ok || !res.data) return { segments: {}, cacheable: false };
  if (!res.data.found || !Array.isArray(res.data.results)) {
    return { segments: {}, cacheable: true };
  }

  let intro: SkipRange | undefined;
  let outro: SkipRange | undefined;
  let recap: SkipRange | undefined;

  for (const item of res.data.results) {
    const start = item?.interval?.startTime;
    const end = item?.interval?.endTime;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    if (item.skipType === "op" && !intro) intro = [start, end];
    else if (item.skipType === "ed" && !outro) outro = [start, end];
    else if (item.skipType === "recap" && !recap) recap = [start, end];
  }

  const segments = sanitizeSkip({
    intro,
    outro,
    recap,
    source: "aniskip",
  });
  return { segments, cacheable: true };
}

/**
 * Fetch skip timestamps (intro / outro / recap / preview) from AniSkip v2 and/or TheIntroDB v4.
 * Never throws on network or HTTP errors (returns `{}`); throws `AbortError` only when `signal` aborts.
 */
export async function fetchSkipSegments(
  query: SkipSegmentsQuery,
  opts: FetchSkipOptions = {},
): Promise<SkipSegments> {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (signal?.aborted) throw abortError();

  const cacheKey = buildCacheKey(query);
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const hasMal = toPositiveInt(query.malId) != null && toPositiveInt(query.episode) != null;
  const hasIntroDbIds =
    toPositiveInt(query.tvdbId) != null ||
    toPositiveInt(query.tmdbId) != null ||
    normalizeImdbId(query.imdbId) != null;
  const canQueryIntroDb =
    hasIntroDbIds &&
    (query.kind === "movie" || (toNonNegInt(query.season) != null && toNonNegInt(query.episode) != null));

  let combined: SkipSegments = {};
  let cacheable = false;

  if (query.kind === "anime" || (hasMal && !canQueryIntroDb)) {
    if (hasMal) {
      const ani = await queryAniSkip(query, timeoutMs, signal);
      combined = ani.segments;
      cacheable = ani.cacheable;
    }
    if (canQueryIntroDb && (!combined.intro || !combined.outro)) {
      const tidb = await queryTheIntroDb(query, timeoutMs, signal);
      const intro = combined.intro ?? tidb.segments.intro;
      const outro = combined.outro ?? tidb.segments.outro;
      const recap = combined.recap ?? tidb.segments.recap;
      const preview = combined.preview ?? tidb.segments.preview;
      const fromAni = Boolean(combined.intro || combined.outro || combined.recap);
      const fromTidb = Boolean(tidb.segments.intro || tidb.segments.outro || tidb.segments.recap || tidb.segments.preview);
      combined = sanitizeSkip({
        intro,
        outro,
        recap,
        preview,
        source: fromAni && fromTidb ? "mixed" : fromAni ? "aniskip" : fromTidb ? "theintrodb" : undefined,
      });
      cacheable = cacheable && tidb.cacheable;
    }
  } else if (canQueryIntroDb) {
    const tidb = await queryTheIntroDb(query, timeoutMs, signal);
    combined = tidb.segments;
    cacheable = tidb.cacheable;
    if (hasMal && (!combined.intro || !combined.outro)) {
      const ani = await queryAniSkip(query, timeoutMs, signal);
      const intro = combined.intro ?? ani.segments.intro;
      const outro = combined.outro ?? ani.segments.outro;
      const recap = combined.recap ?? ani.segments.recap;
      const fromTidb = Boolean(combined.intro || combined.outro || combined.recap || combined.preview);
      const fromAni = Boolean(ani.segments.intro || ani.segments.outro || ani.segments.recap);
      combined = sanitizeSkip({
        intro,
        outro,
        recap,
        preview: combined.preview,
        source: fromAni && fromTidb ? "mixed" : fromTidb ? "theintrodb" : fromAni ? "aniskip" : undefined,
      });
      cacheable = cacheable && ani.cacheable;
    }
  }

  if (cacheKey && (cacheable || combined.intro || combined.outro || combined.recap || combined.preview)) {
    setCached(cacheKey, combined);
  }
  return combined;
}
