import { cached } from "../lib/cache";
import { normTitle } from "../lib/format";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { DEFAULT_UA, httpFetch, native, normalizeHeaders, proxyUrl, sniff } from "./native";
import type { SourceProvider, StreamCandidate } from "./types";

/**
 * KissKH: Korean, Chinese, Japanese, Thai and Taiwanese dramas and films with subtitles
 * (one of Sora's sources). Its public API finds the show and the episode; the episode page
 * itself mints a short-lived token, so the stream is captured from that page by the sniffer.
 */

const HOST = "https://kisskh.co";
const ASIAN = new Set(["ko", "zh", "cn", "ja", "th", "tw", "tl", "id", "vi"]);

interface Hit { id: number; title: string; episodesCount: number }
interface Drama { id: number; title: string; episodes: { id: number; number: number }[] }

const slug = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function search(q: string): Promise<Hit[]> {
  try {
    return await cached(`kisskh:s:${q}`, 6 * 3600_000, async () => {
      const r = await httpFetch(`${HOST}/api/DramaList/Search?q=${encodeURIComponent(q)}&type=0`, {
        Referer: `${HOST}/`,
        Origin: HOST,
        "User-Agent": DEFAULT_UA,
      });
      if (r.status !== 200) throw new Error(`KissKH search HTTP ${r.status}`);
      const parsed = JSON.parse(r.body) as Hit[];
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty");
      return parsed;
    });
  } catch {
    return [];
  }
}

async function drama(id: number): Promise<Drama | null> {
  try {
    return await cached(`kisskh:d:${id}`, 3600_000, async () => {
      const r = await httpFetch(`${HOST}/api/DramaList/Drama/${id}?isq=false`, {
        Referer: `${HOST}/`,
        Origin: HOST,
        "User-Agent": DEFAULT_UA,
      });
      if (r.status !== 200) throw new Error(`KissKH drama HTTP ${r.status}`);
      const parsed = JSON.parse(r.body) as Drama;
      if (!parsed?.episodes?.length) throw new Error("no episodes");
      return parsed;
    });
  } catch {
    return null;
  }
}

export const kisskhProvider: SourceProvider = {
  id: "kisskh",
  name: "KissKH",
  category: "external",
  priority: 18,
  timeoutMs: 26_000,
  isEnabled: (s) => native && !s.disabledSources?.includes("kisskh"),
  async find(req: PlaybackRequest, _s, signal): Promise<StreamCandidate[]> {
    const lang = (req.media as MediaDetail).originalLanguage;
    if (!lang || !ASIAN.has(lang) || req.media.kind === "anime" || signal.aborted) return [];
    const want = normTitle(req.media.title);
    const season = req.season ?? 1;
    const q = season > 1 ? `${req.media.title} ${season}` : req.media.title;
    const [primaryHits, altHits] = await Promise.all([
      search(q),
      req.media.originalTitle && req.media.originalTitle !== req.media.title ? search(req.media.originalTitle) : Promise.resolve([] as Hit[]),
    ]);
    if (signal.aborted) return [];
    const hits = primaryHits.concat(altHits);
    const hit =
      hits.find((h) => normTitle(h.title) === want + (season > 1 ? String(season) : "")) ??
      hits.find((h) => normTitle(h.title).startsWith(want)) ??
      hits[0];
    if (!hit) return [];
    const d = await drama(hit.id);
    const epNo = req.media.kind === "movie" ? 1 : req.episode ?? 1;
    const ep = d?.episodes.find((e) => Math.round(e.number) === epNo);
    if (!d || !ep || signal.aborted) return [];
    const page = `${HOST}/Drama/${slug(d.title)}/Episode-${epNo}?id=${d.id}&ep=${ep.id}&page=0&pageSize=100`;
    const t0 = performance.now();
    const got = await sniff(page, 16_000, signal);
    if (!got || got.verified === false) return [];
    const headers = normalizeHeaders(got.headers, page);
    return [
      {
        providerId: "kisskh",
        providerName: "KissKH",
        label: `${d.title}${req.media.kind === "movie" ? "" : ` · Episode ${epNo}`}`,
        url: proxyUrl(got.url, headers, page),
        kind: got.kind === "mp4" ? "file" : got.kind === "dash" ? "dash" : "hls",
        via: "sniffed",
        pageUrl: page,
        headers,
        subtitles: got.subtitles.map((u, i) => ({ lang: "en", label: i ? `English ${i + 1}` : "English", url: proxyUrl(u, headers, page) })),
        ...(got.verified === true
          ? { probe: { ok: true, latencyMs: Math.round(performance.now() - t0), quality: got.quality ?? undefined } }
          : {}),
      },
    ];
  },
};
