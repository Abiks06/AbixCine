import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  buildStreamHeaders,
  decodeHtmlEntities,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  titleSimilarity,
} from "./common";

const ANIMEHEAVEN_BASE = "https://animeheaven.me";

export interface AnimeHeavenCard {
  href: string;
  title: string;
}

export interface AnimeHeavenPageInfo {
  titles: string[];
  episodes: { num: number; key: string }[];
}

const DUB_TAG_RE = /\((?:english\s+)?dub(?:bed)?\)|\bdubbed\b/i;

/** Parse unique anime cards from `animeheaven.me/search.php?s=...` HTML. */
export function parseAnimeHeavenSearch(html: string): AnimeHeavenCard[] {
  const out: AnimeHeavenCard[] = [];
  const seen = new Set<string>();

  const cardRx = /class\s*=\s*["'][^"']*similarname[^"']*["'][^>]*>\s*<a\b[^>]*\bhref\s*=\s*["']([^"']*anime\.php\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRx.exec(html)) !== null) {
    const rel = m[1].trim();
    const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ""));
    if (!rel || !title || seen.has(rel)) continue;
    seen.add(rel);
    const href = rel.startsWith("http") ? rel : `${ANIMEHEAVEN_BASE}/${rel.replace(/^\/+/, "")}`;
    out.push({ href, title });
  }

  // Fallback for markup variations where only image alt titles appear on anime.php links.
  if (out.length === 0) {
    const fallbackRx = /<a\b[^>]*\bhref\s*=\s*["']([^"']*anime\.php\?[^"']+)["'][^>]*>[\s\S]*?\balt\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while ((m = fallbackRx.exec(html)) !== null) {
      const rel = m[1].trim();
      const title = decodeHtmlEntities(m[2]);
      if (!rel || !title || seen.has(rel)) continue;
      seen.add(rel);
      const href = rel.startsWith("http") ? rel : `${ANIMEHEAVEN_BASE}/${rel.replace(/^\/+/, "")}`;
      out.push({ href, title });
    }
  }

  return out;
}

/** Parse alternate titles (including `.infotitlejp`) and episode gate keys from `anime.php?...`. */
export function parseAnimeHeavenPage(html: string): AnimeHeavenPageInfo {
  const titles: string[] = [];
  const pushTitle = (raw: string | undefined) => {
    if (!raw) return;
    const clean = decodeHtmlEntities(raw.replace(/<[^>]+>/g, ""));
    if (clean && !titles.includes(clean)) titles.push(clean);
  };

  pushTitle(html.match(/class\s*=\s*["'][^"']*\binfotitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  const jpRaw = html.match(/class\s*=\s*["'][^"']*\binfotitlejp\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (jpRaw) {
    pushTitle(jpRaw);
    for (const part of jpRaw.split(",")) {
      pushTitle(part);
    }
  }

  const episodes: { num: number; key: string }[] = [];
  const seenKeys = new Set<string>();
  const epRx = /<a\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<div\b[^>]*\bclass\s*=\s*["'][^"']*\bwatch2\b[^"']*["'][^>]*>\s*([^<]+?)\s*</gi;
  let m: RegExpExecArray | null;
  while ((m = epRx.exec(html)) !== null) {
    const key = m[1].trim();
    const num = parseFloat(m[2].trim());
    if (!key || !Number.isFinite(num) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    episodes.push({ num, key });
  }

  return { titles, episodes };
}

/** Extract live `<source src>` URLs from `gate.php` HTML while stripping commented-out tags. */
export function parseAnimeHeavenVideoUrls(html: string): string[] {
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  const rx = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(uncommented)) !== null) {
    const raw = decodeHtmlEntities(m[1]);
    if (!/^https?:\/\//i.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function scoreTitleCandidates(candidateTitles: string[], targets: string[], wantDub: boolean): number {
  let best = 0;
  for (const cand of candidateTitles) {
    const isDubCard = DUB_TAG_RE.test(cand);
    if (wantDub && !isDubCard) continue;
    if (!wantDub && isDubCard) continue;
    const stripped = cand.replace(DUB_TAG_RE, "").trim();
    for (const target of targets) {
      best = Math.max(best, titleSimilarity(stripped, target), titleSimilarity(cand, target));
    }
  }
  return best;
}

/**
 * Direct AnimeHeaven extractor (`animeheaven.me`): self-contained HTML search + cookie gate
 * resolving direct MP4 streams with zero external decryption service.
 */
export const animeheavenProvider: SourceProvider = {
  id: "animeheaven",
  name: "AnimeHeaven",
  category: "external",
  priority: 21,
  timeoutMs: 14_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("animeheaven", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (!isAnimeRequest(req) || signal.aborted) return [];

    const audio = req.audio ?? "sub";
    const wantDub = audio === "dub";
    const ep = req.courEpisode ?? req.episode ?? 1;

    try {
      const targets = Array.from(
        new Set([req.media.title, req.media.originalTitle].filter((t): t is string => Boolean(t?.trim()))),
      ).slice(0, 2);
      if (targets.length === 0) return [];

      const cards: AnimeHeavenCard[] = [];
      const seenHrefs = new Set<string>();
      for (const q of targets) {
        if (signal.aborted) return [];
        const searchRes = await fetchWithAbort(
          `${ANIMEHEAVEN_BASE}/search.php?s=${encodeURIComponent(q)}`,
          { Referer: `${ANIMEHEAVEN_BASE}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          7_000,
        );
        if (searchRes.status < 200 || searchRes.status >= 300 || !searchRes.body) continue;
        for (const card of parseAnimeHeavenSearch(searchRes.body)) {
          if (seenHrefs.has(card.href)) continue;
          seenHrefs.add(card.href);
          cards.push(card);
        }
        // Only stop searching once a card for the wanted audio matches well; a hit list made of
        // the wrong audio or loosely related titles must still let the original title be tried.
        const goodHit = cards.some((c) =>
          DUB_TAG_RE.test(c.title) === wantDub && scoreTitleCandidates([c.title], targets, wantDub) >= 0.65,
        );
        if (goodHit) break;
      }
      if (cards.length === 0 || signal.aborted) return [];

      const eligibleCards = cards.filter((c) => {
        const isDub = DUB_TAG_RE.test(c.title);
        return wantDub ? isDub : !isDub;
      });
      if (eligibleCards.length === 0) return [];

      // Rank cards by title similarity; if search cards use translated English titles
      // (e.g. "Sorcery Fight" for "Jujutsu Kaisen"), inspect the top 3 ranked detail pages' .infotitlejp.
      const rankedCards = eligibleCards
        .map((card) => ({ card, score: scoreTitleCandidates([card.title], targets, wantDub) }))
        .sort((a, b) => b.score - a.score);

      let chosenPage: AnimeHeavenPageInfo | null = null;
      const toInspect =
        rankedCards[0].score >= 0.75
          ? [rankedCards[0].card]
          : rankedCards.slice(0, 3).map((r) => r.card);

      let bestScore = -1;
      for (const card of toInspect) {
        if (signal.aborted) return [];
        const pageRes = await fetchWithAbort(
          card.href,
          { Referer: `${ANIMEHEAVEN_BASE}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          7_000,
        );
        if (pageRes.status < 200 || pageRes.status >= 300 || !pageRes.body) continue;
        const info = parseAnimeHeavenPage(pageRes.body);
        const score = scoreTitleCandidates([card.title, ...info.titles], targets, wantDub);
        if (score >= 0.55 && score > bestScore && info.episodes.length > 0) {
          bestScore = score;
          chosenPage = info;
          if (score >= 0.85) break;
        }
      }

      if (!chosenPage || signal.aborted) return [];
      const epNode =
        chosenPage.episodes.find((e) => e.num === ep)
        ?? (chosenPage.episodes.length === 1 && ep === 1 ? chosenPage.episodes[0] : undefined);
      if (!epNode) return [];

      const gateRes = await fetchWithAbort(
        `${ANIMEHEAVEN_BASE}/gate.php`,
        {
          Cookie: `key=${epNode.key}`,
          Referer: `${ANIMEHEAVEN_BASE}/anime.php`,
          "User-Agent": DEFAULT_UA,
        },
        undefined,
        signal,
        7_000,
      );
      if (gateRes.status < 200 || gateRes.status >= 300 || !gateRes.body || signal.aborted) return [];

      const urls = parseAnimeHeavenVideoUrls(gateRes.body);
      if (urls.length === 0) return [];

      const streamHeaders = buildStreamHeaders(`${ANIMEHEAVEN_BASE}/`, ANIMEHEAVEN_BASE);
      return urls.map((rawUrl, idx) => {
        const kind = inferStreamKind(rawUrl);
        return {
          providerId: "animeheaven",
          providerName: "AnimeHeaven",
          label: `Episode ${ep}${urls.length > 1 ? ` · Mirror ${idx + 1}` : ""} · ${wantDub ? "English dub" : "Japanese · subtitled"}`,
          url: proxyUrl(rawUrl, streamHeaders, ANIMEHEAVEN_BASE),
          kind,
          via: "direct",
          headers: streamHeaders,
          audio,
        } satisfies StreamCandidate;
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
