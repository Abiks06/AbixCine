import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  aes256CbcDecrypt,
  base64ToBytes,
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

const MIRRORS = [
  "https://anikototv.to",
  "https://anikoto.cz",
  "https://anikoto.me",
  "https://anikoto.net",
  "https://anikototv.se",
] as const;

const KNOWN_SERVERS = ["Vidstream-2", "HD-2", "HD-1"] as const;
const DEFAULT_ENC_PAIR = { key: "i?LMTAx0Q6,:}50U", iv: "W0;27ToaUpl_P%'c" };

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

interface AnikotoTrack {
  file?: string;
  label?: string;
  kind?: string;
  default?: boolean;
}

interface AnikotoSourcePayload {
  sources?: { file?: string } | { file?: string }[];
  tracks?: AnikotoTrack[];
  enc?: string;
}

function make32ByteKey(rawKey: string): Uint8Array {
  const keyBytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(rawKey);
  keyBytes.set(encoded.subarray(0, 32));
  return keyBytes;
}

/** Decrypt Anikoto/MegaPlay AES-256-CBC `enc` payload using known/recovered key+IV pairs. */
export async function decryptAnikotoEnc(
  enc: string,
  pairs: { key: string; iv: string }[] = [DEFAULT_ENC_PAIR],
): Promise<{ file?: string } | null> {
  if (!enc || enc.length > 65_536) return null;
  let cipherBytes: Uint8Array;
  try {
    cipherBytes = base64ToBytes(enc);
  } catch {
    return null;
  }

  for (const pair of pairs) {
    const keyBytes = make32ByteKey(pair.key);
    const ivBytes = new TextEncoder().encode(pair.iv);
    if (ivBytes.length !== 16) continue;
    const text = await aes256CbcDecrypt(keyBytes, ivBytes, cipherBytes);
    if (!text || !text.includes("http")) continue;
    try {
      const obj = JSON.parse(text) as { file?: string };
      if (obj && typeof obj.file === "string") return obj;
    } catch {
      /* try next key pair */
    }
  }
  return null;
}

/** Parse Anikoto `/filter?keyword=...` HTML cards. */
export function parseAnikotoSearchCards(html: string, base: string): AnikotoCard[] {
  const out: AnikotoCard[] = [];
  const blocks = html.split(/<div\s+class="[^"]*\bitem\b[^"]*"[^>]*>/i).slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]*\bclass="[^"]*\bname\b[^"]*\bd-title\b[^"]*"[^>]*>/i);
    const linkTag = linkMatch?.[0] ?? "";
    const hrefMatch =
      linkTag.match(/\bhref="([^"]+)"/i) ??
      block.match(/<a[^>]*\bhref="([^"]*\/watch\/[^"]+)"/i);
    if (!hrefMatch) continue;

    let href = hrefMatch[1].trim();
    if (href.startsWith("/")) href = `${base}${href}`;
    else if (!/^https?:\/\//i.test(href)) href = `${base}/${href}`;
    href = href.replace(/[?#][\s\S]*$/, "").replace(/\/ep-[^/]+\/?$/i, "");

    const titleInner = block.match(/<a[^>]*\bclass="[^"]*\bname\b[^"]*\bd-title\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const dataJp = linkTag.match(/\bdata-jp="([^"]*)"/i)?.[1] ?? "";
    const imgAlt = block.match(/<img[^>]*\balt="([^"]*)"/i)?.[1] ?? "";
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
    const groupRx = new RegExp(`data-type="${group}"[^>]*>([\\s\\S]*?)(?=<div[^>]*data-type=|$)`, "i");
    const section = html.match(groupRx)?.[1] ?? "";
    const liRx = /<li\b[^>]*\bdata-link-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi;
    let m: RegExpExecArray | null;
    while ((m = liRx.exec(section)) !== null) {
      const linkId = m[1].trim();
      const name = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ""));
      if (!linkId || !name || seen.has(linkId)) continue;
      seen.add(linkId);
      out.push({ name, linkId });
    }
  }

  return out
    .filter((s) => (KNOWN_SERVERS as readonly string[]).includes(s.name))
    .sort((a, b) => KNOWN_SERVERS.indexOf(a.name as (typeof KNOWN_SERVERS)[number]) - KNOWN_SERVERS.indexOf(b.name as (typeof KNOWN_SERVERS)[number]));
}

function pickBestCard(cards: AnikotoCard[], req: PlaybackRequest, wantDub: boolean): AnikotoCard | null {
  const pool = wantDub ? cards.filter((c) => c.hasDub) : cards;
  if (pool.length === 0) return null;

  const targets = [req.media.title, req.media.originalTitle].filter((t): t is string => Boolean(t?.trim()));
  const isMovie = req.media.kind === "movie";
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

async function resolveEmbedUrlToCandidate(
  embedUrl: string,
  serverName: string,
  audio: "sub" | "dub",
  referer: string,
  signal: AbortSignal,
): Promise<StreamCandidate | null> {
  const origin = new URL(embedUrl).origin;
  const embedRes = await fetchWithAbort(
    embedUrl,
    { Referer: referer, "User-Agent": DEFAULT_UA },
    undefined,
    signal,
    8_000,
  );
  if (signal.aborted || embedRes.status < 200 || embedRes.status >= 300) return null;

  const embedAudio = embedUrl.match(/\/(sub|dub)(?:[/?#]|$)/i)?.[1]?.toLowerCase();
  if (embedAudio && embedAudio !== audio) return null;

  const dataId =
    embedRes.body.match(/id="megaplay-player"[^>]*\bdata-id="([^"]+)"/i)?.[1] ??
    embedRes.body.match(/\bdata-id="([^"]+)"/i)?.[1];
  if (!dataId) return null;

  const cdn = embedUrl.match(/[?&]s=([\w-]+)/)?.[1] ?? "";
  let payload: AnikotoSourcePayload | null = null;

  for (const path of ["stream/getSourcesNew", "stream/getSources"]) {
    if (signal.aborted) return null;
    const srcRes = await fetchJsonWithAbort<AnikotoSourcePayload>(
      `${origin}/${path}?id=${encodeURIComponent(dataId)}${cdn ? `&s=${encodeURIComponent(cdn)}` : ""}`,
      {
        Referer: embedUrl,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": DEFAULT_UA,
      },
      undefined,
      signal,
      8_000,
    );
    if (!srcRes.data) continue;
    if (!srcRes.data.sources && srcRes.data.enc) {
      const decoded = await decryptAnikotoEnc(String(srcRes.data.enc));
      if (decoded?.file) srcRes.data.sources = { file: decoded.file };
    }
    if (srcRes.data.sources) {
      payload = srcRes.data;
      break;
    }
  }
  if (!payload?.sources) return null;

  const rawFile = Array.isArray(payload.sources) ? payload.sources[0]?.file : payload.sources.file;
  if (!rawFile || !/^https?:\/\//i.test(rawFile)) return null;

  const streamHeaders = buildStreamHeaders(`${origin}/`, origin);
  const rawSubs: RawSubtitleInput[] = (payload.tracks ?? [])
    .filter((t) => typeof t?.file === "string" && (!t.kind || t.kind === "captions" || t.kind === "subtitles"))
    .map((t) => ({
      url: t.file,
      label: t.label,
      kind: t.kind,
      isDefault: t.default,
    }));
  const subtitles = buildSubtitleTracks(rawSubs, streamHeaders, origin);

  return {
    providerId: "anikoto",
    providerName: "Anikoto",
    label: `${serverName} · ${audio === "dub" ? "English dub" : "Japanese · subtitled"}`,
    url: proxyUrl(rawFile, streamHeaders, origin),
    kind: "hls",
    via: "direct",
    pageUrl: embedUrl,
    headers: streamHeaders,
    audio,
    subtitles,
  };
}

/**
 * Direct Anikoto anime extractor (`anikototv.to` mirrors + MegaPlay direct fallback).
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

      // Fast-path: MegaPlay direct AniList / MAL lookup when IDs are already available.
      const alId = req.media.anilistId ?? (req.media.key.match(/^anilist:(\d+)$/)?.[1] ? Number(req.media.key.match(/^anilist:(\d+)$/)![1]) : undefined);
      const mpTargets = [
        ...(alId ? [`https://megaplay.buzz/stream/ani/${alId}/${ep}/${audio}`] : []),
        ...(req.media.malId ? [`https://megaplay.buzz/stream/mal/${req.media.malId}/${ep}/${audio}`] : []),
      ];
      for (const mpUrl of mpTargets) {
        if (signal.aborted) return [];
        const cand = await resolveEmbedUrlToCandidate(mpUrl, "MegaPlay", audio, `${MIRRORS[0]}/`, signal).catch(() => null);
        if (cand) return [cand];
      }

      const query = (req.media.title || req.media.originalTitle || "").trim();
      if (!query || signal.aborted) return [];

      for (const base of MIRRORS) {
        if (signal.aborted) return [];
        const searchRes = await fetchWithAbort(
          `${base}/filter?keyword=${encodeURIComponent(query)}`,
          { Referer: `${base}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          7_000,
        ).catch(() => null);
        if (!searchRes || searchRes.status < 200 || searchRes.status >= 300) continue;

        const cards = parseAnikotoSearchCards(searchRes.body, base);
        const card = pickBestCard(cards, req, wantDub);
        if (!card) continue;

        const pageRes = await fetchWithAbort(
          card.href,
          { Referer: `${base}/`, "User-Agent": DEFAULT_UA },
          undefined,
          signal,
          7_000,
        );
        if (signal.aborted || pageRes.status < 200 || pageRes.status >= 300) continue;

        const seriesId =
          pageRes.body.match(/id="watch-main"[^>]*\bdata-id="(\d+)"/i)?.[1] ??
          pageRes.body.match(/\bdata-id="(\d+)"/i)?.[1];
        if (!seriesId) continue;

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
        if (signal.aborted || !epListRes.data?.result) continue;

        const episodes = parseAnikotoEpisodes(epListRes.data.result);
        const epNode = episodes.find((e) => e.num === ep && (wantDub ? e.hasDub : e.hasSub));
        if (!epNode) continue;

        const srvListRes = await fetchJsonWithAbort<{ status?: number; result?: string }>(
          `${base}/ajax/server/list?servers=${encodeURIComponent(epNode.dataIds)}`,
          ajaxHeaders,
          undefined,
          signal,
          7_000,
        );
        if (signal.aborted || !srvListRes.data?.result) continue;

        const servers = parseAnikotoServers(srvListRes.data.result, wantDub ? ["dub"] : ["sub", "hsub"]);
        for (const srv of servers) {
          if (signal.aborted) return [];
          const srvRes = await fetchJsonWithAbort<{ status?: number; result?: { url?: string } }>(
            `${base}/ajax/server?get=${encodeURIComponent(srv.linkId)}`,
            ajaxHeaders,
            undefined,
            signal,
            7_000,
          );
          const embedUrl = srvRes.data?.result?.url;
          if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) continue;

          const cand = await resolveEmbedUrlToCandidate(embedUrl, srv.name, audio, `${base}/`, signal).catch(() => null);
          if (cand) return [cand];
        }
      }

      return [];
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
