import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl, type StreamHeaders } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  buildSubtitleTracks,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  resolveMediaIds,
  type RawSubtitleInput,
} from "./common";
import { encDec } from "./encdec";

const VIDUP_ORIGIN = "https://vidup.to";
/** Each server costs two round trips; the first few cover every audio variant seen so far. */
const MAX_SERVERS = 3;

interface VidupServer {
  name?: string;
  description?: string;
  data?: string;
}

interface VidupTrack {
  file?: string;
  url?: string;
  label?: string;
  lang?: string;
  language?: string;
  kind?: string;
  default?: boolean;
}

interface VidupStream {
  url?: string;
  noReferrer?: boolean;
  mp4?: boolean;
  tracks?: VidupTrack[];
}

/** The page embeds its content token inside an escaped RSC/JSON payload (`\"en\":\"…\"`). */
export function extractVidupToken(html: string): string | null {
  const m =
    html.match(/\\"(?:en|token)\\":\\"(.*?)\\"/) ??
    html.match(/"(?:en|token)"\s*:\s*"([A-Za-z0-9_\-.~+/=]{16,})"/);
  return m?.[1]?.trim() || null;
}

/** Only follow stage URLs that point back at vidup itself (they come from a third-party service). */
function isVidupUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "vidup.to" || u.hostname.endsWith(".vidup.to"));
  } catch {
    return false;
  }
}

/**
 * Direct Vidup extractor (`vidup.to`, Movie & TV). Two-stage token exchange plus encrypted
 * server/stream responses, all handled by `enc-dec.app`. Streams need `Referer: https://vidup.to/`.
 */
export const vidupProvider: SourceProvider = {
  id: "vidup",
  name: "Vidup",
  category: "external",
  priority: 22.5,
  timeoutMs: 16_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("vidup", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    if (anime && (req.audio ?? "sub") === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const isMovie = isMovieRequest(req);
      const pageUrl = isMovie
        ? `${VIDUP_ORIGIN}/movie/${meta.tmdbId}/`
        : `${VIDUP_ORIGIN}/tv/${meta.tmdbId}/${req.season ?? 1}/${req.episode ?? 1}/`;

      const page = await fetchWithAbort(pageUrl, { "User-Agent": DEFAULT_UA, Referer: `${VIDUP_ORIGIN}/` }, undefined, signal, 8_000);
      if (signal.aborted || page.status < 200 || page.status >= 300) return [];
      const contentToken = extractVidupToken(page.body);
      if (!contentToken) return [];

      const apiHeaders = (csrf: string) => ({
        "User-Agent": DEFAULT_UA,
        Referer: `${VIDUP_ORIGIN}/`,
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": csrf,
      });
      const post = async (url: string, csrf: string) => {
        const res = await fetchWithAbort(url, apiHeaders(csrf), { method: "POST" }, signal, 8_000);
        return res.status >= 200 && res.status < 300 && res.body.trim() ? res.body.trim() : null;
      };

      const stage1 = await encDec<{ stage1?: string; token?: string }>(
        "enc-vidup",
        { query: { text: contentToken, stage: "1" } },
        signal,
      );
      if (!stage1 || !isVidupUrl(stage1.stage1) || signal.aborted) return [];
      const stage1Text = await post(stage1.stage1, stage1.token ?? "");
      if (!stage1Text || signal.aborted) return [];

      const stage2 = await encDec<{ servers?: string; stream?: string; token?: string }>(
        "enc-vidup",
        { query: { text: stage1Text, stage: "2" } },
        signal,
      );
      if (!stage2 || !isVidupUrl(stage2.servers) || !isVidupUrl(stage2.stream) || signal.aborted) return [];
      const csrf = stage2.token ?? "";
      const streamBase = stage2.stream.replace(/\/+$/, "");

      const serversEnc = await post(stage2.servers, csrf);
      if (!serversEnc || signal.aborted) return [];
      const servers = await encDec<VidupServer[]>("dec-vidup", { json: { text: serversEnc } }, signal);
      const usable = (Array.isArray(servers) ? servers : [])
        .filter((srv) => typeof srv?.data === "string" && /^[\w-]+$/.test(srv.data))
        .slice(0, MAX_SERVERS);
      if (!usable.length || signal.aborted) return [];

      const resolved = await Promise.all(
        usable.map(async (srv) => {
          try {
            const enc = await post(`${streamBase}/${srv.data}`, csrf);
            if (!enc || signal.aborted) return null;
            const stream = await encDec<VidupStream>("dec-vidup", { json: { text: enc } }, signal);
            return stream && typeof stream.url === "string" ? { srv, stream } : null;
          } catch (err) {
            if (isAbortError(err) || signal.aborted) throw err;
            return null;
          }
        }),
      );
      if (signal.aborted) return [];

      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const item of resolved) {
        if (!item) continue;
        const raw = item.stream.url!.trim();
        if (!/^https?:\/\//i.test(raw) || seen.has(raw)) continue;
        seen.add(raw);
        const headers: StreamHeaders = item.stream.noReferrer
          ? { ua: DEFAULT_UA }
          : buildStreamHeaders(`${VIDUP_ORIGIN}/`, VIDUP_ORIGIN);
        const kind = item.stream.mp4 ? "file" : inferStreamKind(raw);
        const subtitles = buildSubtitleTracks(
          (item.stream.tracks ?? []).map((t): RawSubtitleInput => ({
            url: t.file ?? t.url,
            lang: t.lang ?? t.language,
            label: t.label ?? t.language ?? t.lang,
            kind: t.kind,
            isDefault: t.default,
          })),
          headers,
          VIDUP_ORIGIN,
        );
        const name = (item.srv.name ?? "").trim();
        out.push({
          providerId: "vidup",
          providerName: "Vidup",
          label: `Vidup${name ? ` · ${name}` : ""} · ${kind.toUpperCase()}`,
          url: item.stream.noReferrer ? proxyUrl(raw, headers) : proxyUrl(raw, headers, VIDUP_ORIGIN),
          kind,
          via: "direct",
          headers,
          subtitles,
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }
      return out;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
