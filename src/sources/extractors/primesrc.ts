import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  fetchJsonWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  normalizeQuality,
  resolveMediaIds,
} from "./common";

const PRIMESRC_API = "https://primesrc.me";
const MAX_SERVERS = 6;

interface PrimeServerEntry {
  key?: string;
  name?: string;
  quality?: string | number;
}

interface PrimeServerListResponse {
  servers?: PrimeServerEntry[];
}

interface PrimeLinkResponse {
  link?: string;
}

/**
 * Direct PrimeSrc extractor (`primesrc.me`): IMDb-keyed multi-server JSON lookup
 * resolving direct HLS/MP4 links without WebView2 sniffing.
 */
export const primesrcProvider: SourceProvider = {
  id: "primesrc",
  name: "PrimeSrc",
  category: "external",
  priority: 22,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("primesrc", s),
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

      const apiHeaders = {
        Referer: `${PRIMESRC_API}/`,
        Origin: PRIMESRC_API,
        "User-Agent": DEFAULT_UA,
        Accept: "application/json, text/plain, */*",
      };

      const listRes = await fetchJsonWithAbort<PrimeServerListResponse>(
        `${PRIMESRC_API}/api/v1/s?${params.toString()}`,
        apiHeaders,
        undefined,
        signal,
        8_000,
      );
      if (signal.aborted) return [];

      const servers = (listRes.data?.servers ?? [])
        .filter((srv): srv is PrimeServerEntry & { key: string } => typeof srv?.key === "string" && srv.key.length > 0)
        .slice(0, MAX_SERVERS);
      if (servers.length === 0) return [];

      const streamHeaders = buildStreamHeaders(`${PRIMESRC_API}/`, PRIMESRC_API);
      const settled = await Promise.allSettled(
        servers.map(async (srv) => {
          const linkRes = await fetchJsonWithAbort<PrimeLinkResponse>(
            `${PRIMESRC_API}/api/v1/l?key=${encodeURIComponent(srv.key)}`,
            apiHeaders,
            undefined,
            signal,
            7_000,
          );
          const rawLink = typeof linkRes.data?.link === "string" ? linkRes.data.link.trim() : "";
          if (!rawLink || !/^https?:\/\//i.test(rawLink)) return null;

          const quality = normalizeQuality(srv.quality) ?? normalizeQuality(srv.name) ?? normalizeQuality(rawLink);
          const serverName = srv.name?.trim() || "Server";
          return {
            providerId: "primesrc",
            providerName: "PrimeSrc",
            label: `${serverName}${quality ? ` · ${quality}p` : ""}`,
            url: proxyUrl(rawLink, streamHeaders, PRIMESRC_API),
            kind: inferStreamKind(rawLink),
            via: "direct" as const,
            pageUrl: `${PRIMESRC_API}/`,
            headers: streamHeaders,
            ...(quality ? { quality } : {}),
            ...(anime ? { audio: "sub" as const } : {}),
          } satisfies StreamCandidate;
        }),
      );

      if (signal.aborted) return [];
      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const item of settled) {
        if (item.status !== "fulfilled" || !item.value) continue;
        if (seen.has(item.value.url)) continue;
        seen.add(item.value.url);
        out.push(item.value);
      }
      return out.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
