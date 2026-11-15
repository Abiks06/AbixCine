import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  aesCbcDecrypt,
  base64ToBytes,
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchJsonWithAbort,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  normalizeQuality,
  resolveMediaIds,
  titleSimilarity,
  type RawSubtitleInput,
} from "./common";

const CASTLE_API = "https://api.hlowb.com";
const CASTLE_PACKAGE = "com.external.castle";
const CASTLE_CHANNEL = "IndiaA";
const CASTLE_KEY_SUFFIX = "T!BgJB";
const CASTLE_APK_SIGN = "ED0955EB04E67A1D9F3305B95454FED485261475";
const KEY_TTL_MS = 15 * 60_000;

const CASTLE_HEADERS = {
  "User-Agent": "okhttp/4.9.3",
  Accept: "application/json",
  Referer: CASTLE_API,
};

interface CastleSearchRow {
  id?: string | number;
  title?: string;
  originalTitle?: string;
  publishTime?: string;
  year?: number | string;
}

interface CastleSearchPayload {
  rows?: CastleSearchRow[];
  data?: { rows?: CastleSearchRow[] };
}

interface CastleTrack {
  languageId?: number | string;
  languageName?: string;
  abbreviate?: string;
  isDefault?: boolean;
}

interface CastleSeason {
  movieId?: string | number;
  number?: number | string;
  description?: string;
  isCurrent?: boolean;
}

interface CastleEpisode {
  id?: string | number;
  title?: string;
  number?: number | string;
  tracks?: CastleTrack[];
  subtitles?: CastleSubtitleEntry[];
}

interface CastleSubtitleEntry {
  url?: string;
  lang?: string;
  language?: string;
  abbreviate?: string;
  label?: string;
  title?: string;
  isDefault?: boolean;
}

interface CastleDetailPayload {
  id?: string | number;
  title?: string;
  seasons?: CastleSeason[];
  episodes?: CastleEpisode[];
  tracks?: CastleTrack[];
  subtitles?: CastleSubtitleEntry[];
}

interface CastleVideoEntry {
  resolution?: number | string;
  resolutionDescription?: string;
  size?: number;
  url?: string;
  videoUrl?: string;
  premiumProPermission?: boolean;
}

interface CastleVideoPayload {
  videoUrl?: string;
  videos?: CastleVideoEntry[];
  subtitles?: CastleSubtitleEntry[];
  permissionDenied?: boolean;
}

let cachedSecKey: { key: string; at: number } | null = null;

/** Reset Castle's cached security key (primarily for unit tests). */
export function clearCastleKeyCache(): void {
  cachedSecKey = null;
}

function buildCastleKey16(secB64: string): Uint8Array {
  const secBytes = base64ToBytes(secB64);
  const suffix = new TextEncoder().encode(CASTLE_KEY_SUFFIX);
  const key16 = new Uint8Array(16);
  const combined = new Uint8Array(secBytes.length + suffix.length);
  combined.set(secBytes, 0);
  combined.set(suffix, secBytes.length);
  key16.set(combined.subarray(0, 16));
  return key16;
}

/** Decrypt Castle's AES-128-CBC response envelope (`rawText` base64 or `{ data }` JSON). */
export async function decryptCastlePayload<T = Record<string, unknown>>(
  rawText: string,
  secB64: string,
): Promise<T | null> {
  let cipherB64 = rawText.trim();
  if (!cipherB64) return null;

  if (cipherB64.startsWith("{")) {
    try {
      const envelope = JSON.parse(cipherB64) as { data?: unknown };
      if (typeof envelope.data === "string" && envelope.data.trim()) {
        cipherB64 = envelope.data.trim();
      } else if (envelope.data && typeof envelope.data === "object") {
        return envelope.data as T;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  } else if (cipherB64.startsWith('"') && cipherB64.endsWith('"')) {
    try {
      const unwrapped = JSON.parse(cipherB64);
      if (typeof unwrapped !== "string") return null;
      cipherB64 = unwrapped.trim();
    } catch {
      return null;
    }
  }

  let cipherBytes: Uint8Array;
  try {
    cipherBytes = base64ToBytes(cipherB64);
  } catch {
    return null;
  }
  if (cipherBytes.length < 16) return null;

  const key16 = buildCastleKey16(secB64);
  const plain = await aesCbcDecrypt(key16, key16, cipherBytes);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain) as { data?: T } & T;
    return (parsed && typeof parsed === "object" && "data" in parsed && parsed.data != null
      ? parsed.data
      : parsed) as T;
  } catch {
    return null;
  }
}

async function fetchSecurityKey(signal: AbortSignal, forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedSecKey && Date.now() - cachedSecKey.at < KEY_TTL_MS) {
    return cachedSecKey.key;
  }
  const url = `${CASTLE_API}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CHANNEL}&clientType=1&lang=en-US`;
  const res = await fetchJsonWithAbort<{ data?: string }>(url, CASTLE_HEADERS, undefined, signal, 7_000);
  const key = typeof res.data?.data === "string" ? res.data.data.trim() : "";
  if (!key) return null;
  cachedSecKey = { key, at: Date.now() };
  return key;
}

async function fetchAndDecrypt<T>(
  url: string,
  init: { method?: "GET" | "POST"; body?: string } | undefined,
  signal: AbortSignal,
): Promise<T | null> {
  let secKey = await fetchSecurityKey(signal);
  if (!secKey || signal.aborted) return null;

  const headers = init?.body
    ? { ...CASTLE_HEADERS, "Content-Type": "application/json" }
    : CASTLE_HEADERS;
  const res = await fetchWithAbort(url, headers, init, signal, 8_000);
  if (res.status < 200 || res.status >= 300 || !res.body) return null;

  const first = await decryptCastlePayload<T>(res.body, secKey);
  if (first !== null || signal.aborted) return first;

  // Key might have rotated; clear cache and retry decryption once with a fresh key.
  clearCastleKeyCache();
  secKey = await fetchSecurityKey(signal, true);
  if (!secKey || signal.aborted) return null;
  return decryptCastlePayload<T>(res.body, secKey);
}

function parseRowYear(row: CastleSearchRow): number | undefined {
  const raw = row.year ?? row.publishTime;
  const m = String(raw ?? "").match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : undefined;
}

function pickBestCastleHit(rows: CastleSearchRow[], targets: string[], wantYear?: number): CastleSearchRow | null {
  let best: CastleSearchRow | null = null;
  let bestScore = -1;

  for (const row of rows) {
    if (row.id == null) continue;
    const candidates = [row.title, row.originalTitle].filter((t): t is string => Boolean(t?.trim()));
    if (!candidates.length) continue;

    let sim = 0;
    for (const c of candidates) {
      for (const target of targets) {
        sim = Math.max(sim, titleSimilarity(c, target));
      }
    }
    const ry = parseRowYear(row);
    if (wantYear && ry) {
      if (Math.abs(ry - wantYear) <= 1) sim += 0.08;
      else if (Math.abs(ry - wantYear) >= 3) sim -= 0.1;
    }
    if (sim > bestScore) {
      bestScore = sim;
      best = row;
    }
  }

  return bestScore >= 0.55 ? best : null;
}

function pickBestCastleTrack(tracks: CastleTrack[] | undefined): CastleTrack | undefined {
  if (!Array.isArray(tracks) || tracks.length === 0) return undefined;
  const rank = (t: CastleTrack): number => {
    const abbr = (t.abbreviate ?? "").trim().toLowerCase();
    const name = (t.languageName ?? "").trim().toLowerCase();
    if (abbr === "en" || abbr.startsWith("en-") || /\benglish\b/.test(name)) return 4;
    if (abbr === "ost" || /^(?:ost|orig|original)\b/.test(name)) return 3;
    if (t.isDefault) return 2;
    return 1;
  };
  return [...tracks].sort((a, b) => rank(b) - rank(a))[0];
}

function castleResolutionToQuality(entry: CastleVideoEntry): number | undefined {
  const desc = normalizeQuality(entry.resolutionDescription);
  if (desc) return desc;
  const raw = entry.resolution;
  if (raw === 3 || raw === "3") return 1080;
  if (raw === 2 || raw === "2") return 720;
  if (raw === 1 || raw === "1") return 480;
  return normalizeQuality(raw);
}

function inferCastleQuality(videoUrl: string, videos?: CastleVideoEntry[]): number | undefined {
  const urlMatch = videoUrl.match(/\/(2160|1080|720|480|360)p?(?:\/|$)/i)?.[1];
  if (urlMatch) return normalizeQuality(urlMatch);
  const unlocked = (videos ?? []).filter((entry) => entry.premiumProPermission !== true);
  const pool = unlocked.length > 0 ? unlocked : (videos ?? []);
  let best = 0;
  for (const entry of pool) {
    const q = castleResolutionToQuality(entry) ?? 0;
    if (q > best) best = q;
  }
  return best > 0 ? best : undefined;
}

function mapCastleSubtitles(entries: CastleSubtitleEntry[] | undefined): RawSubtitleInput[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((sub) => ({
    url: sub.url,
    lang: sub.lang ?? sub.language ?? sub.abbreviate,
    label: sub.label ?? sub.title ?? sub.language ?? sub.lang ?? sub.abbreviate,
    isDefault: sub.isDefault,
  }));
}

/**
 * Direct Castle extractor (`api.hlowb.com`, Movie & TV) using local AES-128-CBC
 * encryption key derivation with zero external decrypt API dependency.
 */
export const castleProvider: SourceProvider = {
  id: "castle",
  name: "Castle",
  category: "external",
  priority: 22,
  timeoutMs: 14_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("castle", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted) return [];

      const targets = Array.from(
        new Set([meta.title, meta.originalTitle].filter((t): t is string => Boolean(t?.trim()))),
      ).slice(0, 2);
      if (targets.length === 0) return [];

      const rows: CastleSearchRow[] = [];
      const seenIds = new Set<string>();
      let hit: CastleSearchRow | null = null;

      for (const q of targets) {
        if (signal.aborted) return [];
        const searchUrl =
          `${CASTLE_API}/film-api/v1.1.0/movie/searchByKeyword?channel=${CASTLE_CHANNEL}&clientType=1` +
          `&keyword=${encodeURIComponent(q)}&lang=en-US&mode=1&packageName=${CASTLE_PACKAGE}&page=1&size=20`;
        const payload = await fetchAndDecrypt<CastleSearchPayload>(searchUrl, undefined, signal);
        const list = payload?.rows ?? payload?.data?.rows ?? [];
        for (const row of list) {
          const id = row?.id != null ? String(row.id) : "";
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          rows.push(row);
        }
        hit = pickBestCastleHit(rows, targets, meta.year);
        if (hit) break;
      }

      if (!hit || hit.id == null || signal.aborted) return [];
      let activeMovieId = String(hit.id);

      const fetchDetail = (movieId: string) =>
        fetchAndDecrypt<CastleDetailPayload>(
          `${CASTLE_API}/film-api/v1.9.9/movie?channel=${CASTLE_CHANNEL}&clientType=1&lang=en-US&movieId=${encodeURIComponent(movieId)}&packageName=${CASTLE_PACKAGE}`,
          undefined,
          signal,
        );

      let detail = await fetchDetail(activeMovieId);
      if (!detail || signal.aborted) return [];

      const isMovie = isMovieRequest(req);
      const wantSeason = req.season ?? 1;
      const wantEpisode = req.episode ?? 1;

      if (!isMovie && Array.isArray(detail.seasons) && detail.seasons.length > 0) {
        const matchedSeason = detail.seasons.find((s) => Number(s?.number) === wantSeason);
        if (matchedSeason?.movieId != null && String(matchedSeason.movieId) !== activeMovieId) {
          activeMovieId = String(matchedSeason.movieId);
          const seasonDetail = await fetchDetail(activeMovieId);
          if (seasonDetail) detail = seasonDetail;
        }
      }
      if (signal.aborted) return [];

      const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
      const ep = isMovie
        ? episodes[0] ?? { id: activeMovieId, number: 1, tracks: detail.tracks }
        : episodes.find((e) => Number(e?.number) === wantEpisode)
          ?? episodes.find((e) => typeof e?.title === "string" && new RegExp(`^E0*${wantEpisode}\\b`, "i").test(e.title));
      if (!ep || ep.id == null) return [];

      const selectedTrack = pickBestCastleTrack(ep.tracks ?? detail.tracks);
      const videoUrlEndpoint =
        `${CASTLE_API}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=${CASTLE_PACKAGE}&channel=${CASTLE_CHANNEL}&lang=en-US`;
      const fetchVideoForResolution = (resolution: string) =>
        fetchAndDecrypt<CastleVideoPayload>(
          videoUrlEndpoint,
          {
            method: "POST",
            body: JSON.stringify({
              mode: "1",
              appMarket: "GuanWang",
              clientType: "1",
              woolUser: "false",
              apkSignKey: CASTLE_APK_SIGN,
              androidVersion: "13",
              movieId: activeMovieId,
              episodeId: String(ep.id),
              ...(selectedTrack?.languageId != null ? { languageId: String(selectedTrack.languageId) } : {}),
              isNewUser: "true",
              resolution,
              packageName: CASTLE_PACKAGE,
            }),
          },
          signal,
        );

      // Castle gates 1080p (resolution=3) behind premiumProPermission on many titles
      // (returning { permissionDenied: true } with no videoUrl), whereas 720p (resolution=2)
      // returns a playable stream and tells us via videos[] whether 1080p is unlocked.
      let primaryPayload = await fetchVideoForResolution("2");
      if (signal.aborted) return [];

      const hasUsablePayload = (p: CastleVideoPayload | null): p is CastleVideoPayload =>
        Boolean(p && !p.permissionDenied && (p.videoUrl || (p.videos ?? []).some((v) => v.url || v.videoUrl)));

      if (!hasUsablePayload(primaryPayload)) {
        const sdPayload = await fetchVideoForResolution("1");
        if (signal.aborted) return [];
        if (hasUsablePayload(sdPayload)) primaryPayload = sdPayload;
      }
      if (!primaryPayload || signal.aborted) return [];

      let hd1080Payload: CastleVideoPayload | null = null;
      const hasFree1080 = (primaryPayload.videos ?? []).some(
        (v) => Number(v.resolution) === 3 && v.premiumProPermission === false,
      );
      if (hasFree1080) {
        const res3 = await fetchVideoForResolution("3");
        if (signal.aborted) return [];
        if (hasUsablePayload(res3)) hd1080Payload = res3;
      }

      const streamHeaders = buildStreamHeaders(`${CASTLE_API}/`, CASTLE_API);
      const subtitles = buildSubtitleTracks(
        [
          ...mapCastleSubtitles(hd1080Payload?.subtitles),
          ...mapCastleSubtitles(primaryPayload.subtitles),
          ...mapCastleSubtitles(ep.subtitles),
          ...mapCastleSubtitles(detail.subtitles),
        ],
        streamHeaders,
        CASTLE_API,
      );

      const candidates: StreamCandidate[] = [];
      const seenUrls = new Set<string>();
      const pushCandidate = (
        rawUrl: string | undefined,
        explicitQuality: number | undefined,
        videosForQuality?: CastleVideoEntry[],
      ) => {
        const cleanUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
        if (!/^https?:\/\//i.test(cleanUrl) || seenUrls.has(cleanUrl)) return;
        seenUrls.add(cleanUrl);
        const q = explicitQuality ?? inferCastleQuality(cleanUrl, videosForQuality);
        const kind = inferStreamKind(cleanUrl);
        candidates.push({
          providerId: "castle",
          providerName: "Castle",
          label: `Castle${q ? ` · ${q}p` : ""} · ${kind.toUpperCase()}`,
          url: proxyUrl(cleanUrl, streamHeaders, CASTLE_API),
          kind,
          via: "direct",
          headers: streamHeaders,
          subtitles,
          ...(q ? { quality: q } : {}),
          ...(anime ? { audio: "sub" as const } : {}),
        });
      };

      const collectPayload = (payload: CastleVideoPayload | null) => {
        if (!payload || payload.permissionDenied) return;
        pushCandidate(payload.videoUrl, undefined, payload.videos);
        for (const entry of payload.videos ?? []) {
          if (entry.premiumProPermission === true) continue;
          pushCandidate(
            entry.url ?? entry.videoUrl,
            castleResolutionToQuality(entry),
            payload.videos,
          );
        }
      };

      collectPayload(hd1080Payload);
      collectPayload(primaryPayload);

      return candidates;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      // Unreachable or broken protocol is an error so server health tracks it.
      throw err;
    }
  },
};
