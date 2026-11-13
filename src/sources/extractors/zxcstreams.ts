import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, normalizeHeaders, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  fetchJsonWithAbort,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  normalizeQuality,
  resolveMediaIds,
  sha512Hex,
} from "./common";

const PORTALS = ["https://zxcstream.xyz", "https://zxcprime.xyz"] as const;
const INITIAL_BASE = "https://r1.zxcstream.xyz";
const SALT = "3435443433";
const SERVERS = ["icarus", "berkas", "orion", "athena"] as const;
const PROBE_SUBDOMAINS = ["r1", "r2", "r3", "r4", "r5", "r6", "v4", "cdn", "api", "stream"] as const;
const BASE_TTL_MS = 10 * 60_000;

const FIELD = {
  id: "rgrwsdsdfgwrwrwwr",
  fToken: "xfgdfgdsffgrwgrwyjhkjt",
  ts: "rdghhdghhfssft",
  token: "ZDDVHJFGHYRHG",
  title: "TUKTHFSSFGDGHJS",
  year: "53653TRFG647GF",
  season: "adkljfhdahfladhfjahfjlahfhfljkadfdf",
  episode: "546745ygy46ytfgty",
  imdbId: "564745ygtuy5yi75yuy",
} as const;

const SERVER_LABELS: Record<(typeof SERVERS)[number], string> = {
  icarus: "Icarus",
  berkas: "Berkas",
  orion: "Orion",
  athena: "Athena",
};

interface ZxcTokenResponse {
  [key: string]: unknown;
}

interface ZxcLink {
  link?: string;
  type?: string;
  resolution?: number | string;
  source?: string;
  size?: number | string;
}

interface ZxcServerResponse {
  success?: boolean;
  links?: ZxcLink[];
}

let cachedBase = INITIAL_BASE;
let baseValidatedAt = 0;
let discoveryPromise: Promise<string> | null = null;

/** Reset cached ZXCStreams discovered base URL (intended for tests). */
export function clearZxcBaseCache(): void {
  cachedBase = INITIAL_BASE;
  baseValidatedAt = 0;
  discoveryPromise = null;
}

/** Generate ZXCStreams SHA-512 frontend token for a TMDB ID and timestamp. */
export async function generateZxcFrontendToken(tmdbId: string, rt = Date.now()): Promise<{ xt: string; rt: number }> {
  const hash = await sha512Hex(`${rt}:${SALT}:${tmdbId}`);
  return { xt: hash.slice(0, 64), rt };
}

async function verifyBase(base: string, signal?: AbortSignal): Promise<string> {
  const { xt, rt } = await generateZxcFrontendToken("550");
  const res = await fetchJsonWithAbort<ZxcTokenResponse>(
    `${base}/backend/token`,
    {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json, text/plain, */*",
      Origin: base,
      Referer: `${base}/player/movie/550`,
      "Content-Type": "application/json",
    },
    {
      method: "POST",
      body: JSON.stringify({ [FIELD.id]: "550", [FIELD.fToken]: xt, [FIELD.ts]: rt }),
    },
    signal,
    6_000,
  );
  if (res.data && res.data[FIELD.token]) return base;
  throw new Error(`ZXCStreams verify failed (${res.status}) for ${base}`);
}

async function tryPortal(portal: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchWithAbort(
    portal,
    { "User-Agent": DEFAULT_UA },
    undefined,
    signal,
    8_000,
  );
  const finalOrigin = new URL(res.url || portal).origin;
  if (finalOrigin === new URL(portal).origin) {
    throw new Error(`Portal ${portal} did not redirect`);
  }
  return verifyBase(finalOrigin, signal);
}

async function discoverBase(signal?: AbortSignal): Promise<string> {
  const portalResults = await Promise.allSettled(PORTALS.map((p) => tryPortal(p, signal)));
  for (const r of portalResults) {
    if (r.status === "fulfilled") return r.value;
  }
  if (signal?.aborted) return cachedBase;

  const subResults = await Promise.allSettled(
    PROBE_SUBDOMAINS.map((sub) => verifyBase(`https://${sub}.zxcstream.xyz`, signal)),
  );
  for (const r of subResults) {
    if (r.status === "fulfilled") return r.value;
  }
  return cachedBase;
}

async function getBase(signal?: AbortSignal): Promise<string> {
  if (Date.now() - baseValidatedAt <= BASE_TTL_MS) return cachedBase;
  if (!discoveryPromise) {
    discoveryPromise = discoverBase(signal)
      .then((base) => {
        cachedBase = base;
        baseValidatedAt = Date.now();
        return base;
      })
      .finally(() => {
        discoveryPromise = null;
      });
  }
  return discoveryPromise;
}

async function requestServerToken(
  base: string,
  tmdbId: string,
  referer: string,
  signal?: AbortSignal,
): Promise<{ serverToken: string; serverTs: string; xt: string }> {
  const { xt, rt } = await generateZxcFrontendToken(tmdbId);
  const res = await fetchJsonWithAbort<ZxcTokenResponse>(
    `${base}/backend/token`,
    {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json, text/plain, */*",
      Origin: base,
      Referer: referer,
      "Content-Type": "application/json",
    },
    {
      method: "POST",
      body: JSON.stringify({ [FIELD.id]: tmdbId, [FIELD.fToken]: xt, [FIELD.ts]: rt }),
    },
    signal,
    8_000,
  );
  const token = res.data?.[FIELD.token];
  const ts = res.data?.[FIELD.ts];
  if (typeof token !== "string" || !token || ts == null) {
    throw new Error(`ZXCStreams token failed (${res.status})`);
  }
  return { serverToken: token, serverTs: String(ts), xt };
}

function formatSize(raw?: number | string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/**
 * Direct ZXCStreams extractor (`zxcstream.xyz` / `zxcprime.xyz`) with local SHA-512 signing
 * across Icarus, Berkas, Orion, and Athena servers.
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
      if (signal.aborted || !meta.tmdbId || !meta.title || !meta.imdbId || !/^tt\d+$/i.test(meta.imdbId)) {
        return [];
      }

      const type = req.media.kind === "movie" ? "movie" : "tv";
      const season = type === "tv" ? req.season ?? 1 : undefined;
      const episode = type === "tv" ? req.episode ?? 1 : undefined;
      const buildReferer = (b: string) =>
        `${b}/player/${type}/${meta.tmdbId}${season != null ? `/${season}/${episode}` : ""}`;

      let base = await getBase(signal);
      if (signal.aborted) return [];

      let referer = buildReferer(base);
      let tokenData: { serverToken: string; serverTs: string; xt: string };
      try {
        tokenData = await requestServerToken(base, meta.tmdbId, referer, signal);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return [];
        baseValidatedAt = 0;
        base = await getBase(signal);
        if (signal.aborted) return [];
        referer = buildReferer(base);
        tokenData = await requestServerToken(base, meta.tmdbId, referer, signal);
      }
      if (signal.aborted) return [];

      const params = new URLSearchParams({
        [FIELD.id]: meta.tmdbId,
        b: type,
        [FIELD.ts]: tokenData.serverTs,
        [FIELD.token]: tokenData.serverToken,
        [FIELD.fToken]: tokenData.xt,
        [FIELD.title]: meta.title,
        [FIELD.year]: meta.year ? String(meta.year) : "",
        date: meta.releaseDate,
        [FIELD.imdbId]: meta.imdbId,
      });
      if (season != null && episode != null) {
        params.set(FIELD.season, String(season));
        params.set(FIELD.episode, String(episode));
      }

      const qs = params.toString();
      const streamHeaders = buildStreamHeaders(referer, base);
      const settled = await Promise.allSettled(
        SERVERS.map(async (server) => {
          const res = await fetchJsonWithAbort<ZxcServerResponse>(
            `${base}/backend_/servers/${server}?${qs}`,
            {
              "User-Agent": DEFAULT_UA,
              Accept: "application/json, text/plain, */*",
              Origin: base,
              Referer: referer,
            },
            undefined,
            signal,
            9_000,
          );
          if (!res.data?.success || !Array.isArray(res.data.links)) return [];
          return res.data.links
            .filter((l): l is ZxcLink & { link: string } => typeof l?.link === "string" && /^https?:\/\//i.test(l.link))
            .map((l) => {
              const kind = inferStreamKind(l.link, l.type);
              const quality = normalizeQuality(l.resolution ?? l.source);
              const size = formatSize(l.size);
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
                url: proxyUrl(l.link, streamHeaders, referer),
                kind,
                via: "direct" as const,
                pageUrl: referer,
                headers: normalizeHeaders(streamHeaders, referer),
                ...(quality ? { quality } : {}),
                ...(anime ? { audio: "sub" as const } : {}),
              } satisfies StreamCandidate;
            });
        }),
      );

      if (signal.aborted) return [];
      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const item of settled) {
        if (item.status !== "fulfilled") continue;
        for (const cand of item.value) {
          if (seen.has(cand.url)) continue;
          seen.add(cand.url);
          out.push(cand);
        }
      }
      return out.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
