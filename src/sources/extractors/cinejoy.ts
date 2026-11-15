import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  base64ToBytes,
  buildStreamHeaders,
  buildSubtitleTracks,
  bytesToBase64Url,
  fetchBytesWithAbort,
  fetchJsonWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  resolveMediaIds,
  type ResolvedMediaIds,
} from "./common";
import { encDec } from "./encdec";

const CINEJOY_API = "https://api.wing.st";
const CINEJOY_SITE = "https://cinejoy.pk";
const SERVERS_TTL_MS = 30 * 60_000;
/** HLS servers tried in parallel, fastest first; MKV-only servers are a fallback. */
const PREFERRED_SERVERS = ["Nebula", "Lisbon", "Light"];
const FALLBACK_SERVERS = ["Orion"];
const MAX_PARALLEL = 3;

interface CinejoyServer {
  name?: string;
  status?: string;
}

interface CinejoyCaption {
  url?: string;
  language?: string;
  id?: string;
  type?: string;
}

interface CinejoyStream {
  type?: string;
  playlist?: string;
  captions?: CinejoyCaption[];
}

let serversCache: { names: string[]; at: number } | null = null;

/** Reset Cinejoy's cached server list (unit tests). */
export function clearCinejoyServerCache(): void {
  serversCache = null;
}

const HEADERS = {
  Accept: "*/*",
  Origin: CINEJOY_SITE,
  Referer: `${CINEJOY_SITE}/`,
  "User-Agent": DEFAULT_UA,
};

/** Order the live server list: preferred HLS servers first, then anything else, MKV servers last. */
export function orderCinejoyServers(live: string[]): string[] {
  const rank = (n: string) => {
    const p = PREFERRED_SERVERS.indexOf(n);
    if (p >= 0) return p;
    if (FALLBACK_SERVERS.includes(n)) return 100;
    return 50;
  };
  return [...new Set(live)].sort((a, b) => rank(a) - rank(b));
}

async function liveServers(signal: AbortSignal): Promise<string[]> {
  if (serversCache && Date.now() - serversCache.at < SERVERS_TTL_MS) return serversCache.names;
  try {
    const res = await fetchJsonWithAbort<{ servers?: CinejoyServer[] }>(`${CINEJOY_API}/servers`, HEADERS, undefined, signal, 6_000);
    const names = (res.data?.servers ?? [])
      .filter((s) => typeof s?.name === "string" && (!s.status || s.status === "ok"))
      .map((s) => s.name!.trim())
      .filter(Boolean);
    if (names.length) {
      serversCache = { names: orderCinejoyServers(names), at: Date.now() };
      return serversCache.names;
    }
  } catch (err) {
    if (isAbortError(err) || signal.aborted) throw err;
  }
  return [...PREFERRED_SERVERS, ...FALLBACK_SERVERS];
}

function buildQueryUrl(meta: ResolvedMediaIds, req: PlaybackRequest, server: string): string {
  const isMovie = isMovieRequest(req);
  const qs = new URLSearchParams({
    title: meta.title || meta.originalTitle || "",
    type: isMovie ? "movie" : "series",
    year: meta.year ? String(meta.year) : "",
    imdb: meta.imdbId ?? "",
    tmdb: meta.tmdbId ?? "",
    server,
  });
  if (!isMovie) {
    qs.set("season", String(req.season ?? 1));
    qs.set("episode", String(req.episode ?? 1));
  }
  return `${CINEJOY_API}/?${qs.toString()}`;
}

async function resolveServer(
  meta: ResolvedMediaIds,
  req: PlaybackRequest,
  server: string,
  signal: AbortSignal,
): Promise<CinejoyStream[]> {
  const enc = await encDec<{ data?: string; state?: unknown }>(
    "enc-cinejoy",
    { query: { url: buildQueryUrl(meta, req, server) } },
    signal,
  );
  if (!enc || typeof enc.data !== "string" || enc.state == null || signal.aborted) return [];

  const res = await fetchBytesWithAbort(
    `${CINEJOY_API}/g`,
    HEADERS,
    { method: "POST", bodyBytes: base64ToBytes(enc.data) },
    signal,
    8_000,
  );
  if (res.status < 200 || res.status >= 300 || res.bytes.length === 0 || signal.aborted) return [];

  const dec = await encDec<{ data?: { stream?: CinejoyStream[] }; status?: number }>(
    "dec-cinejoy",
    { json: { text: bytesToBase64Url(res.bytes), state: enc.state } },
    signal,
  );
  if (!dec || (dec.status != null && dec.status !== 200)) return [];
  return Array.isArray(dec.data?.stream) ? dec.data!.stream! : [];
}

/**
 * Direct Cinejoy extractor (`api.wing.st`, Movie & TV). The request and response are binary
 * envelopes encrypted with a per-request state from `enc-dec.app`. Some CDNs disguise playlists
 * as `image/jpeg`; every one of them needs `Referer: https://cinejoy.pk/`.
 */
export const cinejoyProvider: SourceProvider = {
  id: "cinejoy",
  name: "Cinejoy",
  category: "external",
  priority: 22.5,
  timeoutMs: 15_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("cinejoy", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    if (anime && (req.audio ?? "sub") === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId || !meta.title) return [];

      const ordered = await liveServers(signal);
      if (signal.aborted) return [];
      const primary = ordered.filter((n) => !FALLBACK_SERVERS.includes(n)).slice(0, MAX_PARALLEL);
      const fallback = ordered.filter((n) => FALLBACK_SERVERS.includes(n));

      type ServerResult = { name: string; streams: CinejoyStream[]; err?: unknown };
      const run = (names: string[]): Promise<ServerResult[]> =>
        Promise.all(
          names.map(async (name): Promise<ServerResult> => {
            try {
              return { name, streams: await resolveServer(meta, req, name, signal) };
            } catch (err) {
              if (isAbortError(err) || signal.aborted) throw err;
              return { name, streams: [], err };
            }
          }),
        );

      let results = await run(primary);
      if (!results.some((r) => r.streams.length) && fallback.length && !signal.aborted) {
        results = [...results, ...(await run(fallback))];
      }
      if (signal.aborted) return [];

      const headers = buildStreamHeaders(`${CINEJOY_SITE}/`, CINEJOY_SITE);
      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const { name, streams } of results) {
        for (const st of streams) {
          const raw = typeof st?.playlist === "string" ? st.playlist.trim() : "";
          if (!/^https?:\/\//i.test(raw) || seen.has(raw)) continue;
          seen.add(raw);
          const kind = inferStreamKind(raw, st.type);
          const subtitles = buildSubtitleTracks(
            (st.captions ?? []).map((c) => ({ url: c.url, lang: c.language ?? c.id, label: c.language ?? c.id })),
            headers,
            CINEJOY_SITE,
          );
          out.push({
            providerId: "cinejoy",
            providerName: "Cinejoy",
            label: `Cinejoy · ${name} · ${kind === "file" ? (st.type ?? "file").toUpperCase() : kind.toUpperCase()}`,
            url: proxyUrl(raw, headers, CINEJOY_SITE),
            kind,
            via: "direct",
            headers,
            subtitles,
            ...(anime ? { audio: "sub" as const } : {}),
          });
        }
      }

      // Every server failing with a transport error is an outage health should see; plain
      // "no stream for this title" stays an empty result.
      if (!out.length && results.length && results.every((r) => r.err !== undefined)) throw results[0].err;
      return out;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
