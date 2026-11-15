import { resolveCourEpisodeMapping } from "../../lib/animeMapping";
import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { malIdFor } from "../anime-direct";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  aes256CbcDecrypt,
  base64ToBytes,
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchJsonWithAbort,
  fetchWithAbort,
  isAbortError,
  isDirectExtractorEnabled,
  type RawSubtitleInput,
} from "./common";

export const MEGAPLAY_ORIGIN = "https://megaplay.buzz";
const DEFAULT_ENC_PAIR = { key: "i?LMTAx0Q6,:}50U", iv: "W0;27ToaUpl_P%'c" };

interface MegaPlayTrack {
  file?: string;
  label?: string;
  kind?: string;
  default?: boolean;
}

interface MegaPlaySourcePayload {
  sources?: { file?: string } | { file?: string }[];
  tracks?: MegaPlayTrack[];
  enc?: string;
  intro?: { start?: number; end?: number };
  outro?: { start?: number; end?: number };
}

function make32ByteKey(rawKey: string): Uint8Array {
  const keyBytes = new Uint8Array(32);
  keyBytes.set(new TextEncoder().encode(rawKey).subarray(0, 32));
  return keyBytes;
}

/** Decrypt the MegaPlay AES-256-CBC `enc` payload (base64url, zero-padded key) using known key+IV pairs. */
export async function decryptMegaPlayEnc(
  enc: string,
  pairs: { key: string; iv: string }[] = [DEFAULT_ENC_PAIR],
): Promise<{ file?: string } | null> {
  if (!enc || enc.length > 65_536) return null;
  let cipherBytes: Uint8Array;
  try {
    cipherBytes = base64ToBytes(enc);
  } catch {
    return null;
  }

  for (const pair of pairs) {
    const ivBytes = new TextEncoder().encode(pair.iv);
    if (ivBytes.length !== 16) continue;
    const text = await aes256CbcDecrypt(make32ByteKey(pair.key), ivBytes, cipherBytes);
    if (!text || !text.includes("http")) continue;
    try {
      const obj = JSON.parse(text) as { file?: string };
      if (obj && typeof obj.file === "string") return obj;
    } catch {
      /* try next key pair */
    }
  }
  return null;
}

/** The player's internal content id: `#megaplay-player[data-id]`, or `<title>File 123 - MegaPlay</title>`. */
export function extractMegaPlayContentId(html: string): string | null {
  return (
    html.match(/<[^>]*\bid=["']megaplay-player["'][^>]*\bdata-id=["']([^"']+)["']/i)?.[1] ??
    html.match(/<[^>]*\bdata-id=["']([^"']+)["'][^>]*\bid=["']megaplay-player["']/i)?.[1] ??
    html.match(/<title>\s*File\s+(\d+)\s*-\s*MegaPlay\s*<\/title>/i)?.[1] ??
    html.match(/\bdata-id=["']([^"']+)["']/i)?.[1] ??
    null
  );
}

/**
 * Resolve a MegaPlay-style embed page (`/stream/...`) into a playable candidate: content id →
 * `getSourcesNew` (falling back to `getSources`) → locally decrypted `enc` → HLS + VTTs + skip ranges.
 * Shared by the standalone MegaPlay extractor and Anikoto (whose servers embed the same player).
 */
export async function resolveMegaPlayEmbed(
  embedUrl: string,
  opts: { providerId: string; providerName: string; serverName: string; audio: "sub" | "dub"; referer: string },
  signal: AbortSignal,
): Promise<StreamCandidate | null> {
  const { audio } = opts;
  const origin = new URL(embedUrl).origin;
  const embedRes = await fetchWithAbort(
    embedUrl,
    { Referer: opts.referer, "User-Agent": DEFAULT_UA },
    undefined,
    signal,
    8_000,
  );
  if (signal.aborted || embedRes.status < 200 || embedRes.status >= 300) return null;

  const embedAudio = embedUrl.match(/\/(sub|dub)(?:[/?#]|$)/i)?.[1]?.toLowerCase();
  if (embedAudio && embedAudio !== audio) return null;

  const dataId = extractMegaPlayContentId(embedRes.body);
  if (!dataId) return null;

  const cdn = embedUrl.match(/[?&]s=([\w-]+)/)?.[1] ?? "";
  let payload: MegaPlaySourcePayload | null = null;

  for (const path of ["stream/getSourcesNew", "stream/getSources"]) {
    if (signal.aborted) return null;
    const srcRes = await fetchJsonWithAbort<MegaPlaySourcePayload>(
      `${origin}/${path}?id=${encodeURIComponent(dataId)}${cdn ? `&s=${encodeURIComponent(cdn)}` : ""}`,
      {
        Referer: embedUrl,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": DEFAULT_UA,
      },
      undefined,
      signal,
      8_000,
    );
    if (!srcRes.data) continue;
    if (!srcRes.data.sources && srcRes.data.enc) {
      const decoded = await decryptMegaPlayEnc(String(srcRes.data.enc));
      if (decoded?.file) srcRes.data.sources = { file: decoded.file };
    }
    if (srcRes.data.sources) {
      payload = srcRes.data;
      break;
    }
  }
  if (!payload?.sources) return null;

  const rawFile = Array.isArray(payload.sources) ? payload.sources[0]?.file : payload.sources.file;
  if (!rawFile || !/^https?:\/\//i.test(rawFile)) return null;

  const streamHeaders = buildStreamHeaders(`${origin}/`, origin);
  const rawSubs: RawSubtitleInput[] = (payload.tracks ?? [])
    .filter((t) => typeof t?.file === "string" && (!t.kind || t.kind === "captions" || t.kind === "subtitles"))
    .map((t) => ({ url: t.file, label: t.label, kind: t.kind, isDefault: t.default }));
  const subtitles = buildSubtitleTracks(rawSubs, streamHeaders, origin);

  const range = (r?: { start?: number; end?: number }): [number, number] | undefined =>
    typeof r?.start === "number" && typeof r?.end === "number" && r.end > r.start ? [r.start, r.end] : undefined;
  const intro = range(payload.intro);
  const outro = range(payload.outro);

  return {
    providerId: opts.providerId,
    providerName: opts.providerName,
    label: `${opts.serverName} · ${audio === "dub" ? "English dub" : "Japanese · subtitled"}`,
    url: proxyUrl(rawFile, streamHeaders, origin),
    kind: "hls",
    via: "direct",
    headers: streamHeaders,
    audio,
    subtitles,
    ...(intro || outro ? { skip: { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) } } : {}),
  };
}

function isAnimeTarget(req: PlaybackRequest): boolean {
  return (
    req.media.kind === "anime"
    || req.media.key.startsWith("anilist:")
    || Boolean((req as { isAnimeMovie?: boolean }).isAnimeMovie)
    || Boolean((req.media as { isAnimeMovie?: boolean }).isAnimeMovie)
  );
}

/**
 * Standalone MegaPlay anime extractor (`megaplay.buzz/stream/{mal|ani}/{id}/{ep}/{sub|dub}`).
 * Keyed by MAL/AniList id, so it needs no site search and runs independently of Anikoto's mirrors.
 */
export const megaplayProvider: SourceProvider = {
  id: "megaplay",
  name: "MegaPlay",
  category: "external",
  priority: 25.5,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("megaplay", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (!isAnimeTarget(req) || signal.aborted) return [];
    const audio = req.audio ?? "sub";

    try {
      let mal: number | null = req.media.malId ?? null;
      let anilist: number | null =
        req.media.anilistId ?? (Number(req.media.key.match(/^anilist:(\d+)$/)?.[1]) || null);
      let ep = req.courEpisode;
      if (!mal || (ep == null && req.media.key.startsWith("tmdb:"))) {
        const mapped = await resolveCourEpisodeMapping(req, signal);
        if (signal.aborted) return [];
        mal = mal ?? mapped.malId ?? null;
        anilist = anilist ?? mapped.anilistId ?? null;
        if (ep == null && (mapped.malId || mapped.anilistId)) ep = mapped.courEpisode;
      }
      if (!mal && !anilist) mal = await malIdFor(req, signal);
      if ((!mal && !anilist) || signal.aborted) return [];
      const episode = ep ?? req.episode ?? 1;

      const targets = [
        ...(mal ? [`${MEGAPLAY_ORIGIN}/stream/mal/${mal}/${episode}/${audio}`] : []),
        ...(anilist ? [`${MEGAPLAY_ORIGIN}/stream/ani/${anilist}/${episode}/${audio}`] : []),
      ];
      // A failure on the MAL route must not skip the AniList route; only an all-error run is an error.
      let lastErr: unknown;
      let anyAnswered = false;
      for (const url of targets) {
        if (signal.aborted) return [];
        try {
          const cand = await resolveMegaPlayEmbed(
            url,
            { providerId: "megaplay", providerName: "MegaPlay", serverName: "MegaPlay", audio, referer: `${MEGAPLAY_ORIGIN}/` },
            signal,
          );
          if (cand) return [cand];
          anyAnswered = true;
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return [];
          lastErr = err;
        }
      }
      if (!anyAnswered && lastErr) throw lastErr;
      return [];
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
