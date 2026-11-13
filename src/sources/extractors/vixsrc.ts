import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchJsonWithAbort,
  fetchWithAbort,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  resolveMediaIds,
  type RawSubtitleInput,
} from "./common";

const BASE_URL = "https://vixsrc.to";

interface VixApiResponse {
  src?: string;
}

export interface VixTokenData {
  token: string;
  expires: string;
  playlist: string;
  canPlayFhd: boolean;
}

/** Normalize `/playlist/12345` -> `/playlist/12345.m3u8` and assemble signed master URL. */
export function buildVixMasterUrl(data: VixTokenData): string {
  let raw = data.playlist.trim();
  let hadB = false;
  try {
    const u = new URL(raw);
    if (u.pathname.includes("/playlist/")) {
      const parts = u.pathname.split("/");
      const idx = parts.indexOf("playlist");
      if (idx >= 0 && idx < parts.length - 1) {
        const leaf = parts[idx + 1];
        if (leaf && !leaf.includes(".")) {
          parts[idx + 1] = `${leaf}.m3u8`;
          u.pathname = parts.join("/");
        }
      }
    }
    hadB = u.searchParams.get("b") === "1";
    u.search = "";
    if (hadB) u.searchParams.set("b", "1");
    u.searchParams.set("token", data.token);
    u.searchParams.set("expires", data.expires);
    if (data.canPlayFhd) u.searchParams.set("h", "1");
    return u.toString();
  } catch {
    hadB = /([?&])b=1(?!\d)/.test(raw);
    const sep = raw.includes("?") ? "&" : "?";
    const params = [
      ...(hadB ? ["b=1"] : []),
      `token=${encodeURIComponent(data.token)}`,
      `expires=${encodeURIComponent(data.expires)}`,
      ...(data.canPlayFhd ? ["h=1"] : []),
    ];
    return `${raw}${sep}${params.join("&")}`;
  }
}

/** Extract signed playlist parameters from VixSrc/VixCloud embed HTML. */
export function extractVixTokenData(html: string, now = Date.now()): VixTokenData | null {
  const token = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1];
  const expires = html.match(/['"]?expires['"]?\s*:\s*['"](\d+)['"]/)?.[1];
  const playlist = html.match(/url\s*:\s*['"](https?:\/\/[^'"]+)['"]/)?.[1];
  if (!token || !expires || !playlist) return null;

  const expiresMs = parseInt(expires, 10) * 1000;
  if (!Number.isFinite(expiresMs) || expiresMs - 60_000 < now) return null;

  const canPlayFhd = /window\.canPlayFHD\s*=\s*true/.test(html);
  return { token, expires, playlist, canPlayFhd };
}

/** Parse VixSrc master HLS playlist for max video height, subtitle tracks, and audio languages. */
export function parseVixMasterPlaylist(
  manifest: string,
  masterUrl: string,
): { quality?: number; subtitles: RawSubtitleInput[]; audioLangs: string[] } {
  let quality: number | undefined;
  for (const m of manifest.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/g)) {
    const h = parseInt(m[1], 10);
    if (Number.isFinite(h) && h > (quality ?? 0)) quality = h;
  }

  const subtitles: RawSubtitleInput[] = [];
  const audioLangs: string[] = [];

  for (const line of manifest.split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1]?.toLowerCase();
      if (lang && !audioLangs.includes(lang)) audioLangs.push(lang);
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES")) {
      const rawUri = line.match(/URI="([^"]+)"/)?.[1];
      if (!rawUri) continue;
      let resolved = rawUri;
      try {
        resolved = new URL(rawUri, masterUrl).toString();
      } catch {
        /* keep raw URI */
      }
      const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1];
      const label = line.match(/NAME="([^"]+)"/)?.[1];
      const isDefault = /DEFAULT=YES/i.test(line);
      const isForced = /FORCED=YES/i.test(line);
      subtitles.push({ url: resolved, lang, label, isDefault, isForced });
    }
  }

  return { quality, subtitles, audioLangs };
}

/**
 * Direct VixSrc / VixCloud extractor (`vixsrc.to`), ported from `Inside4ndroid/TMDB-Embed-API`,
 * `webstreamr`, and `streamvix`.
 */
export const vixsrcProvider: SourceProvider = {
  id: "vixsrc",
  name: "VixSrc",
  category: "external",
  priority: 23.5,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("vixsrc", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const isMovie = req.media.kind === "movie";
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const apiUrl = isMovie
        ? `${BASE_URL}/api/movie/${meta.tmdbId}`
        : `${BASE_URL}/api/tv/${meta.tmdbId}/${season}/${episode}`;
      const pageFallbackUrl = isMovie
        ? `${BASE_URL}/movie/${meta.tmdbId}`
        : `${BASE_URL}/tv/${meta.tmdbId}/${season}/${episode}`;

      const apiHeaders = {
        "User-Agent": DEFAULT_UA,
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
      };

      const apiRes = await fetchJsonWithAbort<VixApiResponse>(apiUrl, apiHeaders, undefined, signal, 7_000);
      if (signal.aborted) return [];

      const embedPath = apiRes.data?.src;
      const embedUrl = embedPath ? new URL(embedPath, BASE_URL).toString() : pageFallbackUrl;

      const htmlRes = await fetchWithAbort(
        embedUrl,
        {
          "User-Agent": DEFAULT_UA,
          Accept: "text/html,application/xhtml+xml,*/*",
          Referer: apiUrl,
          Origin: BASE_URL,
        },
        undefined,
        signal,
        8_000,
      );
      if (signal.aborted || htmlRes.status < 200 || htmlRes.status >= 300) return [];

      const tokenData = extractVixTokenData(htmlRes.body);
      if (!tokenData) return [];

      const masterUrl = buildVixMasterUrl(tokenData);
      const streamHeaders = buildStreamHeaders(apiUrl, BASE_URL);

      const playlistRes = await fetchWithAbort(
        masterUrl,
        {
          "User-Agent": DEFAULT_UA,
          Accept: "application/vnd.apple.mpegurl, */*",
          Referer: apiUrl,
          Origin: BASE_URL,
        },
        undefined,
        signal,
        7_000,
      );
      if (signal.aborted || playlistRes.status < 200 || playlistRes.status >= 300) return [];
      if (!playlistRes.body.trimStart().startsWith("#EXTM3U")) return [];

      const parsed = parseVixMasterPlaylist(playlistRes.body, masterUrl);
      if (!parsed.quality && !/#EXT-X-STREAM-INF|#EXTINF/i.test(playlistRes.body)) return [];

      const subtitles = buildSubtitleTracks(parsed.subtitles, streamHeaders, apiUrl);
      const langTag = parsed.audioLangs.length > 0 ? ` · ${parsed.audioLangs.join("/").toUpperCase()}` : "";

      return [
        {
          providerId: "vixsrc",
          providerName: "VixSrc",
          label: `VixSrc${parsed.quality ? ` · ${parsed.quality}p` : ""}${langTag}`,
          url: proxyUrl(masterUrl, streamHeaders, apiUrl),
          kind: "hls",
          via: "direct",
          pageUrl: embedUrl,
          headers: streamHeaders,
          subtitles,
          ...(parsed.quality ? { quality: parsed.quality } : {}),
          ...(anime ? { audio: "sub" as const } : {}),
        },
      ];
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
