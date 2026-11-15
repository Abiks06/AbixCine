import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  decodeHtmlEntities,
  fetchJsonWithAbort,
  fetchWithAbort,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  titleSimilarity,
  isMovieRequest,
} from "./common";
import { decryptMegaPlayEnc, resolveMegaPlayEmbed } from "./megaplay";

export const ANIKOTO_MIRRORS = [
  "https://anikototv.bz",
  "https://anikototv.to",
  "https://anikoto.cz",
  "https://anikoto.me",
  "https://anikoto.net",
  "https://anikototv.se",
] as const;

const KNOWN_SERVERS = ["Vidstream-2", "HD-2", "HD-1"] as const;
interface AnikotoCard {
  href: string;
  title: string;
  altTitle: string;
  hasSub: boolean;
  hasDub: boolean;
  isMovie: boolean;
}

interface AnikotoEpisodeNode {
  dataIds: string;
  num: number;
  hasSub: boolean;
  hasDub: boolean;
  slug: string;
}

/** Alias for existing imports; the decrypt now lives with the shared MegaPlay resolver. */
export const decryptAnikotoEnc = decryptMegaPlayEnc;

/** Parse Anikoto `/filter?keyword=...` HTML cards. */
export function parseAnikotoSearchCards(html: string, base: string): AnikotoCard[] {
  const out: AnikotoCard[] = [];
  const blocks = html.split(/<div\s+class="[^"]*\bitem\b[^"]*"[^>]*>/i).slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(/<a\b[^>]*\bclass=["'][^"']*\bname\b[^"']*\bd-title\b[^"']*["'][^>]*>/i);
    const linkTag = linkMatch?.[0] ?? "";
    const hrefMatch =
      linkTag.match(/\bhref=["']([^"']+)["']/i) ??
      block.match(/<a\b[^>]*\bhref=["']([^"']*\/watch\/[^"']+)["']/i);
    if (!hrefMatch) continue;

    let href = hrefMatch[1].trim();
    if (href.startsWith("/")) href = `${base}${href}`;
    else if (!/^https?:\/\//i.test(href)) href = `${base}/${href}`;
    href = href.replace(/[?#][\s\S]*$/, "").replace(/\/ep-[^/]+\/?$/i, "");

    const titleInner = block.match(/<a\b[^>]*\bclass=["'][^"']*\bname\b[^"']*\bd-title\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const dataJp = linkTag.match(/\bdata-jp=["']([^"']*)["']/i)?.[1] ?? "";
    const imgAlt = block.match(/<img\b[^>]*\balt=["']([^"']*)["']/i)?.[1] ?? "";
    const title = decodeHtmlEntities(titleInner.replace(/<[^>]+>/g, "")) || decodeHtmlEntities(dataJp) || decodeHtmlEntities(imgAlt);
    if (!title) continue;

    const hasSub = /class="[^"]*\bep-status\b[^"]*\bsub\b/i.test(block);
    const hasDub = /class="[^"]*\bep-status\b[^"]*\bdub\b/i.test(block);
    const isMovie = /class="[^"]*\bright\b[^"]*"[^>]*>\s*movie\s*</i.test(block);

    out.push({
      href,
      title,
      altTitle: decodeHtmlEntities(dataJp),
      hasSub: hasSub || !hasDub,
      hasDub,
      isMovie,
    });
  }

  return out;
}

/** Parse Anikoto `/ajax/episode/list/{id}` HTML anchors. */
export function parseAnikotoEpisodes(html: string): AnikotoEpisodeNode[] {
  const out: AnikotoEpisodeNode[] = [];
  const anchorRx = /<a\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRx.exec(html)) !== null) {
    const attrs = m[1];
    const dataIds = attrs.match(/\bdata-ids="([^"]+)"/i)?.[1];
    if (!dataIds) continue;
    const rawNum = attrs.match(/\bdata-num="([^"]+)"/i)?.[1] ?? "";
    if (/^\d+\.\d+$/.test(rawNum)) continue;
    const num = parseInt(rawNum, 10);
    if (!Number.isInteger(num) || num < 1 || num > 10_000) continue;

    const hasSub = attrs.match(/\bdata-sub="([^"]*)"/i)?.[1] !== "0";
    const hasDub = attrs.match(/\bdata-dub="([^"]*)"/i)?.[1] !== "0";
    const slug = attrs.match(/\bdata-slug="([^"]*)"/i)?.[1] ?? String(num);
    out.push({ dataIds, num, hasSub, hasDub, slug });
  }
  return out;
}

/** Parse Anikoto `/ajax/server/list?servers=...` HTML server items for `sub`/`hsub` or `dub`. */
export function parseAnikotoServers(html: string, groups: string[]): { name: string; linkId: string }[] {
  const out: { name: string; linkId: string }[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    const groupRx = new RegExp(`data-type=["']${group}["'][^>]*>([\\s\\S]*?)(?=<div[^>]*data-type=|$)`, "i");
    const section = html.match(groupRx)?.[1] ?? "";
    const liRx = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
    let m: RegExpExecArray | null;
    while ((m = liRx.exec(section)) !== null) {
      const linkId = (m[1].match(/\bdata-link-id=["']([^"']+)["']/i)?.[1] ?? "").trim();
      const name = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ""));
      if (!linkId || !name || seen.has(linkId)) continue;
      seen.add(linkId);
      out.push({ name, linkId });
    }
  }

  const rank = (name: string) => {
    const idx = (KNOWN_SERVERS as readonly string[]).indexOf(name);
    return idx === -1 ? KNOWN_SERVERS.length : idx;
  };
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

function pickBestCard(cards: AnikotoCard[], req: PlaybackRequest, wantDub: boolean): AnikotoCard | null {
  const pool = wantDub ? cards.filter((c) => c.hasDub) : cards;
  if (pool.length === 0) return null;

  const targets = [req.media.title, req.media.originalTitle].filter((t): t is string => Boolean(t?.trim()));
  const isMovie = isMovieRequest(req);
  let best: AnikotoCard | null = null;
  let bestScore = -1;

  for (const card of pool) {
    let sim = 0;
    for (const ct of [card.title, card.altTitle].filter(Boolean)) {
      for (const target of targets) {
        sim = Math.max(sim, titleSimilarity(ct, target));
      }
    }
    if (isMovie && card.isMovie) sim += 0.08;
    if (isMovie && !card.isMovie) sim -= 0.15;
    if (sim > bestScore) {
      bestScore = sim;
      best = card;
    }
  }

  return bestScore >= 0.45 ? best : null;
}

/**
 * Direct Anikoto anime extractor (`anikototv.bz` mirrors). The id-keyed MegaPlay route lives in its
 * own `megaplay` extractor, so it runs in parallel instead of waiting on (or duplicating) this one.
 * Ported from `aquaryuo/seanime` (MIT).
 */
export const anikotoProvider: SourceProvider = {
  id: "anikoto",
  name: "Anikoto",
  category: "external",
  priority: 24,
  timeoutMs: 16_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("anikoto", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (!isAnimeRequest(req) || signal.aborted) return [];

    try {
      const ep = req.courEpisode ?? req.episode ?? 1;
      const audio = req.audio ?? "sub";
      const wantDub = audio === "dub";

      const query = (req.media.title || req.media.originalTitle || "").trim();
      if (!query || signal.aborted) return [];

      for (const base of ANIKOTO_MIRRORS) {
        if (signal.aborted) return [];
        // Wrap each mirror attempt so DNS/network failures never abort fallback mirrors.
        try {
          const found = await tryMirror(base);
          if (found) return [found];
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return [];
          continue;
        }
      }
      return [];

      async function tryMirror(base: string): Promise<StreamCandidate | null> {
        const searchRes = await fetchWithAbort(
          `${base}/filter?keyword=${encodeURIComponent(query)}`,
          { Referer: `${base}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          7_000,
        );
        if (searchRes.status < 200 || searchRes.status >= 300) return null;

        const cards = parseAnikotoSearchCards(searchRes.body, base);
        const card = pickBestCard(cards, req, wantDub);
        if (!card) return null;

        const pageRes = await fetchWithAbort(
          card.href,
          { Referer: `${base}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          7_000,
        );
        if (signal.aborted || pageRes.status < 200 || pageRes.status >= 300) return null;

        // The id lives on #watch-main, with its attributes in either order. Only then fall back to
        // the first data-id on the page (which can belong to an unrelated element).
        const seriesId =
          pageRes.body.match(/<[^>]*\bid="watch-main"[^>]*\bdata-id="(\d+)"/i)?.[1] ??
          pageRes.body.match(/<[^>]*\bdata-id="(\d+)"[^>]*\bid="watch-main"/i)?.[1] ??
          pageRes.body.match(/\bdata-id="(\d+)"/i)?.[1];
        if (!seriesId) return null;

        const ajaxHeaders = {
          Referer: `${base}/`,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": DEFAULT_UA,
        };
        const epListRes = await fetchJsonWithAbort<{ status?: number; result?: string }>(
          `${base}/ajax/episode/list/${seriesId}`,
          ajaxHeaders,
          undefined,
          signal,
          7_000,
        );
        if (signal.aborted || !epListRes.data?.result) return null;

        const episodes = parseAnikotoEpisodes(epListRes.data.result);
        const epNode = episodes.find((e) => e.num === ep && (wantDub ? e.hasDub : e.hasSub));
        if (!epNode) return null;

        const srvListRes = await fetchJsonWithAbort<{ status?: number; result?: string }>(
          `${base}/ajax/server/list?servers=${encodeURIComponent(epNode.dataIds)}`,
          ajaxHeaders,
          undefined,
          signal,
          7_000,
        );
        if (signal.aborted || !srvListRes.data?.result) return null;

        const servers = parseAnikotoServers(srvListRes.data.result, wantDub ? ["dub"] : ["sub", "hsub"]);
        for (const srv of servers) {
          if (signal.aborted) return null;
          const srvRes = await fetchJsonWithAbort<{ status?: number; result?: { url?: string } }>(
            `${base}/ajax/server?get=${encodeURIComponent(srv.linkId)}`,
            ajaxHeaders,
            undefined,
            signal,
            7_000,
          ).catch(() => null);
          if (!srvRes) continue;
          const embedUrl = srvRes.data?.result?.url;
          if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) continue;

          const cand = await resolveMegaPlayEmbed(
            embedUrl,
            { providerId: "anikoto", providerName: "Anikoto", serverName: srv.name, audio, referer: `${base}/` },
            signal,
          ).catch(() => null);
          if (cand) return cand;
        }
        return null;
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      // Unreachable or changed is an error, not "no results": the server's health has to see it.
      throw err;
    }
  },
};
