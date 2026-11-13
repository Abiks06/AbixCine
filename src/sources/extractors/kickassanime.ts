import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  buildSubtitleTracks,
  decodeHtmlEntities,
  fetchJsonWithAbort,
  fetchWithAbort,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  titleSimilarity,
  type RawSubtitleInput,
} from "./common";

const BASE_URL = "https://kaa.lt";
const SUB_LOCALES = ["ja-JP", "zh-CN", "ko-KR"] as const;
const DUB_LOCALE = "en-US";

interface KaaCard {
  sid: string;
  titles: string[];
  type: string;
  year: number;
  eps: number;
  locales: string[];
}

interface KaaSearchResponse {
  result?: {
    slug?: string;
    title?: string;
    title_en?: string;
    type?: string;
    year?: number | string;
    episode_count?: number | string;
    locales?: unknown[];
  }[];
}

interface KaaEpisodesResponse {
  result?: {
    episode_number?: number | string;
    slug?: string;
    title?: string;
  }[];
}

interface KaaEpisodeDetailResponse {
  servers?: {
    name?: string;
    src?: string;
  }[];
}

/** Decode Astro's serialized `astro-island[props]` tuple representation (`[0, obj]` / `[1, arr]`). */
export function decodeAstroProps(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const tag = value[0];
  const payload = value[1];
  if (tag === 1) {
    return Array.isArray(payload) ? payload.map((item) => decodeAstroProps(item)) : [];
  }
  if (tag === 0 && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      obj[k] = decodeAstroProps(v);
    }
    return obj;
  }
  return payload;
}

function fixUrl(raw: unknown): string {
  return (typeof raw === "string" ? raw.trim() : "")
    .replace(/^\/\/(?=[^/])/, "https://")
    .replace(/^(https?:)\/{3,}/i, "$1//");
}

/** Parse `<astro-island props="...">` player HTML for `.m3u8` manifest and softsubs. */
export function parseKaaPlayerHtml(html: string): { m3u8: string; subs: RawSubtitleInput[] } {
  const empty = { m3u8: "", subs: [] as RawSubtitleInput[] };
  const match = html.match(/<astro-island[^>]*\bprops="([^"]+)"/i) ?? html.match(/<astro-island[^>]*\bprops='([^']+)'/i);
  if (!match) return empty;

  let rawProps: unknown;
  try {
    rawProps = JSON.parse(decodeHtmlEntities(match[1]));
  } catch {
    return empty;
  }

  const decoded = decodeAstroProps([0, rawProps]) as Record<string, unknown> | null;
  if (!decoded || typeof decoded !== "object") return empty;

  const m3u8 = fixUrl(decoded.manifest);
  if (!/^https?:\/\/[^/]+\/.*\.m3u8(?:[?#]|$)/i.test(m3u8)) return empty;

  const subs: RawSubtitleInput[] = [];
  if (Array.isArray(decoded.subtitles)) {
    for (const t of decoded.subtitles) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      const src = fixUrl(tr.src);
      if (!/^https?:\/\/[^/]/i.test(src)) continue;
      subs.push({
        url: src,
        lang: typeof tr.language === "string" ? tr.language : undefined,
        label: typeof tr.name === "string" ? tr.name : undefined,
      });
    }
  }

  return { m3u8, subs };
}

function pickLocale(locales: string[], audio: "sub" | "dub"): string | null {
  if (audio === "dub") return locales.includes(DUB_LOCALE) ? DUB_LOCALE : null;
  for (const loc of SUB_LOCALES) {
    if (locales.includes(loc)) return loc;
  }
  const fallback = locales.find((l) => l !== DUB_LOCALE);
  return fallback ?? null;
}

function pickBestKaaCard(cards: KaaCard[], req: PlaybackRequest, audio: "sub" | "dub"): { card: KaaCard; locale: string } | null {
  const targets = [req.media.title, req.media.originalTitle].filter((t): t is string => Boolean(t?.trim()));
  const year = req.media.year ?? 0;
  const isMovie = req.media.kind === "movie";

  let best: { card: KaaCard; locale: string; score: number } | null = null;
  for (const card of cards) {
    const locale = pickLocale(card.locales, audio);
    if (!locale) continue;

    let sim = 0;
    for (const ct of card.titles) {
      for (const target of targets) {
        sim = Math.max(sim, titleSimilarity(ct, target));
      }
    }

    if (year > 0 && card.year > 0) {
      const diff = Math.abs(card.year - year);
      if (diff === 0) sim += 0.1;
      else if (diff > 2) sim -= 0.35;
    }

    const ct = card.type.toLowerCase();
    if (isMovie && ct === "tv") sim -= 0.25;
    if (!isMovie && ct === "movie") sim -= 0.25;

    if (!best || sim > best.score) {
      best = { card, locale, score: sim };
    }
  }

  return best && best.score >= 0.45 ? { card: best.card, locale: best.locale } : null;
}

/**
 * Direct KickAssAnime extractor (`kaa.lt` JSON API -> `.m3u8` + softsubs, sub & dub).
 * Ported from `aquaryuo/seanime` (MIT).
 */
export const kickassanimeProvider: SourceProvider = {
  id: "kickassanime",
  name: "KickAssAnime",
  category: "external",
  priority: 24.5,
  timeoutMs: 14_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("kickassanime", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (!isAnimeRequest(req) || signal.aborted) return [];

    try {
      const ep = req.courEpisode ?? req.episode ?? 1;
      const audio = req.audio ?? "sub";
      const apiHeaders = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        "User-Agent": DEFAULT_UA,
      };

      const queries = Array.from(
        new Set(
          [req.media.originalTitle, req.media.title]
            .filter((q): q is string => Boolean(q?.trim())),
        ),
      ).slice(0, 2);

      const cards: KaaCard[] = [];
      const seenSid = new Set<string>();
      for (const q of queries) {
        if (signal.aborted) return [];
        const res = await fetchJsonWithAbort<KaaSearchResponse>(
          `${BASE_URL}/api/fsearch`,
          apiHeaders,
          { method: "POST", body: JSON.stringify({ page: 1, query: q }) },
          signal,
          8_000,
        );
        for (const it of res.data?.result ?? []) {
          if (!it?.slug || seenSid.has(it.slug)) continue;
          seenSid.add(it.slug);
          const titles = Array.from(new Set([it.title, it.title_en].filter((t): t is string => Boolean(t?.trim()))));
          if (titles.length === 0) continue;
          cards.push({
            sid: it.slug,
            titles,
            type: String(it.type ?? ""),
            year: Math.max(0, parseInt(String(it.year ?? "0"), 10) || 0),
            eps: Math.max(0, parseInt(String(it.episode_count ?? "0"), 10) || 0),
            locales: Array.isArray(it.locales) ? it.locales.filter((l): l is string => typeof l === "string") : [],
          });
        }
        if (cards.length > 0 && pickBestKaaCard(cards, req, audio)) break;
      }

      const picked = pickBestKaaCard(cards, req, audio);
      if (!picked || signal.aborted) return [];

      const epsRes = await fetchJsonWithAbort<KaaEpisodesResponse>(
        `${BASE_URL}/api/show/${picked.card.sid}/episodes?ep=${ep}&lang=${encodeURIComponent(picked.locale)}`,
        { Accept: "application/json", Referer: `${BASE_URL}/`, "User-Agent": DEFAULT_UA },
        undefined,
        signal,
        8_000,
      );
      if (signal.aborted) return [];

      const epEntry = (epsRes.data?.result ?? []).find((e) => Number(e?.episode_number) === ep && typeof e?.slug === "string");
      if (!epEntry?.slug) return [];

      const detailRes = await fetchJsonWithAbort<KaaEpisodeDetailResponse>(
        `${BASE_URL}/api/show/${picked.card.sid}/episode/ep-${ep}-${epEntry.slug}`,
        { Accept: "application/json", Referer: `${BASE_URL}/`, "User-Agent": DEFAULT_UA },
        undefined,
        signal,
        8_000,
      );
      if (signal.aborted) return [];

      const servers = (detailRes.data?.servers ?? [])
        .filter((s): s is { name?: string; src: string } => typeof s?.src === "string" && /^https:\/\//i.test(s.src) && !/[?&]type=dash\b/i.test(s.src))
        .sort((a, b) => (/vidstream/i.test(b.name ?? "") ? 1 : 0) - (/vidstream/i.test(a.name ?? "") ? 1 : 0));

      for (const srv of servers.slice(0, 2)) {
        if (signal.aborted) return [];
        const playerUrl = srv.src.replace("/cat-player/vast?", "/cat-player/player?");
        const playerOrigin = new URL(playerUrl).origin;
        const playerRes = await fetchWithAbort(
          playerUrl,
          { Referer: `${BASE_URL}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          8_000,
        );
        if (playerRes.status < 200 || playerRes.status >= 300) continue;

        const parsed = parseKaaPlayerHtml(playerRes.body);
        if (!parsed.m3u8) continue;

        const streamHeaders = buildStreamHeaders(`${playerOrigin}/`, playerOrigin);
        const subtitles = buildSubtitleTracks(parsed.subs, streamHeaders, playerOrigin);
        return [
          {
            providerId: "kickassanime",
            providerName: "KickAssAnime",
            label: `Episode ${ep}${srv.name ? ` · ${srv.name}` : ""} · ${audio === "dub" ? "English dub" : "Japanese · subtitled"}`,
            url: proxyUrl(parsed.m3u8, streamHeaders, playerOrigin),
            kind: "hls",
            via: "direct",
            pageUrl: `${BASE_URL}/${picked.card.sid}/ep-${ep}-${epEntry.slug}`,
            headers: streamHeaders,
            audio,
            subtitles,
          },
        ];
      }

      return [];
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
