import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, normalizeHeaders, proxyUrl, type StreamHeaders } from "../native";
import { pickTitleMatch, matchTargetFor } from "../titleMatch";
import type { SourceProvider, StreamCandidate, StreamKind } from "../types";
import {
  buildSubtitleTracks,
  fetchJsonWithAbort,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  normalizeQuality,
  resolveMediaIds,
  type RawSubtitleInput,
} from "./common";

const FLIXNEST_BASE = "https://free.flixnest.app";
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const PAYWALL_OR_BAIT_RX = /(?:payments\.stravo|paywall|subscribe|bigbuckbunny|sample[-_.]?video|\/error\.m3u8|\/placeholder\b)/i;

interface FlixnestStreamItem {
  name?: string;
  title?: string;
  url?: string;
  externalUrl?: string;
  subtitles?: RawSubtitleInput[];
  behaviorHints?: {
    filename?: string;
    notWebReady?: boolean;
    videoSize?: number;
    proxyHeaders?: {
      request?: Record<string, string>;
    };
  };
}

interface CinemetaSearchMeta {
  id?: string;
  imdb_id?: string;
  type?: string;
  name?: string;
  releaseInfo?: string;
}

function extractReleaseYear(text: string): number | undefined {
  const clean = text.replace(/\b(?:2160|1440|1080|720|540|480)p?\b/gi, " ");
  const m = clean.match(/(?:^|[^0-9])((?:19|20)\d{2})(?=$|[^0-9])/);
  if (!m) return undefined;
  const y = Number(m[1]);
  return y >= 1900 && y <= 2099 ? y : undefined;
}

function parseFilenameEpisode(text: string): { season: number; episode: number; last?: number } | null {
  const m = text.match(/\bs(\d{1,2})[ ._-]*e(\d{1,4})(?:[ ._-]*-?[ ._-]*e(\d{1,4}))?(?!\d)/i)
    ?? text.match(/(?<![a-z\d])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?\b/i);
  if (!m) return null;
  const season = Number(m[1]);
  const episode = Number(m[2]);
  const last = m[3] ? Number(m[3]) : undefined;
  return Number.isFinite(season) && Number.isFinite(episode) ? { season, episode, last } : null;
}

function filenameMatchesRequest(
  hintText: string,
  req: PlaybackRequest,
  isMovie: boolean,
): boolean {
  if (!hintText.trim()) return true;
  if (isMovie) {
    const reqYear = req.media.year;
    const candYear = extractReleaseYear(hintText);
    if (reqYear != null && candYear != null && Math.abs(candYear - reqYear) > 1) return false;
    return true;
  }
  const ep = parseFilenameEpisode(hintText);
  if (ep) {
    const wantSeason = req.season ?? 1;
    const wantEpisode = req.episode ?? 1;
    if (ep.season !== wantSeason) return false;
    if (wantEpisode < ep.episode || wantEpisode > (ep.last ?? ep.episode)) return false;
  }
  return true;
}

function extractStandardProxyHeaders(reqHeaders?: Record<string, string>): StreamHeaders {
  if (!reqHeaders || typeof reqHeaders !== "object") return {};
  let referer: string | undefined;
  let origin: string | undefined;
  let ua: string | undefined;
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const lower = k.toLowerCase().trim();
    if (lower === "referer" || lower === "referrer") referer = v.trim();
    else if (lower === "origin") origin = v.trim();
    else if (lower === "user-agent" || lower === "ua") ua = v.trim();
  }
  if (!referer && !origin && !ua) return {};
  return normalizeHeaders({ referer, origin, ua }, referer ?? origin);
}

function inferFlixnestKind(rawUrl: string, filename?: string): StreamKind {
  const cleanUrl = rawUrl.split(/[?#]/)[0].toLowerCase();
  const cleanName = (filename ?? "").split(/[?#]/)[0].toLowerCase();
  if (cleanUrl.endsWith(".m3u8") || cleanName.endsWith(".m3u8")) return "hls";
  if (cleanUrl.endsWith(".mpd") || cleanName.endsWith(".mpd")) return "dash";
  return "file";
}

function containerBadge(rawUrl: string, filename?: string, kind?: StreamKind): string {
  const target = `${filename ?? ""} ${rawUrl.split(/[?#]/)[0]}`.toLowerCase();
  if (kind === "hls" || /\.m3u8\b/.test(target)) return "HLS";
  if (kind === "dash" || /\.mpd\b/.test(target)) return "DASH";
  const m = target.match(/\.(mkv|mp4|webm|avi|mov|m4v)\b/);
  return m ? m[1].toUpperCase() : "HTTP";
}

async function resolveFlixnestImdbId(
  req: PlaybackRequest,
  isMovie: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  const meta = await resolveMediaIds(req, signal);
  if (signal.aborted) return null;
  if (meta.imdbId && /^tt\d+$/i.test(meta.imdbId)) return meta.imdbId.toLowerCase();

  const searchTitle = (meta.title || req.media.originalTitle || "").trim();
  if (!searchTitle) return null;

  const catalogType = isMovie ? "movie" : "series";
  const url = `${CINEMETA_BASE}/catalog/${catalogType}/top/search=${encodeURIComponent(searchTitle)}.json`;
  const res = await fetchJsonWithAbort<{ metas?: CinemetaSearchMeta[] }>(
    url,
    { Accept: "application/json", "User-Agent": DEFAULT_UA },
    undefined,
    signal,
    6_000,
  ).catch(() => null);
  if (signal.aborted || !res?.data?.metas?.length) return null;

  const picked = pickTitleMatch(res.data.metas, matchTargetFor(req), (m) => ({
    titles: [m.name],
    year: extractReleaseYear(m.releaseInfo ?? ""),
    kind: m.type === "movie" ? "movie" : "tv",
    imdbId: m.imdb_id ?? m.id,
  }));
  const rawId = picked?.item.imdb_id ?? picked?.item.id;
  return rawId && /^tt\d+$/i.test(rawId.trim()) ? rawId.trim().toLowerCase() : null;
}

/**
 * Direct FlixNest extractor (`free.flixnest.app`), serving multi-mirror direct HTTP/MKV/MP4
 * and HLS streams keyed on IMDb id without requiring Debrid credentials.
 */
export const flixnestProvider: SourceProvider = {
  id: "flixnest",
  name: "FlixNest",
  category: "external",
  priority: 26,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("flixnest", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    const anime = isAnimeRequest(req);
    if (anime && req.audio === "dub") return [];
    if (signal.aborted) return [];

    try {
      const isMovie = isMovieRequest(req);
      const imdbId = await resolveFlixnestImdbId(req, isMovie, signal);
      if (signal.aborted || !imdbId) return [];

      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const endpoint = isMovie
        ? `${FLIXNEST_BASE}/stream/movie/${encodeURIComponent(imdbId)}.json`
        : `${FLIXNEST_BASE}/stream/series/${encodeURIComponent(imdbId)}:${season}:${episode}.json`;

      const res = await fetchJsonWithAbort<{ streams?: FlixnestStreamItem[] }>(
        endpoint,
        { Accept: "application/json", "User-Agent": DEFAULT_UA },
        undefined,
        signal,
        10_000,
      );
      if (signal.aborted || !res.data || !Array.isArray(res.data.streams)) return [];

      const seen = new Set<string>();
      const out: StreamCandidate[] = [];

      for (const stream of res.data.streams) {
        if (!stream || stream.externalUrl || typeof stream.url !== "string") continue;
        const rawUrl = stream.url.trim();
        if (!/^https?:\/\//i.test(rawUrl) || PAYWALL_OR_BAIT_RX.test(rawUrl)) continue;

        const hintFilename = stream.behaviorHints?.filename?.trim() || "";
        const hintTitle = (stream.title ?? "").split("\n")[0]?.trim() || "";
        const verifyText = hintFilename || hintTitle;
        if (!filenameMatchesRequest(verifyText, req, isMovie)) continue;

        const headers = extractStandardProxyHeaders(stream.behaviorHints?.proxyHeaders?.request);
        const hasHeaders = Boolean(headers.referer || headers.origin || headers.ua);
        const finalUrl = hasHeaders ? proxyUrl(rawUrl, headers) : rawUrl;
        if (seen.has(finalUrl)) continue;
        seen.add(finalUrl);

        const kind = inferFlixnestKind(rawUrl, hintFilename);
        const quality =
          normalizeQuality(stream.name)
          ?? normalizeQuality(hintFilename)
          ?? normalizeQuality(stream.title);
        const notWebReady = Boolean(stream.behaviorHints?.notWebReady);
        const badge = containerBadge(rawUrl, hintFilename, kind);
        const sourceTag = (stream.name ?? "").replace(/\b(2160|1440|1080|720|480)p\b/gi, "").trim();
        const labelParts = ["FlixNest", sourceTag || undefined, quality ? `${quality}p` : undefined, badge].filter(Boolean);
        const subtitles = buildSubtitleTracks(stream.subtitles, headers, FLIXNEST_BASE);

        out.push({
          providerId: "flixnest",
          providerName: "FlixNest",
          label: labelParts.join(" · "),
          url: finalUrl,
          kind,
          via: "direct",
          ...(hasHeaders ? { headers } : {}),
          ...(quality ? { quality } : {}),
          ...(notWebReady ? { notWebReady: true } : {}),
          ...(typeof stream.behaviorHints?.videoSize === "number" && stream.behaviorHints.videoSize > 0
            ? { sizeBytes: stream.behaviorHints.videoSize }
            : {}),
          ...(subtitles.length ? { subtitles } : {}),
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }

      return out.sort(
        (a, b) => Number(Boolean(a.notWebReady)) - Number(Boolean(b.notWebReady)) || (b.quality ?? 0) - (a.quality ?? 0),
      );
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
