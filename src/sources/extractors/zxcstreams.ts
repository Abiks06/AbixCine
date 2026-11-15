import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl, type StreamHeaders } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  fetchJsonWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  normalizeQuality,
  openSslAes256CbcDecrypt,
  resolveExtractorStreamHeaders,
  resolveMediaIds,
} from "./common";

export const ZXC_BASE_URLS = ["https://zxcstream.cc", "https://zxcstream.com"] as const;
const SERVERS = ["ursa", "alatreon", "valstrax", "orion"] as const;
const ZXC_PASSPHRASE = "7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c";
const BASE_TTL_MS = 10 * 60_000;

export const ZXC_FIELD = {
  id: "a7f39c821d604e5b91e57b",
  fToken: "e83c4b719a5210579c1635a",
  ts: "61d9a5274c8e3b2f38291e6",
  token: "c492f7a183d01e36c538a716d",
  title: "5e28c9147a06de29f3674b392a1",
  year: "b731e6c94f867f8341c306e",
  season: "d8427b5c382f957c3613e85b",
  episode: "91c6ea75d1f785c92346b713d",
  imdbId: "f35a8194265e871c4933a725f",
  path: "6b491e258392e7561a9384c",
  mediaType: "c81306d28147a35632e816b",
  date: "e16493139e5814b3027",
  latestDate: "e953416ad739e5814b3027",
} as const;

const SERVER_LABELS: Record<(typeof SERVERS)[number], string> = {
  ursa: "Ursa",
  alatreon: "Alatreon",
  valstrax: "Valstrax",
  orion: "Orion",
};

interface AndromedaTokenResponse {
  ts?: number | string;
  token?: string;
  [key: string]: unknown;
}

interface ZxcLink {
  link?: string;
  type?: string;
  resolution?: number | string | null;
  source?: string;
  size?: number | string;
}

interface ZxcSourceResponse {
  success?: boolean;
  links?: ZxcLink[];
}

let cachedBase: string = ZXC_BASE_URLS[0];
let baseValidatedAt = 0;

/** Reset cached ZXCStreams active domain (intended for tests). */
export function clearZxcBaseCache(): void {
  cachedBase = ZXC_BASE_URLS[0];
  baseValidatedAt = 0;
}

/** Decrypt an encrypted `links[].link` value returned by `/backend_/sources/...`. */
export async function decryptZxcLink(rawLink: string): Promise<string | null> {
  const trimmed = rawLink.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("U2FsdGVkX1")) return null;
  const plain = await openSslAes256CbcDecrypt(trimmed, ZXC_PASSPHRASE);
  const url = plain?.trim() ?? "";
  return /^https?:\/\//i.test(url) ? url : null;
}

function formatSize(raw?: number | string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

function zxcCandidateHeaders(streamUrl: string, apiBase: string): { headers: StreamHeaders; fallback?: string } {
  // hakunaymatata.com CDN (Orion MP4) returns 429 with Referer/Origin and 428 with browser UAs.
  const { headers, fallbackReferer } = resolveExtractorStreamHeaders(streamUrl, `${apiBase}/`, apiBase);
  return fallbackReferer ? { headers, fallback: fallbackReferer } : { headers };
}

async function fetchServerToken(
  base: string,
  tmdbId: string,
  mediaType: "movie" | "tv",
  server: (typeof SERVERS)[number],
  season: number | undefined,
  episode: number | undefined,
  signal: AbortSignal,
): Promise<{ ts: string; token: string } | null> {
  const payload: Record<string, unknown> = {
    [ZXC_FIELD.id]: tmdbId,
    [ZXC_FIELD.mediaType]: mediaType,
    [ZXC_FIELD.path]: server,
  };
  if (mediaType === "tv" && season != null && episode != null) {
    payload[ZXC_FIELD.season] = Number(season);
    payload[ZXC_FIELD.episode] = Number(episode);
  }

  const res = await fetchJsonWithAbort<AndromedaTokenResponse>(
    `${base}/backend/andromeda`,
    {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json, text/plain, */*",
      Origin: base,
      Referer: `${base}/`,
      "Content-Type": "application/json",
    },
    { method: "POST", body: JSON.stringify(payload) },
    signal,
    8_000,
  );
  const token = typeof res.data?.token === "string" ? res.data.token.trim() : "";
  const ts = res.data?.ts != null ? String(res.data.ts).trim() : "";
  if (!token || !ts) return null;
  return { ts, token };
}

async function resolveFromBase(
  base: string,
  meta: Awaited<ReturnType<typeof resolveMediaIds>>,
  mediaType: "movie" | "tv",
  season: number | undefined,
  episode: number | undefined,
  anime: boolean,
  signal: AbortSignal,
): Promise<StreamCandidate[]> {
  const apiHeaders = {
    "User-Agent": DEFAULT_UA,
    Accept: "application/json, text/plain, */*",
    Origin: base,
    Referer: `${base}/`,
  };

  const settled = await Promise.allSettled(
    SERVERS.map(async (server): Promise<StreamCandidate[]> => {
      const tok = await fetchServerToken(base, meta.tmdbId!, mediaType, server, season, episode, signal);
      if (!tok || signal.aborted) return [];

      const params = new URLSearchParams({
        [ZXC_FIELD.id]: meta.tmdbId!,
        [ZXC_FIELD.path]: server,
        [ZXC_FIELD.mediaType]: mediaType,
        [ZXC_FIELD.ts]: tok.ts,
        [ZXC_FIELD.token]: tok.token,
        [ZXC_FIELD.title]: meta.title || "",
        [ZXC_FIELD.year]: meta.year ? String(meta.year) : "",
        [ZXC_FIELD.date]: meta.releaseDate || "",
      });
      if (meta.imdbId && /^tt\d+$/i.test(meta.imdbId)) {
        params.set(ZXC_FIELD.imdbId, meta.imdbId);
      }
      if (mediaType === "tv" && season != null && episode != null) {
        params.set(ZXC_FIELD.season, String(season));
        params.set(ZXC_FIELD.episode, String(episode));
      }

      const res = await fetchJsonWithAbort<ZxcSourceResponse>(
        `${base}/backend_/sources/${server}?${params.toString()}`,
        apiHeaders,
        undefined,
        signal,
        9_000,
      );
      if (!Array.isArray(res.data?.links) || res.data.links.length === 0) return [];

      const resolved = await Promise.all(
        res.data.links.map(async (l): Promise<StreamCandidate | null> => {
          if (typeof l?.link !== "string") return null;
          const decryptedUrl = await decryptZxcLink(l.link);
          if (!decryptedUrl) return null;

          const kind = inferStreamKind(decryptedUrl, l.type);
          const quality = normalizeQuality(l.resolution ?? l.source);
          const size = formatSize(l.size);
          const { headers, fallback } = zxcCandidateHeaders(decryptedUrl, base);
          const labelParts = [
            SERVER_LABELS[server],
            quality ? `${quality}p` : undefined,
            kind.toUpperCase(),
            size || undefined,
          ].filter(Boolean);

          return {
            providerId: "zxcstreams",
            providerName: "ZXCStreams",
            label: labelParts.join(" · "),
            url: fallback ? proxyUrl(decryptedUrl, headers, fallback) : proxyUrl(decryptedUrl, headers),
            kind,
            via: "direct" as const,
            headers,
            ...(quality ? { quality } : {}),
            ...(anime ? { audio: "sub" as const } : {}),
          } satisfies StreamCandidate;
        }),
      );

      return resolved.filter((c): c is StreamCandidate => c !== null);
    }),
  );

  const rejectedCount = settled.filter((r) => r.status === "rejected").length;
  const out: StreamCandidate[] = [];
  const seen = new Set<string>();
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const cand of item.value) {
      if (seen.has(cand.url)) continue;
      seen.add(cand.url);
      out.push(cand);
    }
  }

  if (out.length === 0 && rejectedCount === SERVERS.length) {
    const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    throw firstErr instanceof Error ? firstErr : new Error("ZXCStreams servers unreachable");
  }

  // Rank explicit higher quality first, preferring HLS > MP4 > DASH on quality ties.
  const kindRank: Record<StreamCandidate["kind"], number> = { hls: 3, file: 2, dash: 1, embed: 0 };
  return out.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || kindRank[b.kind] - kindRank[a.kind]);
}

/**
 * Direct ZXCStreams extractor (`zxcstream.cc` / `zxcstream.com`) using `/backend/andromeda`
 * token signing and OpenSSL AES-256-CBC link decryption across Ursa, Alatreon, Valstrax, and Orion.
 */
export const zxcstreamsProvider: SourceProvider = {
  id: "zxcstreams",
  name: "ZXCStreams",
  category: "external",
  priority: 24,
  timeoutMs: 14_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("zxcstreams", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const mediaType = isMovieRequest(req) ? "movie" : "tv";
      const season = mediaType === "tv" ? req.season ?? 1 : undefined;
      const episode = mediaType === "tv" ? req.episode ?? 1 : undefined;

      const freshCache = Date.now() - baseValidatedAt <= BASE_TTL_MS;
      const bases = freshCache
        ? [cachedBase, ...ZXC_BASE_URLS.filter((b) => b !== cachedBase)]
        : [...ZXC_BASE_URLS];

      let lastErr: unknown;
      for (const base of bases) {
        if (signal.aborted) return [];
        try {
          const out = await resolveFromBase(base, meta, mediaType, season, episode, anime, signal);
          if (out.length > 0) {
            cachedBase = base;
            baseValidatedAt = Date.now();
            return out;
          }
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return [];
          lastErr = err;
        }
      }

      if (lastErr) throw lastErr;
      return [];
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      // Unreachable or changed is an error, not "no results": the server's health has to see it.
      throw err;
    }
  },
};
