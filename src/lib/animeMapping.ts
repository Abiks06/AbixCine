import { httpFetch, native } from "../sources/native";
import type { MediaKind, PlaybackRequest, SeasonCour } from "./types";

export const FRIBB_MINI_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
export const ANIBRIDGE_MAPPINGS_URL =
  "https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json";

const STORAGE_FRIBB_KEY = "abx.animeMapping.fribb.v1";
const STORAGE_ANIBRIDGE_KEY = "abx.animeMapping.anibridge.v1";
const DEFAULT_TTL_MS = 7 * 24 * 3600_000;
const FETCH_TIMEOUT_MS = 10_000;
const FAILURE_BACKOFF_MS = 60_000;

/** Raw entry shape from `Fribb/anime-lists` (`anime-list-mini.json`). */
export interface RawFribbEntry {
  type?: string;
  anilist_id?: number;
  mal_id?: number;
  imdb_id?: string | string[];
  themoviedb_id?:
    | number
    | {
        tv?: number | number[];
        movie?: number | number[];
      };
  season?: {
    tmdb?: number;
    tvdb?: number;
  };
  episode_offset?: {
    tmdb?: number;
    tvdb?: number;
  };
}

/** Raw JSON schema for `anibridge/anibridge-mappings` (`mappings.min.json`). */
export type RawAnibridgeMappings = Record<string, Record<string, Record<string, string | null>> | unknown>;

/** Compact tuple stored in localStorage for Fribb entries: [anilistId, malId, tmdbSignedId, tmdbSeason, tmdbOffset, imdbId?]. */
type CompactFribbRow = [number, number, number, number, number, string?];

interface CompactFribbPayload {
  at: number;
  rows: CompactFribbRow[];
}

/** Compact Anibridge record stored in localStorage: filtered to TMDB/AniList/MAL/IMDB descriptors only. */
type CompactAnibridgeData = Record<string, Record<string, Record<string, string | null>>>;

interface CompactAnibridgePayload {
  at: number;
  data: CompactAnibridgeData;
}

export interface FribbRecord {
  anilistId?: number;
  malId?: number;
  tmdbId?: number;
  tmdbKind?: "tv" | "movie";
  tmdbSeason?: number;
  tmdbOffset: number;
  imdbId?: string;
}

interface RangeSegment {
  start: number;
  end: number; // Infinity when open-ended
}

interface ParsedTargetRange {
  segments: RangeSegment[];
  ratio: number;
}

interface AnibridgeTargetEntry {
  provider: "anilist" | "mal" | "tmdb_show" | "tmdb_movie" | "imdb_movie" | "imdb_show";
  id: string;
  season?: number;
  ranges: Record<string, string | null>;
}

interface AnibridgeLinkEntry {
  anilistIds: number[];
  malIds: number[];
  imdbIds: string[];
  tmdb: { id: number; kind: "tv" | "movie"; season?: number }[];
}

interface MappingIndex {
  fribbLoadedAt: number;
  anibridgeLoadedAt: number;
  // Fribb lookup maps
  fribbByTmdbTvSeason: Map<string, FribbRecord[]>; // `${tmdbId}:${season}` (or `${tmdbId}:*`)
  fribbByTmdbMovie: Map<number, FribbRecord[]>;
  fribbByAnilist: Map<number, FribbRecord>;
  fribbByMal: Map<number, FribbRecord>;
  fribbByImdb: Map<string, FribbRecord[]>;
  // Anibridge lookup maps
  abBySource: Map<string, AnibridgeTargetEntry[]>;
  abByAnilist: Map<number, AnibridgeLinkEntry>;
  abByMal: Map<number, AnibridgeLinkEntry>;
  abByImdb: Map<string, AnibridgeLinkEntry>;
}

export interface AnimeMappingQuery {
  tmdbId?: number;
  anilistId?: number;
  malId?: number;
  imdbId?: string;
  key?: string;
  kind?: MediaKind;
  season?: number;
  episode?: number;
}

export type AnimeMappingInput = AnimeMappingQuery | PlaybackRequest;

export interface ResolvedAnimeIds {
  malId?: number;
  anilistId?: number;
  tmdbId?: number;
  tmdbKind?: "tv" | "movie";
  imdbId?: string;
  courEpisode?: number;
  tmdbSeason?: number;
  source?: "request" | "anibridge" | "fribb";
}

export interface CourEpisodeMappingResult {
  malId?: number;
  anilistId?: number;
  tmdbId?: number;
  tmdbKind?: "tv" | "movie";
  imdbId?: string;
  season: number;
  episode: number;
  courEpisode: number;
  source?: "anibridge" | "fribb";
}

function createEmptyIndex(): MappingIndex {
  return {
    fribbLoadedAt: 0,
    anibridgeLoadedAt: 0,
    fribbByTmdbTvSeason: new Map(),
    fribbByTmdbMovie: new Map(),
    fribbByAnilist: new Map(),
    fribbByMal: new Map(),
    fribbByImdb: new Map(),
    abBySource: new Map(),
    abByAnilist: new Map(),
    abByMal: new Map(),
    abByImdb: new Map(),
  };
}

let memIndex: MappingIndex | null = null;
let inflightLoad: Promise<MappingIndex> | null = null;
let fribbFailedAt = 0;
let anibridgeFailedAt = 0;

function toPositiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function toNonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function toNumList(v: unknown): number[] {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return [v];
  if (Array.isArray(v)) {
    return v.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0);
  }
  return [];
}

function toImdbList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => /^tt\d+$/i.test(x));
}

function parseDescriptor(desc: string): {
  provider: AnibridgeTargetEntry["provider"];
  id: string;
  season?: number;
} | null {
  const parts = desc.split(":");
  if (parts.length < 2) return null;
  const [prov, id, scope] = parts;
  if (!id) return null;
  if (prov === "anilist" || prov === "mal" || prov === "tmdb_movie" || prov === "imdb_movie") {
    return { provider: prov, id };
  }
  if (prov === "tmdb_show" || prov === "imdb_show") {
    const m = scope?.match(/^s(\d+)$/i);
    if (!m) return null;
    return { provider: prov, id, season: Number(m[1]) };
  }
  return null;
}

/** Compact raw Fribb entries into minimal rows suitable for localStorage caching. */
export function compactFribbEntries(entries: RawFribbEntry[]): CompactFribbRow[] {
  const rows: CompactFribbRow[] = [];
  if (!Array.isArray(entries)) return rows;

  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const al = toPositiveInt(e.anilist_id) ?? 0;
    const mal = toPositiveInt(e.mal_id) ?? 0;
    if (!al && !mal) continue;

    let tvs: number[] = [];
    let movies: number[] = [];
    if (typeof e.themoviedb_id === "number") {
      if (e.type === "MOVIE") movies = toNumList(e.themoviedb_id);
      else tvs = toNumList(e.themoviedb_id);
    } else if (e.themoviedb_id && typeof e.themoviedb_id === "object") {
      tvs = toNumList(e.themoviedb_id.tv);
      movies = toNumList(e.themoviedb_id.movie);
    }

    const tmdbSeason = toNonNegInt(e.season?.tmdb) ?? -1;
    const tmdbOffset = toNonNegInt(e.episode_offset?.tmdb) ?? 0;
    const imdbs = toImdbList(e.imdb_id);
    const imdb = imdbs[0];

    if (tvs.length === 0 && movies.length === 0) {
      if (imdb) rows.push([al, mal, 0, tmdbSeason, tmdbOffset, imdb]);
      else if (al && mal) rows.push([al, mal, 0, -1, 0]);
      continue;
    }

    for (const tvId of tvs) {
      const row: CompactFribbRow = [al, mal, tvId, tmdbSeason, tmdbOffset];
      if (imdb) row.push(imdb);
      rows.push(row);
    }
    for (const mvId of movies) {
      const row: CompactFribbRow = [al, mal, -mvId, -1, tmdbOffset];
      if (imdb) row.push(imdb);
      rows.push(row);
    }
  }
  return rows;
}

/** Filter raw anibridge mappings to only TMDB/AniList/MAL/IMDB cross-links. */
export function compactAnibridgeMappings(raw: RawAnibridgeMappings): CompactAnibridgeData {
  const out: CompactAnibridgeData = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [srcKey, targets] of Object.entries(raw)) {
    if (srcKey.startsWith("$") || !targets || typeof targets !== "object" || Array.isArray(targets)) continue;
    const srcParsed = parseDescriptor(srcKey);
    if (!srcParsed) continue;

    const keptTargets: Record<string, Record<string, string | null>> = {};
    let hasAny = false;
    for (const [tgtKey, rangeMap] of Object.entries(targets as Record<string, unknown>)) {
      const tgtParsed = parseDescriptor(tgtKey);
      if (!tgtParsed || !rangeMap || typeof rangeMap !== "object" || Array.isArray(rangeMap)) continue;
      keptTargets[tgtKey] = rangeMap as Record<string, string | null>;
      hasAny = true;
    }
    if (hasAny) {
      out[srcKey] = keptTargets;
    }
  }
  return out;
}

function addFribbRowsToIndex(idx: MappingIndex, rows: CompactFribbRow[], loadedAt: number): void {
  idx.fribbLoadedAt = loadedAt;
  for (const row of rows) {
    const [al, mal, tmdbSigned, rawSeason, offset, imdb] = row;
    const rec: FribbRecord = {
      anilistId: al > 0 ? al : undefined,
      malId: mal > 0 ? mal : undefined,
      tmdbId: tmdbSigned !== 0 ? Math.abs(tmdbSigned) : undefined,
      tmdbKind: tmdbSigned > 0 ? "tv" : tmdbSigned < 0 ? "movie" : undefined,
      tmdbSeason: rawSeason >= 0 ? rawSeason : undefined,
      tmdbOffset: offset >= 0 ? offset : 0,
      imdbId: imdb || undefined,
    };

    if (rec.anilistId && !idx.fribbByAnilist.has(rec.anilistId)) {
      idx.fribbByAnilist.set(rec.anilistId, rec);
    }
    if (rec.malId && !idx.fribbByMal.has(rec.malId)) {
      idx.fribbByMal.set(rec.malId, rec);
    }
    if (rec.imdbId) {
      const arr = idx.fribbByImdb.get(rec.imdbId) ?? [];
      arr.push(rec);
      idx.fribbByImdb.set(rec.imdbId, arr);
    }
    if (rec.tmdbId && rec.tmdbKind === "movie") {
      const arr = idx.fribbByTmdbMovie.get(rec.tmdbId) ?? [];
      arr.push(rec);
      idx.fribbByTmdbMovie.set(rec.tmdbId, arr);
    } else if (rec.tmdbId && rec.tmdbKind === "tv") {
      const seasonKey = rec.tmdbSeason != null ? `${rec.tmdbId}:${rec.tmdbSeason}` : `${rec.tmdbId}:*`;
      const arr = idx.fribbByTmdbTvSeason.get(seasonKey) ?? [];
      arr.push(rec);
      idx.fribbByTmdbTvSeason.set(seasonKey, arr);
    }
  }

  for (const arr of idx.fribbByTmdbTvSeason.values()) {
    arr.sort((a, b) => a.tmdbOffset - b.tmdbOffset);
  }
}

function ensureReverseLink<K>(map: Map<K, AnibridgeLinkEntry>, key: K): AnibridgeLinkEntry {
  let entry = map.get(key);
  if (!entry) {
    entry = { anilistIds: [], malIds: [], imdbIds: [], tmdb: [] };
    map.set(key, entry);
  }
  return entry;
}

function pushUnique<T>(arr: T[], val: T): void {
  if (!arr.includes(val)) arr.push(val);
}

function addTmdbLink(
  list: { id: number; kind: "tv" | "movie"; season?: number }[],
  item: { id: number; kind: "tv" | "movie"; season?: number },
): void {
  if (!list.some((x) => x.id === item.id && x.kind === item.kind && x.season === item.season)) {
    list.push(item);
  }
}

function recordTargetLink(
  entry: AnibridgeLinkEntry,
  b: NonNullable<ReturnType<typeof parseDescriptor>>,
): void {
  if (b.provider === "anilist" && Number(b.id) > 0) pushUnique(entry.anilistIds, Number(b.id));
  else if (b.provider === "mal" && Number(b.id) > 0) pushUnique(entry.malIds, Number(b.id));
  else if (b.provider === "imdb_movie" || b.provider === "imdb_show") pushUnique(entry.imdbIds, b.id);
  else if (b.provider === "tmdb_show" && Number(b.id) > 0) {
    addTmdbLink(entry.tmdb, { id: Number(b.id), kind: "tv", season: b.season });
  } else if (b.provider === "tmdb_movie" && Number(b.id) > 0) {
    addTmdbLink(entry.tmdb, { id: Number(b.id), kind: "movie" });
  }
}

function addAnibridgeToIndex(idx: MappingIndex, data: CompactAnibridgeData, loadedAt: number): void {
  idx.anibridgeLoadedAt = loadedAt;

  for (const [srcKey, targets] of Object.entries(data)) {
    const src = parseDescriptor(srcKey);
    if (!src) continue;

    const list: AnibridgeTargetEntry[] = idx.abBySource.get(srcKey) ?? [];
    for (const [tgtKey, ranges] of Object.entries(targets)) {
      const tgt = parseDescriptor(tgtKey);
      if (!tgt) continue;
      list.push({ provider: tgt.provider, id: tgt.id, season: tgt.season, ranges });

      // Populate bidirectional ID links
      const linkPair = (
        a: NonNullable<ReturnType<typeof parseDescriptor>>,
        b: NonNullable<ReturnType<typeof parseDescriptor>>,
      ) => {
        if (a.provider === "anilist") {
          const alId = Number(a.id);
          if (Number.isFinite(alId)) recordTargetLink(ensureReverseLink(idx.abByAnilist, alId), b);
        } else if (a.provider === "mal") {
          const malId = Number(a.id);
          if (Number.isFinite(malId)) recordTargetLink(ensureReverseLink(idx.abByMal, malId), b);
        } else if (a.provider === "imdb_movie" || a.provider === "imdb_show") {
          recordTargetLink(ensureReverseLink(idx.abByImdb, a.id), b);
        }
      };

      linkPair(src, tgt);
      linkPair(tgt, src);
    }
    if (list.length > 0) {
      idx.abBySource.set(srcKey, list);
    }
  }
}

function readStorageJson<T>(key: string): T | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeStorageJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // QuotaExceededError or restricted storage: in-memory index remains active.
  }
}

function hydrateIndexFromStorage(ttlMs = DEFAULT_TTL_MS): {
  index: MappingIndex;
  fribbFresh: boolean;
  anibridgeFresh: boolean;
} {
  const now = Date.now();
  const idx = createEmptyIndex();
  const fribb = readStorageJson<CompactFribbPayload>(STORAGE_FRIBB_KEY);
  const anibridge = readStorageJson<CompactAnibridgePayload>(STORAGE_ANIBRIDGE_KEY);

  let fribbFresh = false;
  if (fribb && typeof fribb.at === "number" && Array.isArray(fribb.rows)) {
    addFribbRowsToIndex(idx, fribb.rows, fribb.at);
    fribbFresh = now - fribb.at < ttlMs;
  }

  let anibridgeFresh = false;
  if (anibridge && typeof anibridge.at === "number" && anibridge.data && typeof anibridge.data === "object") {
    addAnibridgeToIndex(idx, anibridge.data, anibridge.at);
    anibridgeFresh = now - anibridge.at < ttlMs;
  }

  return { index: idx, fribbFresh, anibridgeFresh };
}

function getOrHydrateMemIndex(ttlMs = DEFAULT_TTL_MS): {
  index: MappingIndex;
  fribbFresh: boolean;
  anibridgeFresh: boolean;
} {
  const now = Date.now();
  if (memIndex) {
    return {
      index: memIndex,
      fribbFresh: memIndex.fribbLoadedAt > 0 && now - memIndex.fribbLoadedAt < ttlMs,
      anibridgeFresh: memIndex.anibridgeLoadedAt > 0 && now - memIndex.anibridgeLoadedAt < ttlMs,
    };
  }
  const hydrated = hydrateIndexFromStorage(ttlMs);
  if (hydrated.index.fribbLoadedAt > 0 || hydrated.index.anibridgeLoadedAt > 0) {
    memIndex = hydrated.index;
  }
  return hydrated;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T | null> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (native) {
      const fetchPromise = httpFetch(url, { Accept: "application/json" });
      const res = await new Promise<{ status: number; body: string } | null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        fetchPromise.then(resolve, () => resolve(null));
      });
      if (!res || res.status < 200 || res.status >= 300) return null;
      return JSON.parse(res.body) as T;
    }

    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller?.abort();
        resolve(null);
      }, timeoutMs);
    });

    const fetchPromise = fetch(url, {
      headers: { accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {}),
    })
      .then(async (r) => (r.ok ? ((await r.json()) as T) : null))
      .catch(() => null);

    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);

  return new Promise<T | null>((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? null : v);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

/**
 * Load and cache compact Fribb + Anibridge mapping indices.
 * Non-blocking and resilient: offline or fetch errors fall back to stale cache or empty index.
 */
export async function loadAnimeMappings(signal?: AbortSignal, ttlMs = DEFAULT_TTL_MS): Promise<MappingIndex> {
  if (signal?.aborted) {
    return memIndex ?? createEmptyIndex();
  }

  const state = getOrHydrateMemIndex(ttlMs);
  const now = Date.now();
  const needFribb = !state.fribbFresh && now - fribbFailedAt >= FAILURE_BACKOFF_MS;
  const needAnibridge = !state.anibridgeFresh && now - anibridgeFailedAt >= FAILURE_BACKOFF_MS;

  if (!needFribb && !needAnibridge) {
    return state.index;
  }

  if (!inflightLoad) {
    inflightLoad = (async () => {
      const idx = memIndex ?? state.index;
      const tasks: Promise<void>[] = [];

      if (needFribb) {
        tasks.push(
          fetchJsonWithTimeout<RawFribbEntry[]>(FRIBB_MINI_URL).then((raw) => {
            if (Array.isArray(raw)) {
              const rows = compactFribbEntries(raw);
              const at = Date.now();
              addFribbRowsToIndex(idx, rows, at);
              writeStorageJson(STORAGE_FRIBB_KEY, { at, rows } satisfies CompactFribbPayload);
              fribbFailedAt = 0;
            } else {
              fribbFailedAt = Date.now();
            }
          }),
        );
      }

      if (needAnibridge) {
        tasks.push(
          fetchJsonWithTimeout<RawAnibridgeMappings>(ANIBRIDGE_MAPPINGS_URL).then((raw) => {
            if (raw && typeof raw === "object") {
              const data = compactAnibridgeMappings(raw);
              const at = Date.now();
              addAnibridgeToIndex(idx, data, at);
              writeStorageJson(STORAGE_ANIBRIDGE_KEY, { at, data } satisfies CompactAnibridgePayload);
              anibridgeFailedAt = 0;
            } else {
              anibridgeFailedAt = Date.now();
            }
          }),
        );
      }

      await Promise.allSettled(tasks);
      memIndex = idx;
      return idx;
    })().finally(() => {
      inflightLoad = null;
    });
  }

  const res = await raceWithAbort(inflightLoad, signal);
  return res ?? memIndex ?? state.index;
}

/** Preload mapping indices in the background without blocking or throwing. */
export function preloadAnimeMappings(signal?: AbortSignal): Promise<void> {
  return loadAnimeMappings(signal).then(
    () => undefined,
    () => undefined,
  );
}

/** Seed mapping indices directly (primarily for unit tests or pre-bundled data). */
export function seedAnimeMappings(opts: {
  fribb?: RawFribbEntry[];
  anibridge?: RawAnibridgeMappings;
  persist?: boolean;
  at?: number;
}): void {
  const idx = memIndex ?? createEmptyIndex();
  const at = opts.at ?? Date.now();
  if (opts.fribb) {
    const rows = compactFribbEntries(opts.fribb);
    addFribbRowsToIndex(idx, rows, at);
    if (opts.persist) writeStorageJson(STORAGE_FRIBB_KEY, { at, rows } satisfies CompactFribbPayload);
  }
  if (opts.anibridge) {
    const data = compactAnibridgeMappings(opts.anibridge);
    addAnibridgeToIndex(idx, data, at);
    if (opts.persist) writeStorageJson(STORAGE_ANIBRIDGE_KEY, { at, data } satisfies CompactAnibridgePayload);
  }
  memIndex = idx;
  fribbFailedAt = 0;
  anibridgeFailedAt = 0;
}

/** Clear in-memory and localStorage mapping caches (for testing or forced refresh). */
export function clearAnimeMappingCache(): void {
  memIndex = null;
  inflightLoad = null;
  fribbFailedAt = 0;
  anibridgeFailedAt = 0;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_FRIBB_KEY);
      localStorage.removeItem(STORAGE_ANIBRIDGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function parseSourceRange(spec: string): RangeSegment | null {
  const m = spec.match(/^(\d+)(?:-(\d*))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : m[2] === "" ? Infinity : Number(m[2]);
  if (!Number.isFinite(start) || start < 1 || (Number.isFinite(end) && end < start)) return null;
  return { start, end };
}

function parseTargetRange(spec: string): ParsedTargetRange | null {
  const [segsPart, ratioPart] = spec.split("|");
  const ratio = ratioPart ? Number(ratioPart) : 1;
  if (!Number.isFinite(ratio) || ratio === 0) return null;

  const segments: RangeSegment[] = [];
  for (const seg of segsPart.split(",")) {
    const parsed = parseSourceRange(seg.trim());
    if (!parsed) return null;
    segments.push(parsed);
  }
  return segments.length > 0 ? { segments, ratio } : null;
}

/** Map a 1-based source episode through an Anibridge range table. Returns `null` if explicitly unmapped or unmatched. */
export function mapEpisodeByAnibridgeRanges(
  ranges: Record<string, string | null>,
  sourceEp: number,
): number | null {
  const entries = Object.entries(ranges);
  if (entries.length === 0) {
    // Empty object {} denotes a 1:1 season-level mapping.
    return sourceEp;
  }

  for (const [srcSpec, tgtSpec] of entries) {
    const src = parseSourceRange(srcSpec);
    if (!src) continue;
    if (sourceEp < src.start || sourceEp > src.end) continue;
    if (tgtSpec === null) return null;

    const tgt = parseTargetRange(tgtSpec);
    if (!tgt) continue;

    const rawOffset = sourceEp - src.start;
    let remaining =
      tgt.ratio > 1
        ? rawOffset * tgt.ratio
        : tgt.ratio < -1
          ? Math.floor(rawOffset / Math.abs(tgt.ratio))
          : rawOffset;

    for (const seg of tgt.segments) {
      if (seg.end === Infinity) {
        return seg.start + remaining;
      }
      const len = seg.end - seg.start + 1;
      if (remaining < len) {
        return seg.start + remaining;
      }
      remaining -= len;
    }
  }

  return null;
}

function extractQuery(input: AnimeMappingInput): {
  tmdbId?: number;
  tmdbKind?: "tv" | "movie";
  anilistId?: number;
  malId?: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  courEpisode?: number;
} {
  if ("media" in input) {
    const m = input.media;
    const tmdbMatch = m.key.match(/^tmdb:(movie|tv):(\d+)$/);
    const anilistMatch = m.key.match(/^anilist:(\d+)$/);
    const imdbFromMedia = (m as { imdbId?: string }).imdbId;
    return {
      tmdbId: m.tmdbId ?? (tmdbMatch ? Number(tmdbMatch[2]) : undefined),
      tmdbKind: tmdbMatch ? (tmdbMatch[1] as "movie" | "tv") : m.kind === "movie" ? "movie" : "tv",
      anilistId: m.anilistId ?? (anilistMatch ? Number(anilistMatch[1]) : undefined),
      malId: m.malId,
      imdbId: imdbFromMedia && /^tt\d+$/i.test(imdbFromMedia) ? imdbFromMedia : undefined,
      season: input.season,
      episode: input.episode,
      courEpisode: input.courEpisode,
    };
  }

  const tmdbMatch = input.key?.match(/^tmdb:(movie|tv):(\d+)$/);
  const anilistMatch = input.key?.match(/^anilist:(\d+)$/);
  return {
    tmdbId: input.tmdbId ?? (tmdbMatch ? Number(tmdbMatch[2]) : undefined),
    tmdbKind: tmdbMatch ? (tmdbMatch[1] as "movie" | "tv") : input.kind === "movie" ? "movie" : "tv",
    anilistId: input.anilistId ?? (anilistMatch ? Number(anilistMatch[1]) : undefined),
    malId: input.malId,
    imdbId: input.imdbId && /^tt\d+$/i.test(input.imdbId) ? input.imdbId : undefined,
    season: input.season,
    episode: input.episode,
  };
}

function resolveWithIndex(idx: MappingIndex, input: AnimeMappingInput): ResolvedAnimeIds {
  const q = extractQuery(input);
  const out: ResolvedAnimeIds = {
    malId: q.malId,
    anilistId: q.anilistId,
    tmdbId: q.tmdbId,
    tmdbKind: q.tmdbKind,
    imdbId: q.imdbId,
    courEpisode: q.courEpisode,
    tmdbSeason: q.season,
  };

  if (q.malId || q.anilistId) {
    out.source = "request";
  }

  // 1. TMDB -> AniList / MAL / IMDB (+ cour episode mapping)
  if (q.tmdbId) {
    if (q.tmdbKind === "movie") {
      const abTargets = idx.abBySource.get(`tmdb_movie:${q.tmdbId}`) ?? [];
      for (const t of abTargets) {
        if (t.provider === "anilist" && !out.anilistId) {
          out.anilistId = Number(t.id) || undefined;
          out.source ??= "anibridge";
        } else if (t.provider === "mal" && !out.malId) {
          out.malId = Number(t.id) || undefined;
          out.source ??= "anibridge";
        } else if (t.provider === "imdb_movie" && !out.imdbId) {
          out.imdbId = t.id;
        }
      }
      const fribbMovies = idx.fribbByTmdbMovie.get(q.tmdbId) ?? [];
      for (const rec of fribbMovies) {
        if (!out.anilistId && rec.anilistId) {
          out.anilistId = rec.anilistId;
          out.source ??= "fribb";
        }
        if (!out.malId && rec.malId) {
          out.malId = rec.malId;
          out.source ??= "fribb";
        }
        if (!out.imdbId && rec.imdbId) out.imdbId = rec.imdbId;
      }
    } else {
      const season = q.season ?? 1;
      const ep = q.episode ?? 1;
      const abTargets = idx.abBySource.get(`tmdb_show:${q.tmdbId}:s${season}`) ?? [];

      let anilistCourHit: { id: number; mappedEp: number } | undefined;
      let malCourHit: { id: number; mappedEp: number } | undefined;
      for (const t of abTargets) {
        const mapped = mapEpisodeByAnibridgeRanges(t.ranges, ep);
        if (mapped == null) continue;
        if (t.provider === "anilist" && !anilistCourHit) {
          const id = Number(t.id);
          if (id > 0) anilistCourHit = { id, mappedEp: mapped };
        } else if (t.provider === "mal" && !malCourHit) {
          const id = Number(t.id);
          if (id > 0) malCourHit = { id, mappedEp: mapped };
        } else if ((t.provider === "imdb_show" || t.provider === "imdb_movie") && !out.imdbId) {
          out.imdbId = t.id;
        }
      }

      if (anilistCourHit && !out.anilistId) {
        out.anilistId = anilistCourHit.id;
        out.source ??= "anibridge";
      }
      if (malCourHit && !out.malId) {
        out.malId = malCourHit.id;
        out.source ??= "anibridge";
      }
      if (out.courEpisode == null && q.episode != null) {
        const mappedEp = malCourHit?.mappedEp ?? anilistCourHit?.mappedEp;
        if (mappedEp != null) {
          out.courEpisode = mappedEp;
          out.source ??= "anibridge";
        }
      }

      // Cross-resolve AniList <-> MAL for an Anibridge cour hit before falling back to Fribb's season list,
      // so a missing Fribb cour entry never overrides an exact Anibridge cour match.
      if (out.anilistId && !out.malId) {
        const linkedMal = idx.abByAnilist.get(out.anilistId)?.malIds[0] ?? idx.fribbByAnilist.get(out.anilistId)?.malId;
        if (linkedMal) out.malId = linkedMal;
      }
      if (out.malId && !out.anilistId) {
        const linkedAl = idx.abByMal.get(out.malId)?.anilistIds[0] ?? idx.fribbByMal.get(out.malId)?.anilistId;
        if (linkedAl) out.anilistId = linkedAl;
      }

      // Fribb fallback / complement for TMDB TV season + episode_offset
      const fribbSeasonList =
        idx.fribbByTmdbTvSeason.get(`${q.tmdbId}:${season}`) ??
        (season === 1 ? idx.fribbByTmdbTvSeason.get(`${q.tmdbId}:*`) : undefined) ??
        [];

      if (fribbSeasonList.length > 0) {
        let best = fribbSeasonList[0];
        for (const rec of fribbSeasonList) {
          if (ep > rec.tmdbOffset && rec.tmdbOffset >= best.tmdbOffset) {
            best = rec;
          }
        }
        if (!out.anilistId && best.anilistId) {
          out.anilistId = best.anilistId;
          out.source ??= "fribb";
        }
        if (!out.malId && best.malId) {
          out.malId = best.malId;
          out.source ??= "fribb";
        }
        if (!out.imdbId && best.imdbId) out.imdbId = best.imdbId;
        if (out.courEpisode == null && q.episode != null && ep > best.tmdbOffset) {
          out.courEpisode = ep - best.tmdbOffset;
          out.source ??= "fribb";
        }
      }
    }
  }

  // 2. AniList -> MAL / TMDB / IMDB
  const lookupAnilistId = out.anilistId ?? q.anilistId;
  if (lookupAnilistId) {
    const ab = idx.abByAnilist.get(lookupAnilistId);
    if (ab) {
      if (!out.malId && ab.malIds[0]) {
        out.malId = ab.malIds[0];
        out.source ??= "anibridge";
      }
      if (!out.imdbId && ab.imdbIds[0]) out.imdbId = ab.imdbIds[0];
      if (!out.tmdbId && ab.tmdb[0]) {
        out.tmdbId = ab.tmdb[0].id;
        out.tmdbKind = ab.tmdb[0].kind;
        if (ab.tmdb[0].season != null) out.tmdbSeason ??= ab.tmdb[0].season;
      }
    }
    const fr = idx.fribbByAnilist.get(lookupAnilistId);
    if (fr) {
      if (!out.malId && fr.malId) {
        out.malId = fr.malId;
        out.source ??= "fribb";
      }
      if (!out.imdbId && fr.imdbId) out.imdbId = fr.imdbId;
      if (!out.tmdbId && fr.tmdbId) {
        out.tmdbId = fr.tmdbId;
        out.tmdbKind = fr.tmdbKind;
        if (fr.tmdbSeason != null) out.tmdbSeason ??= fr.tmdbSeason;
      }
    }
  }

  // 3. MAL -> AniList / TMDB / IMDB
  const lookupMalId = out.malId ?? q.malId;
  if (lookupMalId) {
    const ab = idx.abByMal.get(lookupMalId);
    if (ab) {
      if (!out.anilistId && ab.anilistIds[0]) {
        out.anilistId = ab.anilistIds[0];
        out.source ??= "anibridge";
      }
      if (!out.imdbId && ab.imdbIds[0]) out.imdbId = ab.imdbIds[0];
      if (!out.tmdbId && ab.tmdb[0]) {
        out.tmdbId = ab.tmdb[0].id;
        out.tmdbKind = ab.tmdb[0].kind;
        if (ab.tmdb[0].season != null) out.tmdbSeason ??= ab.tmdb[0].season;
      }
    }
    const fr = idx.fribbByMal.get(lookupMalId);
    if (fr) {
      if (!out.anilistId && fr.anilistId) {
        out.anilistId = fr.anilistId;
        out.source ??= "fribb";
      }
      if (!out.imdbId && fr.imdbId) out.imdbId = fr.imdbId;
      if (!out.tmdbId && fr.tmdbId) {
        out.tmdbId = fr.tmdbId;
        out.tmdbKind = fr.tmdbKind;
        if (fr.tmdbSeason != null) out.tmdbSeason ??= fr.tmdbSeason;
      }
    }
  }

  // 4. IMDB -> AniList / MAL / TMDB
  const lookupImdbId = out.imdbId ?? q.imdbId;
  if (lookupImdbId && (!out.anilistId || !out.malId || !out.tmdbId)) {
    const ab = idx.abByImdb.get(lookupImdbId);
    if (ab) {
      if (!out.anilistId && ab.anilistIds[0]) {
        out.anilistId = ab.anilistIds[0];
        out.source ??= "anibridge";
      }
      if (!out.malId && ab.malIds[0]) {
        out.malId = ab.malIds[0];
        out.source ??= "anibridge";
      }
      if (!out.tmdbId && ab.tmdb[0]) {
        out.tmdbId = ab.tmdb[0].id;
        out.tmdbKind = ab.tmdb[0].kind;
        if (ab.tmdb[0].season != null) out.tmdbSeason ??= ab.tmdb[0].season;
      }
    }
    const frList = idx.fribbByImdb.get(lookupImdbId) ?? [];
    if (frList.length > 0) {
      const season = q.season ?? 1;
      const ep = q.episode ?? 1;
      const matchingSeason = frList.filter((r) => r.tmdbSeason == null || r.tmdbSeason === season);
      const pool = matchingSeason.length > 0 ? matchingSeason : frList;
      let best = pool[0];
      for (const rec of pool) {
        if (ep > rec.tmdbOffset && rec.tmdbOffset >= best.tmdbOffset) best = rec;
      }
      if (!out.anilistId && best.anilistId) {
        out.anilistId = best.anilistId;
        out.source ??= "fribb";
      }
      if (!out.malId && best.malId) {
        out.malId = best.malId;
        out.source ??= "fribb";
      }
      if (!out.tmdbId && best.tmdbId) {
        out.tmdbId = best.tmdbId;
        out.tmdbKind = best.tmdbKind;
        if (best.tmdbSeason != null) out.tmdbSeason ??= best.tmdbSeason;
      }
      if (out.courEpisode == null && q.episode != null && ep > best.tmdbOffset) {
        out.courEpisode = ep - best.tmdbOffset;
      }
    }
  }

  return out;
}

/**
 * Resolve cross-provider anime IDs (`malId`, `anilistId`, `tmdbId`, `imdbId`) and cour-relative
 * episode number asynchronously, loading & caching Fribb + Anibridge mappings when needed.
 */
export async function resolveAnimeIds(req: AnimeMappingInput, signal?: AbortSignal): Promise<ResolvedAnimeIds> {
  const q = extractQuery(req);
  if (signal?.aborted) {
    return {
      malId: q.malId,
      anilistId: q.anilistId,
      tmdbId: q.tmdbId,
      tmdbKind: q.tmdbKind,
      imdbId: q.imdbId,
      courEpisode: q.courEpisode,
      tmdbSeason: q.season,
    };
  }

  const idx = await loadAnimeMappings(signal);
  return resolveWithIndex(idx, req);
}

/** Synchronous lookup against already-loaded or localStorage-cached mapping indices. */
export function resolveAnimeIdsSync(req: AnimeMappingInput): ResolvedAnimeIds {
  const { index } = getOrHydrateMemIndex();
  return resolveWithIndex(index, req);
}

/**
 * Resolve a TMDB (or Anime) `(season, episode)` into the exact cour's `malId`, `anilistId`, and
 * `courEpisode` asynchronously using Anibridge range mappings and Fribb episode offsets.
 */
export async function resolveCourEpisodeMapping(
  input: AnimeMappingInput,
  signal?: AbortSignal,
): Promise<CourEpisodeMappingResult> {
  const q = extractQuery(input);
  const season = q.season ?? 1;
  const episode = q.episode ?? 1;
  const res = await resolveAnimeIds({ ...q, season, episode }, signal);
  return {
    malId: res.malId,
    anilistId: res.anilistId,
    tmdbId: res.tmdbId,
    tmdbKind: res.tmdbKind,
    imdbId: res.imdbId,
    season,
    episode,
    courEpisode: res.courEpisode ?? q.courEpisode ?? episode,
    source: res.source === "anibridge" || res.source === "fribb" ? res.source : undefined,
  };
}

/** Synchronous cour/episode resolution against in-memory or localStorage-cached mapping indices. */
export function resolveCourEpisodeMappingSync(input: AnimeMappingInput): CourEpisodeMappingResult {
  const q = extractQuery(input);
  const season = q.season ?? 1;
  const episode = q.episode ?? 1;
  const res = resolveAnimeIdsSync({ ...q, season, episode });
  return {
    malId: res.malId,
    anilistId: res.anilistId,
    tmdbId: res.tmdbId,
    tmdbKind: res.tmdbKind,
    imdbId: res.imdbId,
    season,
    episode,
    courEpisode: res.courEpisode ?? q.courEpisode ?? episode,
    source: res.source === "anibridge" || res.source === "fribb" ? res.source : undefined,
  };
}

/**
 * Synchronously inspect cached mappings to build `SeasonCour` metadata for a TMDB TV season
 * (used by `normalizeTmdbSeasons` when mapping data is already cached).
 */
export function getTmdbSeasonMappingSync(
  tmdbId: number,
  seasonNumber: number,
  episodeCount: number,
): { anilistId?: number; malId?: number; cours?: SeasonCour[] } | undefined {
  if (!tmdbId || seasonNumber < 0 || episodeCount <= 0) return undefined;
  const { index } = getOrHydrateMemIndex();

  const abTargets = index.abBySource.get(`tmdb_show:${tmdbId}:s${seasonNumber}`) ?? [];
  const anilistTargets = abTargets.filter((t) => t.provider === "anilist");
  const malTargets = abTargets.filter((t) => t.provider === "mal");

  const matchMalByEpisode = (ep: number): number | undefined => {
    for (const m of malTargets) {
      if (mapEpisodeByAnibridgeRanges(m.ranges, ep) != null) {
        const id = Number(m.id);
        if (id > 0) return id;
      }
    }
    return undefined;
  };

  const buildCoursFromTargets = (
    targets: AnibridgeTargetEntry[],
    resolveIds: (id: number, startEpisode: number) => { anilistId?: number; malId?: number },
  ): SeasonCour[] => {
    const cours: SeasonCour[] = [];
    for (const target of targets) {
      const targetId = Number(target.id);
      if (!Number.isFinite(targetId) || targetId <= 0) continue;
      const entries = Object.entries(target.ranges);
      const ranges: [number, number][] = [];
      if (entries.length === 0) {
        ranges.push([1, episodeCount]);
      } else {
        for (const [srcSpec, tgtSpec] of entries) {
          if (tgtSpec === null) continue;
          const parsed = parseSourceRange(srcSpec);
          if (!parsed) continue;
          const startEpisode = parsed.start;
          const endEpisode = Number.isFinite(parsed.end) ? Math.min(episodeCount, parsed.end) : episodeCount;
          if (endEpisode >= startEpisode) ranges.push([startEpisode, endEpisode]);
        }
      }
      for (const [startEpisode, endEpisode] of ranges) {
        const { anilistId, malId } = resolveIds(targetId, startEpisode);
        cours.push({
          key: anilistId ? `anilist:${anilistId}` : `tmdb:tv:${tmdbId}`,
          anilistId,
          malId,
          title: `Season ${seasonNumber}`,
          startEpisode,
          endEpisode,
          episodeCount: endEpisode - startEpisode + 1,
        });
      }
    }
    cours.sort((a, b) => a.startEpisode - b.startEpisode);
    return cours;
  };

  if (anilistTargets.length > 0) {
    const cours = buildCoursFromTargets(anilistTargets, (alId, startEp) => ({
      anilistId: alId,
      malId: index.abByAnilist.get(alId)?.malIds[0] ?? index.fribbByAnilist.get(alId)?.malId ?? matchMalByEpisode(startEp),
    }));
    if (cours.length > 0) {
      return {
        anilistId: cours[0].anilistId,
        malId: cours[0].malId ?? (malTargets[0] ? Number(malTargets[0].id) || undefined : undefined),
        cours: cours.length > 1 ? cours : undefined,
      };
    }
  }

  if (malTargets.length > 0) {
    const cours = buildCoursFromTargets(malTargets, (malId) => ({
      anilistId: index.abByMal.get(malId)?.anilistIds[0] ?? index.fribbByMal.get(malId)?.anilistId,
      malId,
    }));
    if (cours.length > 0) {
      return {
        anilistId: cours[0].anilistId,
        malId: cours[0].malId,
        cours: cours.length > 1 ? cours : undefined,
      };
    }
  }

  const fribbList =
    index.fribbByTmdbTvSeason.get(`${tmdbId}:${seasonNumber}`) ??
    (seasonNumber === 1 ? index.fribbByTmdbTvSeason.get(`${tmdbId}:*`) : undefined) ??
    [];
  if (fribbList.length === 0) return undefined;

  // Deduplicate by offset, keeping entries within [0, episodeCount)
  const valid = fribbList.filter((r) => r.tmdbOffset < episodeCount);
  if (valid.length === 0) return undefined;

  if (valid.length === 1) {
    return {
      anilistId: valid[0].anilistId,
      malId: valid[0].malId,
    };
  }

  const cours: SeasonCour[] = [];
  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    const next = valid[i + 1];
    const startEpisode = cur.tmdbOffset + 1;
    const endEpisode = next ? Math.min(episodeCount, next.tmdbOffset) : episodeCount;
    if (endEpisode < startEpisode) continue;
    cours.push({
      key: cur.anilistId ? `anilist:${cur.anilistId}` : `tmdb:tv:${tmdbId}`,
      anilistId: cur.anilistId,
      malId: cur.malId,
      title: `Season ${seasonNumber}`,
      startEpisode,
      endEpisode,
      episodeCount: endEpisode - startEpisode + 1,
    });
  }

  if (cours.length === 0) return undefined;
  return {
    anilistId: cours[0].anilistId,
    malId: cours[0].malId,
    cours: cours.length > 1 ? cours : undefined,
  };
}

/**
 * Synchronously check whether two AniList entries belong to the same TMDB TV season
 * with a split-cour offset, helping `reconcileAnimeSeasons` fold untagged split cours.
 */
export function areSameTmdbSeasonCoursSync(prevAnilistId: number, nextAnilistId: number): boolean {
  if (!prevAnilistId || !nextAnilistId || prevAnilistId === nextAnilistId) return false;
  const { index } = getOrHydrateMemIndex();

  const prevFr = index.fribbByAnilist.get(prevAnilistId);
  const nextFr = index.fribbByAnilist.get(nextAnilistId);
  if (
    prevFr?.tmdbId &&
    nextFr?.tmdbId &&
    prevFr.tmdbId === nextFr.tmdbId &&
    prevFr.tmdbKind === "tv" &&
    nextFr.tmdbKind === "tv" &&
    prevFr.tmdbSeason != null &&
    prevFr.tmdbSeason === nextFr.tmdbSeason &&
    nextFr.tmdbOffset > prevFr.tmdbOffset
  ) {
    return true;
  }

  const prevAb = index.abByAnilist.get(prevAnilistId)?.tmdb ?? [];
  const nextAb = index.abByAnilist.get(nextAnilistId)?.tmdb ?? [];
  for (const p of prevAb) {
    if (p.kind !== "tv" || p.season == null) continue;
    if (nextAb.some((n) => n.kind === "tv" && n.id === p.id && n.season === p.season)) {
      return true;
    }
  }
  return false;
}
