import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchJsonWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  resolveMediaIds,
} from "./common";

const VAPLAYER_API = "https://streamdata.vaplayer.ru/api.php";
const PLAYER_ORIGIN = "https://nextgencloudfabric.com";

interface VaPlayerSub {
  url?: string;
  lang?: string;
  code?: string;
  label?: string;
  default?: boolean;
}

interface VaPlayerResponse {
  status_code?: number | string;
  error?: string;
  data?: {
    stream_urls?: string[];
  };
  default_subs?: VaPlayerSub[];
}

/**
 * Direct VaPlayer extractor (`streamdata.vaplayer.ru`): single-roundtrip IMDb-keyed JSON
 * returning HLS stream URLs and subtitle tracks.
 */
export const vaplayerProvider: SourceProvider = {
  id: "vaplayer",
  name: "VaPlayer",
  category: "external",
  priority: 23,
  timeoutMs: 10_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("vaplayer", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.imdbId || !/^tt\d+$/i.test(meta.imdbId)) return [];

      const isTv = req.media.kind !== "movie";
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const params = new URLSearchParams({
        imdb: meta.imdbId,
        type: isTv ? "tv" : "movie",
      });
      if (isTv) {
        params.set("season", String(season));
        params.set("episode", String(episode));
      }

      const referer = isTv
        ? `${PLAYER_ORIGIN}/embed/tv/${meta.imdbId}/${season}/${episode}`
        : `${PLAYER_ORIGIN}/embed/movie/${meta.imdbId}`;

      const res = await fetchJsonWithAbort<VaPlayerResponse>(
        `${VAPLAYER_API}?${params.toString()}`,
        {
          "User-Agent": DEFAULT_UA,
          Referer: referer,
          Origin: PLAYER_ORIGIN,
          Accept: "application/json, text/plain, */*",
        },
        undefined,
        signal,
        9_000,
      );
      if (signal.aborted || !res.data) return [];

      const code = res.data.status_code;
      if (code != null && code !== 200 && code !== "200") return [];

      const urls = Array.isArray(res.data.data?.stream_urls) ? res.data.data.stream_urls : [];
      const streamHeaders = buildStreamHeaders(`${PLAYER_ORIGIN}/`, PLAYER_ORIGIN);
      const subtitles = buildSubtitleTracks(
        (res.data.default_subs ?? []).map((sub) => ({
          url: sub.url,
          lang: sub.lang || sub.code,
          label: sub.label || sub.lang || sub.code,
          isDefault: sub.default,
        })),
        streamHeaders,
        PLAYER_ORIGIN,
      );

      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (let i = 0; i < urls.length; i++) {
        const rawUrl = typeof urls[i] === "string" ? urls[i].trim() : "";
        if (!rawUrl || !/^https?:\/\//i.test(rawUrl) || seen.has(rawUrl)) continue;
        seen.add(rawUrl);

        out.push({
          providerId: "vaplayer",
          providerName: "VaPlayer",
          label: `${isTv ? `S${season}E${episode} · ` : ""}HLS ${out.length + 1}`,
          url: proxyUrl(rawUrl, streamHeaders, PLAYER_ORIGIN),
          kind: inferStreamKind(rawUrl, "hls"),
          via: "direct",
          pageUrl: referer,
          headers: streamHeaders,
          subtitles,
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }
      return out;
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
