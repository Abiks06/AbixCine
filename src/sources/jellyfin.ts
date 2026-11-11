import type { MediaIds, PlaybackRequest } from "../lib/types";
import { idVerdict, titleMatches } from "./local";
import type { SourceProvider, StreamCandidate } from "./types";

/**
 * Jellyfin (or Emby, same API shape) media server. Uses an API key created in
 * Dashboard > API Keys.
 *
 * Each match gives two addresses:
 *  - `nativeUrl`: the original file, untouched (direct play). mpv plays anything, so with mpv you
 *    get the real 4K/HDR picture and the full 5.1/7.1 or Atmos track, and the server does no work.
 *  - `url`: what the built-in player can handle. The original too when its codecs are ones
 *    WebView2 decodes (H.264/VP9/AV1 with AAC/MP3/Opus/FLAC in MP4/WebM/MKV); otherwise HLS,
 *    where Jellyfin copies whatever it can (no re-encode for H.264 video) and converts the rest,
 *    keeping the resolution and up to 5.1 channels.
 */
async function jf<T = any>(base: string, key: string, path: string, params: Record<string, string>, signal: AbortSignal) {
  const u = new URL(base.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "X-Emby-Token": key }, signal });
  if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
  return res.json() as Promise<T>;
}

const BUILTIN_VIDEO = new Set(["h264", "avc", "vp8", "vp9", "av1"]);
const BUILTIN_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const BUILTIN_CONTAINERS = /^(mp4|m4v|mov|webm|mkv|matroska)$/;

export interface JfMediaInfo {
  container?: string;
  video?: { codec?: string; height?: number; bitDepth?: number; hdr?: string };
  audio?: { codec?: string; channels?: number; title?: string };
}

/** Pull the bits we need out of an item's first MediaSource. */
export function mediaInfo(item: any): JfMediaInfo {
  const src = item.MediaSources?.[0];
  const streams: any[] = src?.MediaStreams ?? item.MediaStreams ?? [];
  const v = streams.find((s) => s.Type === "Video");
  const a = streams.find((s) => s.Type === "Audio" && s.IsDefault) ?? streams.find((s) => s.Type === "Audio");
  return {
    container: src?.Container?.split(",")[0]?.toLowerCase(),
    video: v ? { codec: v.Codec?.toLowerCase(), height: v.Height, bitDepth: v.BitDepth, hdr: v.VideoRangeType && v.VideoRangeType !== "SDR" ? v.VideoRangeType : undefined } : undefined,
    audio: a ? { codec: a.Codec?.toLowerCase(), channels: a.Channels, title: a.DisplayTitle } : undefined,
  };
}

/** Can WebView2's own player decode this file as it is? 10-bit H.264 and HDR are a no. */
export function builtinCanPlay(mi: JfMediaInfo) {
  const okC = !mi.container || BUILTIN_CONTAINERS.test(mi.container);
  const okV = !mi.video || (BUILTIN_VIDEO.has(mi.video.codec ?? "") && (mi.video.bitDepth ?? 8) <= 8 && !mi.video.hdr);
  const okA = !mi.audio || BUILTIN_AUDIO.has(mi.audio.codec ?? "");
  return okC && okV && okA;
}

export function codecLine(mi: JfMediaInfo) {
  const ch = mi.audio?.channels;
  const layout = ch ? (ch >= 8 ? "7.1" : ch >= 6 ? "5.1" : ch === 2 ? "2.0" : `${ch}ch`) : "";
  const v = mi.video?.codec === "h264" ? "H.264" : mi.video?.codec?.toUpperCase();
  return [v, mi.video?.hdr, [mi.audio?.codec?.toUpperCase(), layout].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

export function directUrl(base: string, key: string, id: string, container?: string) {
  const b = base.replace(/\/$/, "");
  const ext = container && /^[a-z0-9]+$/.test(container) ? `.${container}` : "";
  return `${b}/Videos/${id}/stream${ext}?static=true&MediaSourceId=${id}&api_key=${encodeURIComponent(key)}`;
}

export function hlsUrl(base: string, key: string, id: string, mi: JfMediaInfo) {
  const b = base.replace(/\/$/, "");
  const qs = new URLSearchParams({
    MediaSourceId: id,
    api_key: key,
    VideoCodec: "h264",
    AudioCodec: "aac",
    // Keep surround: Chromium decodes multichannel AAC.
    MaxAudioChannels: "6",
    TranscodingMaxAudioChannels: "6",
    // Remux instead of re-encoding whenever the codec is already one the player takes.
    AllowVideoStreamCopy: "true",
    AllowAudioStreamCopy: "true",
    // Up to 120 Mb/s: never squeeze a 4K source down on a LAN.
    MaxStreamingBitrate: "120000000",
    ...(mi.video?.height ? { MaxHeight: String(mi.video.height) } : {}),
    SegmentContainer: "mp4",
  });
  return `${b}/Videos/${id}/master.m3u8?${qs}`;
}

/** Provider IDs Jellyfin stores ({Tmdb:"603", Imdb:"tt0133093", Tvdb:"…", AniList:"…"}) in our shape. */
export function providerIds(p: Record<string, string> | undefined, kind?: "movie" | "tv"): MediaIds {
  if (!p) return {};
  const get = (k: string) => Object.entries(p).find(([x]) => x.toLowerCase() === k)?.[1];
  const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return { tmdb: n(get("tmdb")), tmdbKind: kind, imdb: get("imdb") || undefined, tvdb: n(get("tvdb")), anilist: n(get("anilist")), mal: n(get("myanimelist")) };
}

export const jellyfinProvider: SourceProvider = {
  id: "jellyfin",
  name: "Jellyfin server",
  category: "external",
  priority: 20, // external server: below local files by default
  tier: 2,
  isEnabled: (s) => s.jellyfin.enabled && !!s.jellyfin.url && !!s.jellyfin.apiKey,
  async find(req: PlaybackRequest, s, signal) {
    const { url, apiKey } = s.jellyfin;
    const isMovie = req.media.kind === "movie" || (req.ids?.tmdbKind === "movie" && req.episode == null);
    const kind = isMovie ? "movie" : "tv";
    const want: MediaIds | undefined = req.ids && { ...req.ids, tmdbKind: req.ids.tmdbKind ?? kind };
    const search = async (term: string) =>
      (
        await jf<any>(url, apiKey, "/Items", {
          searchTerm: term,
          IncludeItemTypes: isMovie ? "Movie" : "Series",
          Recursive: "true",
          Fields: "ProductionYear,ProviderIds,OriginalTitle",
          Limit: "8",
        }, signal)
      ).Items ?? [];
    // Main title first; sequels' first-season names and English/Japanese names if that finds nothing.
    const terms = [req.media.title, ...(req.altTitles ?? []), req.media.originalTitle].filter((t, i, a): t is string => !!t && a.indexOf(t) === i).slice(0, 4);
    let items: any[] = [];
    for (const t of terms) {
      items = await search(t);
      if (items.length) break;
    }
    // IDs decide when both sides have one; otherwise the name and year must line up.
    items = items.filter((i) => {
      const v = idVerdict(providerIds(i.ProviderIds, kind), want);
      if (v !== "unknown") return v === "match";
      if (!titleMatches(`${i.Name} ${i.OriginalTitle ?? ""}`, req)) return false;
      return req.media.kind === "anime" || !req.media.year || !i.ProductionYear || Math.abs(i.ProductionYear - req.media.year) <= 1;
    });
    const out: StreamCandidate[] = [];
    for (const item of items.slice(0, 2)) {
      let target = item;
      if (!isMovie && req.episode != null) {
        const eps = await jf<any>(url, apiKey, `/Shows/${item.Id}/Episodes`, {
          ...(req.season != null ? { season: String(req.season) } : {}),
          Fields: "MediaSources,MediaStreams",
        }, signal);
        const list: any[] = eps.Items ?? [];
        target = list.find((e) => e.IndexNumber === req.episode || (e.IndexNumberEnd && req.episode! >= e.IndexNumber && req.episode! <= e.IndexNumberEnd));
        // Anime filed as one long season: try the absolute number.
        if (!target && req.absolute != null) {
          const all: any[] = (await jf<any>(url, apiKey, `/Shows/${item.Id}/Episodes`, { Fields: "MediaSources,MediaStreams" }, signal)).Items ?? [];
          target = all.find((e) => e.IndexNumber === req.absolute && (e.ParentIndexNumber ?? 1) <= 1);
        }
        if (!target) continue;
      } else if (!target.MediaSources) {
        target = await jf<any>(url, apiKey, `/Items/${item.Id}`, { Fields: "MediaSources,MediaStreams" }, signal).catch(() => item);
      }
      const mi = mediaInfo(target);
      const direct = directUrl(url, apiKey, target.Id, mi.container);
      const plain = builtinCanPlay(mi);
      const height = mi.video?.height ?? target.Height;
      const codec = codecLine(mi);
      out.push({
        providerId: "jellyfin",
        providerName: "Jellyfin server",
        label: [target.Name, height ? `${height}p` : null, codec || null].filter(Boolean).join(" · "),
        url: plain ? direct : hlsUrl(url, apiKey, target.Id, mi),
        nativeUrl: direct,
        needsMpv: !plain,
        codec: codec || undefined,
        kind: plain ? "file" : "hls",
        quality: height || undefined,
      });
    }
    return out;
  },
};
