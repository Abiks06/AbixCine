import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, normalizeHeaders, proxyUrl } from "../native";
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
  normalizeQuality,
  resolveMediaIds,
  xsalsa20Poly1305Seal,
} from "./common";

const VIDLINK_ORIGIN = "https://vidlink.pro";
const VIDLINK_KEY_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";
const VIDLINK_KEY = hexToBytes(VIDLINK_KEY_HEX);
const ZERO_NONCE = new Uint8Array(24);

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
 * Format: base64url(nonce[24] || SecretBox(key, nonce=0, utf8(mediaId) || uint64be(ts + 480))).
 */
export function encryptVidLinkToken(mediaId: string, nowMs = Date.now()): string {
  const timestamp = BigInt(Math.floor(nowMs / 1000) + 480);
  const idBytes = new TextEncoder().encode(mediaId);
  const msg = new Uint8Array(idBytes.length + 8);
  msg.set(idBytes, 0);
  new DataView(msg.buffer).setBigUint64(idBytes.length, timestamp, false);

  const sealed = xsalsa20Poly1305Seal(VIDLINK_KEY, ZERO_NONCE, msg);
  const payload = new Uint8Array(ZERO_NONCE.length + sealed.length);
  payload.set(ZERO_NONCE, 0);
  payload.set(sealed, ZERO_NONCE.length);
  return bytesToBase64Url(payload);
}

function pickEntryHeaders(
  raw: Record<string, string> | undefined,
  fallback: ReturnType<typeof buildStreamHeaders>,
) {
  if (!raw) return fallback;
  const referer = raw.Referer ?? raw.referer;
  const origin = raw.Origin ?? raw.origin;
  const ua = raw["User-Agent"] ?? raw.ua;
  return normalizeHeaders(
    {
      referer: referer ?? fallback.referer,
      origin: origin ?? fallback.origin,
      ua: ua ?? fallback.ua,
    },
    referer ?? VIDLINK_ORIGIN,
  );
}

/**
 * Direct VidLink extractor (`vidlink.pro/api/b/...`) using local XSalsa20-Poly1305 token
 * signing (zero `enc-dec.app` dependency, zero WebView2 sniffing).
 */
export const vidlinkProvider: SourceProvider = {
  id: "vidlink-direct",
  name: "VidLink",
  category: "external",
  priority: 25,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("vidlink-direct", s, ["vidlink"]),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const token = encryptVidLinkToken(meta.tmdbId);
      const isMovie = req.media.kind === "movie";
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const endpoint = isMovie
        ? `${VIDLINK_ORIGIN}/api/b/movie/${token}?multiLang=1`
        : `${VIDLINK_ORIGIN}/api/b/tv/${token}/${season}/${episode}?multiLang=1`;

      const res = await fetchJsonWithAbort<VidLinkApiResponse>(
        endpoint,
        {
          "User-Agent": DEFAULT_UA,
          Origin: VIDLINK_ORIGIN,
          Referer: `${VIDLINK_ORIGIN}/`,
          Accept: "application/json, text/plain, */*",
        },
        undefined,
        signal,
        10_000,
      );
      if (signal.aborted || !res.data) return [];

      const stream: VidLinkStreamBlock = res.data.stream ?? res.data;
      const defaultHeaders = buildStreamHeaders(`${VIDLINK_ORIGIN}/`, VIDLINK_ORIGIN);
      const captions = Array.isArray(stream.captions) ? stream.captions : [];
      const subtitles = buildSubtitleTracks(
        captions.map((c) => ({
          url: c.url,
          lang: c.language ?? c.lang,
          label: c.label ?? c.language ?? c.lang,
          isDefault: c.default,
        })),
        defaultHeaders,
        VIDLINK_ORIGIN,
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
        const h = pickEntryHeaders(entry.headers ?? stream.headers, defaultHeaders);
        const kind = inferStreamKind(rawUrl, entry.type);
        candidates.push({
          providerId: "vidlink-direct",
          providerName: "VidLink",
          label: `VidLink · ${q ? `${q}p` : qKey}${kind === "hls" ? " · HLS" : ""}`,
          url: proxyUrl(rawUrl, h, h.referer ?? VIDLINK_ORIGIN),
          kind,
          via: "direct",
          pageUrl: `${VIDLINK_ORIGIN}/${isMovie ? "movie" : "tv"}/${meta.tmdbId}`,
          headers: h,
          subtitles,
          ...(q ? { quality: q } : {}),
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }

      if (typeof stream.playlist === "string" && /^https?:\/\//i.test(stream.playlist) && !seen.has(stream.playlist.trim())) {
        const rawUrl = stream.playlist.trim();
        const h = pickEntryHeaders(stream.headers, defaultHeaders);
        candidates.push({
          providerId: "vidlink-direct",
          providerName: "VidLink",
          label: "VidLink · Auto · HLS",
          url: proxyUrl(rawUrl, h, h.referer ?? VIDLINK_ORIGIN),
          kind: inferStreamKind(rawUrl, stream.type ?? "hls"),
          via: "direct",
          pageUrl: `${VIDLINK_ORIGIN}/${isMovie ? "movie" : "tv"}/${meta.tmdbId}`,
          headers: h,
          subtitles,
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }

      return candidates;
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
