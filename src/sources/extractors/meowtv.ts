import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildSubtitleTracks,
  fetchJsonWithAbort,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  resolveExtractorStreamHeaders,
  resolveMediaIds,
  type RawSubtitleInput,
} from "./common";
import { encDec } from "./encdec";

const MEOW_API = "https://api.meowtv.ru";
const MEOW_SITE = "https://meowtv.ru";
/** Original-audio servers in preference order. Each try needs a fresh single-use ticket. */
const MEOW_SERVERS = ["english", "acme"] as const;
/** The subtitle feed lists ~125 tracks with many duplicates per language; keep a sane number. */
const MAX_SUBS_PER_LABEL = 2;
const MAX_SUBS = 48;

interface MeowStream {
  language?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface MeowSub {
  label?: string;
  file?: string;
}

const BASE_HEADERS = {
  "User-Agent": DEFAULT_UA,
  Origin: MEOW_SITE,
  Referer: `${MEOW_SITE}/`,
  Accept: "application/json",
};

/** Keep at most `MAX_SUBS_PER_LABEL` tracks per language label and `MAX_SUBS` overall. */
export function trimMeowSubtitles(subs: MeowSub[]): RawSubtitleInput[] {
  const perLabel = new Map<string, number>();
  const out: RawSubtitleInput[] = [];
  for (const sub of subs) {
    if (typeof sub?.file !== "string" || !sub.file) continue;
    const label = (sub.label ?? "").trim() || "Unknown";
    const n = perLabel.get(label) ?? 0;
    if (n >= MAX_SUBS_PER_LABEL) continue;
    perLabel.set(label, n + 1);
    out.push({ url: sub.file, label: n ? `${label} ${n + 1}` : label, lang: label });
    if (out.length >= MAX_SUBS) break;
  }
  return out;
}

/**
 * Direct MeowTV extractor (`api.meowtv.ru`, Movie & TV): single-use stream ticket, encrypted
 * stream payload decrypted by `enc-dec.app`, and a separate VTT subtitle feed.
 */
export const meowtvProvider: SourceProvider = {
  id: "meowtv",
  name: "MeowTV",
  category: "external",
  priority: 21.5,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("meowtv", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    if (anime && (req.audio ?? "sub") === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const isMovie = isMovieRequest(req);
      const path = isMovie
        ? `movie/${meta.tmdbId}`
        : `tv/${meta.tmdbId}/${req.season ?? 1}/${req.episode ?? 1}`;

      // Subtitles don't need a ticket, so fetch them alongside the stream.
      const subsPromise = fetchJsonWithAbort<MeowSub[]>(`${MEOW_API}/subs/${path}`, BASE_HEADERS, undefined, signal, 6_000)
        .then((r) => (Array.isArray(r.data) ? r.data : []))
        .catch(() => [] as MeowSub[]);

      let stream: MeowStream | null = null;
      for (const server of MEOW_SERVERS) {
        if (signal.aborted) return [];
        const ticket = await fetchJsonWithAbort<{ ticket?: string }>(
          `${MEOW_API}/streams/ticket`,
          BASE_HEADERS,
          { method: "POST" },
          signal,
          6_000,
        );
        const t = typeof ticket.data?.ticket === "string" ? ticket.data.ticket : "";
        if (!t) return [];

        const res = await fetchWithAbort(
          `${MEOW_API}/streams/${path}?s=${encodeURIComponent(server)}`,
          { ...BASE_HEADERS, "X-Stream-Ticket": t },
          undefined,
          signal,
          7_000,
        );
        if (signal.aborted) return [];
        if (res.status === 404) return []; // title not on MeowTV at all
        if (res.status < 200 || res.status >= 300) continue;

        let data: unknown;
        try {
          data = JSON.parse(res.body);
        } catch {
          continue;
        }
        const dec = await encDec<MeowStream>("dec-meowtv", { json: { data } }, signal);
        if (dec && typeof dec.url === "string" && /^https?:\/\//i.test(dec.url.trim())) {
          stream = dec;
          break;
        }
      }
      if (!stream || signal.aborted) return [];

      const raw = stream.url!.trim();
      const explicit = stream.headers && Object.keys(stream.headers).length ? stream.headers : undefined;
      const { headers, fallbackReferer } = resolveExtractorStreamHeaders(raw, `${MEOW_SITE}/`, MEOW_SITE, explicit);
      const subs = await subsPromise;
      if (signal.aborted) return [];
      const subtitles = buildSubtitleTracks(trimMeowSubtitles(subs), headers, MEOW_SITE);
      const kind = inferStreamKind(raw);

      return [
        {
          providerId: "meowtv",
          providerName: "MeowTV",
          label: `MeowTV · ${stream.language?.trim() || "Original"} · ${kind.toUpperCase()}`,
          url: fallbackReferer ? proxyUrl(raw, headers, fallbackReferer) : proxyUrl(raw, headers),
          kind,
          via: "direct",
          headers,
          subtitles,
          ...(anime ? { audio: "sub" as const } : {}),
        },
      ];
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
