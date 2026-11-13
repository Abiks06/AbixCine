import { normTitle } from "../../lib/format";
import type { Settings } from "../../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  ASIAN_DRAMA_LANGS,
  aes256CbcDecrypt,
  base64ToBytes,
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  normalizeQuality,
  titleSimilarity,
} from "./common";

const MAIN_URL = "https://api3.devcorp.me";
const REFERER_URL = "https://onetouchtv.xyz/";
const AES_KEY = new TextEncoder().encode("im72charPasswordofdInitVectorStm");
const AES_IV = new TextEncoder().encode("im72charPassword");

const ALLOWED_SERIES_TYPES = new Set(["drama", "variety", "anime", "series", "tv"]);

interface OttSearchItem {
  id?: string | number;
  title?: string;
  year?: string | number;
  type?: string;
}

interface OttEpisode {
  episode?: string | number;
  playId?: string | number;
}

interface OttDetail {
  id?: string | number;
  title?: string;
  episodes?: OttEpisode[];
}

interface OttStreamSource {
  url?: string;
  quality?: string | number;
  type?: string;
  name?: string;
}

interface OttTrack {
  file?: string;
  name?: string;
  lang?: string;
  default?: boolean;
}

interface OttEpisodeStreams {
  sources?: OttStreamSource[];
  track?: OttTrack[];
}

/**
 * Decrypt OneTouchTV's AES-256-CBC encoded API response payload.
 * Normalizes `-_.` -> `/` and `@` -> `+` before base64 decoding.
 */
export async function decryptOneTouchPayload<T = unknown>(encoded: string): Promise<T | null> {
  if (!encoded || typeof encoded !== "string") return null;
  try {
    const normalized = encoded
      .replace(/-_\./g, "/")
      .replace(/@/g, "+")
      .replace(/\s+/g, "");
    const cipherBytes = base64ToBytes(normalized);
    const plain = await aes256CbcDecrypt(AES_KEY, AES_IV, cipherBytes);
    if (!plain) return null;
    const parsed = JSON.parse(plain) as { result?: T };
    return (parsed && "result" in parsed ? parsed.result : (parsed as unknown as T)) ?? null;
  } catch {
    return null;
  }
}

async function fetchOttEncrypted<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const url = path.startsWith("https://") ? path : `${MAIN_URL}${path}`;
  const res = await fetchWithAbort(
    url,
    {
      "User-Agent": DEFAULT_UA,
      Referer: REFERER_URL,
      Origin: "https://onetouchtv.xyz",
    },
    undefined,
    signal,
    10_000,
  );
  if (res.status < 200 || res.status >= 300) return null;
  return decryptOneTouchPayload<T>(res.body);
}

function isTypeCompatible(isMovie: boolean, rawType?: string): boolean {
  const t = (rawType ?? "").toLowerCase().trim();
  if (!t) return true;
  if (isMovie) return t === "movie";
  return ALLOWED_SERIES_TYPES.has(t);
}

function pickBestOttMatch(
  results: OttSearchItem[],
  queries: string[],
  year: number | undefined,
  isMovie: boolean,
  season: number,
): OttSearchItem | null {
  const compatible = results.filter((r) => r?.id != null && r?.title && isTypeCompatible(isMovie, r.type));
  if (compatible.length === 0) return null;

  const normQueries = queries.map((q) => normTitle(q)).filter(Boolean);
  let best: OttSearchItem | null = null;
  let bestScore = -1;

  for (const item of compatible) {
    const title = String(item.title ?? "");
    const itemNorm = normTitle(title);
    let score = 0;

    for (const nq of normQueries) {
      if (itemNorm === nq) score = Math.max(score, 1.0);
      else score = Math.max(score, titleSimilarity(title, nq));
    }

    const itemYear = parseInt(String(item.year ?? ""), 10);
    if (year && Number.isFinite(itemYear)) {
      const diff = Math.abs(itemYear - year);
      if (diff === 0) score += 0.15;
      else if (diff > 2) score -= 0.25;
    }

    const seasonMatch = title.match(/\bseason\s+(\d+)\b/i);
    if (!isMovie && season > 1 && seasonMatch) {
      const foundSeason = parseInt(seasonMatch[1], 10);
      if (foundSeason === season) score += 0.2;
      else score -= 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 0.45 ? best : null;
}

/**
 * Direct OneTouchTV Asian Drama extractor (`api3.devcorp.me` AES-256-CBC API -> HLS + softsubs).
 * Eliminates WebView2 sniffing for K-drama, C-drama, J-drama, Thai, and Southeast Asian titles.
 */
export const onetouchtvProvider: SourceProvider = {
  id: "onetouchtv",
  name: "OneTouchTV",
  category: "external",
  priority: 21,
  timeoutMs: 14_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("onetouchtv", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted || isAnimeRequest(req)) return [];
    const lang = (req.media as MediaDetail).originalLanguage?.toLowerCase();
    if (!lang || !ASIAN_DRAMA_LANGS.has(lang)) return [];

    try {
      const isMovie = req.media.kind === "movie";
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const baseTitle = req.media.title?.trim() || "";
      if (!baseTitle) return [];

      const keywords: string[] = [];
      if (!isMovie && season > 1) keywords.push(`${baseTitle} Season ${season}`);
      keywords.push(baseTitle);
      if (req.media.originalTitle && req.media.originalTitle !== baseTitle) {
        keywords.push(req.media.originalTitle);
      }

      let matched: OttSearchItem | null = null;
      for (const kw of keywords) {
        if (signal.aborted) return [];
        const list = await fetchOttEncrypted<OttSearchItem[]>(`/vod/search?keyword=${encodeURIComponent(kw)}`, signal);
        if (Array.isArray(list) && list.length > 0) {
          matched = pickBestOttMatch(list, [kw, baseTitle], req.media.year, isMovie, season);
          if (matched) break;
        }
      }
      if (!matched || matched.id == null || signal.aborted) return [];

      const detail = await fetchOttEncrypted<OttDetail>(`/vod/${matched.id}/detail`, signal);
      if (signal.aborted || !detail?.episodes?.length) return [];

      const targetEp = isMovie
        ? detail.episodes[0]
        : detail.episodes.find((e) => Math.round(Number(e.episode)) === episode) ?? null;
      if (!targetEp?.playId) return [];

      const streamData = await fetchOttEncrypted<OttEpisodeStreams>(
        `/vod/${matched.id}/episode/${targetEp.playId}`,
        signal,
      );
      if (signal.aborted || !streamData?.sources?.length) return [];

      const streamHeaders = buildStreamHeaders(`${MAIN_URL}/`, MAIN_URL);
      const subtitles = buildSubtitleTracks(
        (streamData.track ?? []).map((t) => ({
          url: t.file,
          lang: t.lang ?? t.name,
          label: t.name,
          isDefault: t.default,
        })),
        streamHeaders,
        MAIN_URL,
      );

      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const src of streamData.sources) {
        const rawUrl = src?.url?.trim();
        if (!rawUrl || !/^https?:\/\//i.test(rawUrl) || seen.has(rawUrl)) continue;
        seen.add(rawUrl);

        const q = normalizeQuality(src.quality);
        const kind = inferStreamKind(rawUrl, src.type);
        const srv = src.name?.trim();
        out.push({
          providerId: "onetouchtv",
          providerName: "OneTouchTV",
          label: `${matched.title ?? baseTitle}${isMovie ? "" : ` · Ep ${episode}`}${srv ? ` · ${srv}` : ""}${q ? ` · ${q}p` : ""}`,
          url: proxyUrl(rawUrl, streamHeaders, MAIN_URL),
          kind,
          via: "direct",
          pageUrl: `${REFERER_URL}`,
          headers: streamHeaders,
          subtitles,
          ...(q ? { quality: q } : {}),
        });
      }

      return out.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
