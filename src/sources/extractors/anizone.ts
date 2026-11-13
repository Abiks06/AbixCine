import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  buildSubtitleTracks,
  decodeHtmlEntities,
  fetchWithAbort,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  titleSimilarity,
  unescapeJsString,
  type RawSubtitleInput,
} from "./common";

const BASE_URL = "https://anizone.to";

interface AnizoneCard {
  sid: string;
  titles: string[];
  type: string;
  year: number;
  eps: number;
}

interface AnizonePlayerData {
  m3u8: string;
  subs: RawSubtitleInput[];
}

/** Parse `items: JSON.parse('...')` cards from AniZone search HTML. */
export function parseAnizoneCards(html: string): AnizoneCard[] {
  const m = /items:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html);
  if (!m) return [];
  let list: unknown;
  try {
    list = JSON.parse(unescapeJsString(m[1]));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  const out: AnizoneCard[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const row = it as Record<string, unknown>;
    const sid = typeof row.slug === "string" ? row.slug.trim() : "";
    if (!sid) continue;

    const titleMap = row.title_list && typeof row.title_list === "object"
      ? Object.values(row.title_list as Record<string, unknown>)
      : [];
    const titles = Array.from(
      new Set(
        [row.main_title, ...titleMap]
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    );
    if (titles.length === 0) continue;

    out.push({
      sid,
      titles,
      type: typeof row.type === "string" ? row.type : "",
      year: Math.max(0, parseInt(String(row.start_year ?? "0"), 10) || 0),
      eps: Math.max(0, parseInt(String(row.episode_count ?? "0"), 10) || 0),
    });
  }
  return out;
}

/** Extract `.m3u8` URL and softsub tracks from `vidstackPlayer(JSON.parse('...'))` in episode HTML. */
export function parseAnizonePlayer(html: string): AnizonePlayerData {
  const m = /vidstackPlayer\(JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html);
  if (!m) return { m3u8: "", subs: [] };

  let cfg: Record<string, unknown> | null = null;
  try {
    cfg = JSON.parse(unescapeJsString(decodeHtmlEntities(m[1]))) as Record<string, unknown>;
  } catch {
    return { m3u8: "", subs: [] };
  }
  if (!cfg || typeof cfg !== "object") return { m3u8: "", subs: [] };

  const m3u8 = typeof cfg.src === "string" && /^https?:\/\//i.test(cfg.src) ? cfg.src : "";
  const rawSubs = Array.isArray(cfg.subtitles) ? cfg.subtitles : [];
  const subs: RawSubtitleInput[] = [];

  for (const t of rawSubs) {
    if (!t || typeof t !== "object") continue;
    const tr = t as Record<string, unknown>;
    const file = typeof tr.file === "string" ? tr.file.trim() : "";
    if (!/^https?:\/\//i.test(file)) continue;
    subs.push({
      url: file,
      lang: typeof tr.language === "string" ? tr.language.toLowerCase() : "en",
      label: typeof tr.title === "string" ? tr.title : undefined,
      isDefault: tr.default === true,
      isForced: tr.forced === true || String(tr.forced ?? "").toLowerCase() === "yes",
    });
  }

  return { m3u8, subs };
}

/** Check whether an HLS master playlist advertises an English audio track. */
export function hasEnglishAudioTrack(manifest: string): boolean {
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) continue;
    if (/LANGUAGE="(?:en|eng|en-[a-z]+)"/i.test(line)) return true;
    if (/NAME="[^"]*(?:english|\bdub\b)[^"]*"/i.test(line)) return true;
  }
  return false;
}

function pickBestAnizoneCard(cards: AnizoneCard[], req: PlaybackRequest): AnizoneCard | null {
  if (cards.length === 0) return null;
  const targets = [req.media.title, req.media.originalTitle].filter((t): t is string => Boolean(t?.trim()));
  const year = req.media.year ?? 0;
  const season = req.season ?? 1;
  const isMovie = req.media.kind === "movie";

  let best: AnizoneCard | null = null;
  let bestScore = -1;

  for (const card of cards) {
    let sim = 0;
    for (const ct of card.titles) {
      for (const target of targets) {
        sim = Math.max(sim, titleSimilarity(ct, target));
        const stripped = target.split(/[:,;~]/)[0].trim();
        if (stripped) sim = Math.max(sim, titleSimilarity(ct, stripped) * 0.9);
      }
    }

    if (year > 0 && card.year > 0) {
      const diff = Math.abs(card.year - year);
      if (diff === 0) sim += 0.1;
      else if (diff === 2) sim -= 0.1;
      else if (diff > 2) sim -= 0.35;
    }

    const cardType = card.type.toLowerCase();
    if (isMovie && cardType.includes("tv series")) sim -= 0.25;
    if (!isMovie && cardType.includes("movie")) sim -= 0.25;

    if (season >= 2) {
      const hasSeason = card.titles.some((t) => new RegExp(`\\b(?:season\\s*${season}|${season}(?:nd|rd|th)\\s+season)\\b`, "i").test(t));
      if (hasSeason) sim += 0.15;
    }

    if (sim > bestScore) {
      bestScore = sim;
      best = card;
    }
  }

  return bestScore >= 0.5 ? best : null;
}

/**
 * Direct AniZone anime extractor (`anizone.to`, ported from `aquaryuo/seanime` MIT).
 * Returns direct `.m3u8` + multi-language softsubs + dual-audio English dub verification.
 */
export const anizoneProvider: SourceProvider = {
  id: "anizone",
  name: "AniZone",
  category: "external",
  priority: 25,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("anizone", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (!isAnimeRequest(req) || signal.aborted) return [];

    try {
      const ep = req.courEpisode ?? req.episode ?? 1;
      const wantAudio = req.audio ?? "sub";
      const headers = { Referer: `${BASE_URL}/`, Origin: BASE_URL, "User-Agent": DEFAULT_UA };

      const queries = Array.from(
        new Set(
          [
            req.media.originalTitle,
            req.media.title,
            req.media.title?.replace(/\s*\b(?:\d+(?:st|nd|rd|th)\s+season|season\s*\d+|part\s*\d+|cour\s*\d+)\b.*$/i, "").trim(),
          ].filter((q): q is string => Boolean(q?.trim())),
        ),
      ).slice(0, 3);

      let cards: AnizoneCard[] = [];
      for (const q of queries) {
        if (signal.aborted) return [];
        const res = await fetchWithAbort(
          `${BASE_URL}/anime?search=${encodeURIComponent(q)}`,
          headers,
          undefined,
          signal,
          8_000,
        );
        if (res.status < 200 || res.status >= 300) continue;
        cards = parseAnizoneCards(res.body);
        if (cards.length > 0) break;
      }

      const card = pickBestAnizoneCard(cards, req);
      if (!card || signal.aborted) return [];

      const pageUrl = `${BASE_URL}/anime/${card.sid}/${ep}`;
      const epRes = await fetchWithAbort(pageUrl, headers, undefined, signal, 8_000);
      if (signal.aborted || epRes.status < 200 || epRes.status >= 300) return [];

      const player = parseAnizonePlayer(epRes.body);
      if (!player.m3u8) return [];

      let hasDub = false;
      const m3u8Res = await fetchWithAbort(player.m3u8, headers, undefined, signal, 7_000).catch(() => null);
      if (signal.aborted) return [];
      if (m3u8Res && m3u8Res.status >= 200 && m3u8Res.status < 300) {
        hasDub = hasEnglishAudioTrack(m3u8Res.body);
      }

      if (wantAudio === "dub" && !hasDub) return [];

      const streamHeaders = buildStreamHeaders(`${BASE_URL}/`, BASE_URL);
      const subtitles = buildSubtitleTracks(player.subs, streamHeaders, BASE_URL);
      const audioMode = wantAudio === "dub" ? "dub" : hasDub ? "dual" : "sub";

      return [
        {
          providerId: "anizone",
          providerName: "AniZone",
          label: `Episode ${ep} · ${audioMode === "dub" ? "English dub" : audioMode === "dual" ? "Dual audio · Sub/Dub" : "Japanese · subtitled"}`,
          url: proxyUrl(player.m3u8, streamHeaders, BASE_URL),
          kind: "hls",
          via: "direct",
          pageUrl,
          headers: streamHeaders,
          audio: audioMode,
          subtitles,
        },
      ];
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
