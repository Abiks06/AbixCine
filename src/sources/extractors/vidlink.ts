import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  buildSubtitleTracks,
  bytesToBase64Url,
  fetchJsonWithAbort,
  hexToBytes,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  normalizeQuality,
  resolveExtractorStreamHeaders,
  resolveMediaIds,
  xsalsa20Poly1305Seal,
} from "./common";
import { encDec } from "./encdec";

const VIDLINK_ORIGIN = "https://vidlink.pro";
const VIDLINK_KEY_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";
const VIDLINK_KEY = hexToBytes(VIDLINK_KEY_HEX);

interface VidLinkQualityEntry {
  url?: string;
  type?: string;
  headers?: Record<string, string>;
}

interface VidLinkCaption {
  url?: string;
  language?: string;
  lang?: string;
  label?: string;
  type?: string;
  default?: boolean;
}

interface VidLinkStreamBlock {
  playlist?: string;
  type?: string;
  qualities?: Record<string, VidLinkQualityEntry>;
  captions?: VidLinkCaption[];
  headers?: Record<string, string>;
}

interface VidLinkApiResponse {
  stream?: VidLinkStreamBlock;
  playlist?: string;
  qualities?: Record<string, VidLinkQualityEntry>;
  captions?: VidLinkCaption[];
}

/**
 * Encrypt a TMDB media ID into VidLink's SecretBox token using pure-TS XSalsa20-Poly1305.
 * Format: base64url(nonce[24] || SecretBox(key, nonce, utf8(mediaId) || uint64be(ts + 480))).
 */
export function encryptVidLinkToken(mediaId: string, nowMs = Date.now(), nonce?: Uint8Array): string {
  const timestamp = BigInt(Math.floor(nowMs / 1000) + 480);
  const idBytes = new TextEncoder().encode(mediaId);
  const msg = new Uint8Array(idBytes.length + 8);
  msg.set(idBytes, 0);
  new DataView(msg.buffer).setBigUint64(idBytes.length, timestamp, false);

  const iv = nonce && nonce.length === 24 ? nonce : crypto.getRandomValues(new Uint8Array(24));
  const sealed = xsalsa20Poly1305Seal(VIDLINK_KEY, iv, msg);
  const payload = new Uint8Array(iv.length + sealed.length);
  payload.set(iv, 0);
  payload.set(sealed, iv.length);
  return bytesToBase64Url(payload);
}

async function fetchEncVidLinkToken(mediaId: string, signal: AbortSignal): Promise<string | null> {
  try {
    const token = await encDec<string>("enc-vidlink", { query: { text: mediaId } }, signal, 5_000);
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch (err) {
    if (isAbortError(err) || signal.aborted) throw err;
    return null;
  }
}

function hasUsableVidLinkStream(data: VidLinkApiResponse | null): boolean {
  if (!data) return false;
  const stream = data.stream ?? data;
  if (typeof stream.playlist === "string" && /^https?:\/\//i.test(stream.playlist)) return true;
  return Object.values(stream.qualities ?? {}).some((q) => typeof q?.url === "string" && /^https?:\/\//i.test(q.url));
}

async function fetchVidLinkApi(
  token: string,
  isMovie: boolean,
  season: number,
  episode: number,
  pageUrl: string,
  signal: AbortSignal,
): Promise<VidLinkApiResponse | null> {
  const endpoint = isMovie
    ? `${VIDLINK_ORIGIN}/api/b/movie/${token}?multiLang=1`
    : `${VIDLINK_ORIGIN}/api/b/tv/${token}/${season}/${episode}?multiLang=1`;
  const res = await fetchJsonWithAbort<VidLinkApiResponse>(
    endpoint,
    {
      "User-Agent": DEFAULT_UA,
      Origin: VIDLINK_ORIGIN,
      Referer: pageUrl,
      "X-Playback-Environment": "standard",
      Accept: "application/json, text/plain, */*",
    },
    undefined,
    signal,
    8_000,
  );
  return res.data;
}

/**
 * Direct VidLink extractor (`vidlink.pro/api/b/...`) using local XSalsa20-Poly1305 token
 * signing with `enc-dec.app/api/enc-vidlink` fallback and CDN-safe stream headers.
 */
export const vidlinkProvider: SourceProvider = {
  id: "vidlink-direct",
  name: "VidLink",
  category: "external",
  priority: 25,
  timeoutMs: 14_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("vidlink-direct", s, ["vidlink"]),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const isMovie = isMovieRequest(req);
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const pageUrl = isMovie
        ? `${VIDLINK_ORIGIN}/movie/${meta.tmdbId}`
        : `${VIDLINK_ORIGIN}/tv/${meta.tmdbId}/${season}/${episode}`;

      let data = await fetchVidLinkApi(encryptVidLinkToken(meta.tmdbId), isMovie, season, episode, pageUrl, signal);
      if (!hasUsableVidLinkStream(data) && !signal.aborted) {
        const fallbackToken = await fetchEncVidLinkToken(meta.tmdbId, signal);
        if (fallbackToken && !signal.aborted) {
          data = await fetchVidLinkApi(fallbackToken, isMovie, season, episode, pageUrl, signal);
        }
      }
      if (signal.aborted || !data) return [];

      const stream: VidLinkStreamBlock = data.stream ?? data;
      const defaultHeaders = buildStreamHeaders(pageUrl, VIDLINK_ORIGIN);
      const captions = Array.isArray(stream.captions) ? stream.captions : [];
      const subtitles = buildSubtitleTracks(
        captions.map((c) => ({
          url: c.url,
          lang: c.language ?? c.lang,
          label: c.label ?? c.language ?? c.lang,
          isDefault: c.default,
        })),
        defaultHeaders,
        pageUrl,
      );

      const candidates: StreamCandidate[] = [];
      const seen = new Set<string>();

      const qualities = stream.qualities ?? {};
      const entries = Object.entries(qualities)
        .filter(([, v]) => typeof v?.url === "string" && /^https?:\/\//i.test(v.url))
        .sort((a, b) => (normalizeQuality(b[0]) ?? 0) - (normalizeQuality(a[0]) ?? 0));

      for (const [qKey, entry] of entries) {
        const rawUrl = entry.url!.trim();
        if (seen.has(rawUrl)) continue;
        seen.add(rawUrl);

        const q = normalizeQuality(qKey);
        const { headers: h, fallbackReferer } = resolveExtractorStreamHeaders(
          rawUrl,
          pageUrl,
          VIDLINK_ORIGIN,
          entry.headers ?? stream.headers,
        );
        const kind = inferStreamKind(rawUrl, entry.type);
        candidates.push({
          providerId: "vidlink-direct",
          providerName: "VidLink",
          label: `VidLink · ${q ? `${q}p` : qKey}${kind === "hls" ? " · HLS" : ""}`,
          url: fallbackReferer ? proxyUrl(rawUrl, h, fallbackReferer) : proxyUrl(rawUrl, h),
          kind,
          via: "direct",
          headers: h,
          subtitles,
          ...(q ? { quality: q } : {}),
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }

      if (typeof stream.playlist === "string" && /^https?:\/\//i.test(stream.playlist) && !seen.has(stream.playlist.trim())) {
        const rawUrl = stream.playlist.trim();
        const { headers: h, fallbackReferer } = resolveExtractorStreamHeaders(
          rawUrl,
          pageUrl,
          VIDLINK_ORIGIN,
          stream.headers,
        );
        candidates.push({
          providerId: "vidlink-direct",
          providerName: "VidLink",
          label: "VidLink · Auto · HLS",
          url: fallbackReferer ? proxyUrl(rawUrl, h, fallbackReferer) : proxyUrl(rawUrl, h),
          kind: inferStreamKind(rawUrl, stream.type ?? "hls"),
          via: "direct",
          headers: h,
          subtitles,
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }

      return candidates;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      // Unreachable or changed is an error, not "no results": the server's health has to see it.
      throw err;
    }
  },
};
