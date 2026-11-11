import { cached } from "../lib/cache";
import type { PlaybackRequest } from "../lib/types";
import { httpFetch, native, proxyUrl, type StreamHeaders } from "./native";
import type { SourceProvider, StreamCandidate, SubtitleTrack } from "./types";

/**
 * Direct anime streams from the HiAnime network's player (the same backend ani-cli and
 * Kitsune use). The player page is keyed by MyAnimeList id + episode + sub/dub and carries
 * its config as base64(JSON XOR "otaku-embed-v1"): an HLS master playlist, subtitle tracks
 * and intro/outro times. No page is ever shown; the stream plays in AbixCine's own player.
 * A missing episode answers without a config, so "not found" is real.
 */

const HOST = "https://zokoanime.video";
const KEY = new TextEncoder().encode("otaku-embed-v1");
const STREAM_HEADERS: StreamHeaders = { referer: `${HOST}/`, origin: HOST };

function decodeConfig(blob: string): any {
  const raw = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const out = raw.map((b, i) => b ^ KEY[i % KEY.length]);
  return JSON.parse(new TextDecoder().decode(out));
}

const ANILIST = "https://graphql.anilist.co";
/**
 * MAL id for a request. AniList entries carry it; TMDB anime (one entry with seasons) is
 * matched on AniList by title, using "Season N" for later seasons, and checked by year.
 */
export async function malIdFor(req: PlaybackRequest): Promise<number | null> {
  if (req.media.malId) return req.media.malId;
  const kind = req.media.kind;
  if (kind !== "anime" && !req.media.key.startsWith("anilist:")) return null;
  const season = req.season ?? 1;
  const base = req.media.originalTitle || req.media.title;
  const q = season > 1 ? `${req.media.title} season ${season}` : base;
  return cached(`mal:${req.media.key}:s${season}`, 7 * 24 * 3600_000, async () => {
    const res = await fetch(ANILIST, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query: `query($q:String){ Page(perPage:6){ media(type:ANIME,search:$q,sort:SEARCH_MATCH){ idMal format seasonYear } } }`,
        variables: { q },
      }),
    });
    const list: { idMal: number | null; format: string; seasonYear?: number }[] = (await res.json())?.data?.Page?.media ?? [];
    const tv = list.filter((m) => m.idMal && m.format !== "MOVIE" && m.format !== "MUSIC");
    const byYear = season === 1 && req.media.year ? tv.find((m) => m.seasonYear && Math.abs(m.seasonYear - req.media.year!) <= 1) : undefined;
    return (byYear ?? tv[0])?.idMal ?? null;
  });
}

export const animeDirectProvider: SourceProvider = {
  id: "hianime",
  name: "HiAnime",
  category: "external",
  priority: 26,
  timeoutMs: 12_000,
  isEnabled: (s) => native && !s.disabledSources?.includes("hianime"),
  async find(req: PlaybackRequest): Promise<StreamCandidate[]> {
    const isAnime = req.media.kind === "anime" || req.media.key.startsWith("anilist:");
    if (!isAnime) return [];
    const mal = await malIdFor(req);
    if (!mal) return [];
    const ep = req.episode ?? 1;
    const audio = req.audio ?? "sub";
    const page = `${HOST}/stream/mal/${mal}/${ep}/${audio}`;
    const t0 = performance.now();
    const res = await httpFetch(page, { Referer: "https://hianime.at/" });
    const blob = res.body.match(/window\.__P="([^"]*)"/)?.[1];
    if (!blob) return [];
    const cfg = decodeConfig(blob);
    const src: string | undefined = cfg?.src;
    if (!src) return [];
    const subtitles: SubtitleTrack[] = (cfg.subtitles ?? [])
      .filter((s: any) => s?.src)
      // The player mislabels every track's lang as "en"; the label is the reliable part.
      .map((s: any) => ({ lang: String(s.label ?? s.lang ?? "und"), label: String(s.label ?? "Subtitles").replace(/\s*\(-.*\)$/, ""), url: proxyUrl(s.src, STREAM_HEADERS) }));
    const sk = cfg.skip ?? {};
    const range = (r: any): [number, number] | undefined => (r && r.end > r.start ? [r.start, r.end] : undefined);
    return [
      {
        providerId: "hianime",
        providerName: "HiAnime",
        label: `Episode ${ep} · ${audio === "dub" ? "English dub" : "Japanese · subtitled"}`,
        url: proxyUrl(src, STREAM_HEADERS),
        kind: "hls",
        via: "direct",
        audio,
        subtitles,
        skip: { intro: range(sk.intro), outro: range(sk.outro) },
        // Already fetched and decoded: that's the reachability check.
        probe: { ok: true, latencyMs: Math.round(performance.now() - t0) },
      },
    ];
  },
};
