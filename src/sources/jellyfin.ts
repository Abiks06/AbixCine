import type { PlaybackRequest } from "../lib/types";
import { inferSubtitleMeta, type SourceProvider, type StreamCandidate, type SubtitleFormat, type SubtitleTrack } from "./types";

/**
 * Jellyfin (or Emby, same API shape) media server. Uses an API key created in
 * Dashboard > API Keys. Streams come back as HLS so the server transcodes to whatever the device can play.
 */
interface JellyfinMediaStream {
  Type?: string;
  Language?: string;
  Index?: number;
  Codec?: string;
  IsTextSubtitleStream?: boolean;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsHearingImpaired?: boolean;
  DisplayTitle?: string;
  Title?: string;
}

interface JellyfinMediaSource {
  Id?: string;
  MediaStreams?: JellyfinMediaStream[];
}

interface JellyfinItem {
  Id: string;
  Name: string;
  ProductionYear?: number;
  Height?: number;
  IndexNumber?: number;
  MediaSources?: JellyfinMediaSource[];
}

interface JellyfinItemsResponse {
  Items?: JellyfinItem[];
}

async function jf<T = JellyfinItemsResponse>(base: string, key: string, path: string, params: Record<string, string>, signal: AbortSignal) {
  const u = new URL(base.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "X-Emby-Token": key }, signal });
  if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
  return res.json() as Promise<T>;
}

function streamUrl(base: string, key: string, itemId: string, sourceId: string, audioIndex?: number) {
  const b = base.replace(/\/$/, "");
  const audio = audioIndex != null ? `&AudioStreamIndex=${audioIndex}` : "";
  return `${b}/Videos/${itemId}/master.m3u8?MediaSourceId=${sourceId}&api_key=${encodeURIComponent(key)}&VideoCodec=h264&AudioCodec=aac&TranscodingMaxAudioChannels=2${audio}`;
}

const DUB_LANGS = ["eng", "en"];
const SUB_LANGS = ["jpn", "ja"];

/**
 * Pick the audio stream for the requested sub/dub and list the text subtitles as WebVTT
 * (Jellyfin converts SRT/ASS on the fly; image subtitles like PGS can't be shown in a browser).
 * Returns null when the item clearly lacks the requested audio.
 */
function tracksFor(base: string, key: string, item: JellyfinItem, want?: "sub" | "dub") {
  const b = base.replace(/\/$/, "");
  const src = item.MediaSources?.[0];
  const streams: JellyfinMediaStream[] = src?.MediaStreams ?? [];
  const sourceId: string = src?.Id ?? item.Id;
  const audios = streams.filter((st) => st.Type === "Audio");
  let audioIndex: number | undefined;
  let audio: StreamCandidate["audio"];
  if (want) {
    const langs = want === "dub" ? DUB_LANGS : SUB_LANGS;
    const match = audios.find((a) => langs.includes(String(a.Language ?? "").toLowerCase()));
    const known = audios.filter((a) => a.Language && a.Language !== "und");
    if (match) {
      audioIndex = match.Index;
      audio = known.length > 1 ? "dual" : want;
    } else if (known.length) return null;
    else audio = "unknown";
  }
  const subtitles: SubtitleTrack[] = streams
    .filter((st) => st.Type === "Subtitle" && (st.IsTextSubtitleStream ?? true) && st.Index != null)
    .map((st) => {
      const rawCodec = String(st.Codec ?? "").toLowerCase().trim();
      const isAss = rawCodec === "ass" || rawCodec === "ssa";
      const streamExt = isAss ? rawCodec : "vtt";
      const format: SubtitleFormat = isAss ? rawCodec : "vtt";
      const meta = inferSubtitleMeta("", st.Language, st.DisplayTitle || st.Title);
      return {
        lang: meta.lang !== "und" ? meta.lang : String(st.Language ?? "und"),
        label: st.DisplayTitle || st.Title || (meta.label !== "Subtitles" ? meta.label : st.Language || `Track ${st.Index}`),
        url: `${b}/Videos/${item.Id}/${sourceId}/Subtitles/${st.Index}/0/Stream.${streamExt}?api_key=${encodeURIComponent(key)}`,
        format,
        isDefault: Boolean(st.IsDefault || meta.isDefault),
        isForced: Boolean(st.IsForced || meta.isForced),
        isHearingImpaired: Boolean(st.IsHearingImpaired || meta.isHearingImpaired),
        source: "stream",
      };
    });
  return { sourceId, audioIndex, audio, subtitles };
}

export const jellyfinProvider: SourceProvider = {
  id: "jellyfin",
  name: "Jellyfin server",
  category: "external",
  priority: 20, // external server: below local files by default
  isEnabled: (s) => s.jellyfin.enabled && !!s.jellyfin.url && !!s.jellyfin.apiKey,
  async find(req: PlaybackRequest, s, signal) {
    const { url, apiKey } = s.jellyfin;
    const isMovie = req.media.kind === "movie";
    const found = await jf(url, apiKey, "/Items", {
      searchTerm: req.media.title,
      IncludeItemTypes: isMovie ? "Movie" : "Series",
      Recursive: "true",
      Fields: "ProductionYear,MediaSources,Width,Height",
      Limit: "5",
    }, signal);
    let items: JellyfinItem[] = found.Items ?? [];
    const mediaYear = req.media.year;
    if (mediaYear != null) {
      const near = items.filter((i) => !i.ProductionYear || Math.abs(i.ProductionYear - mediaYear) <= 1);
      if (near.length) items = near;
    }
    const resolved = await Promise.all(
      items.slice(0, 2).map(async (item): Promise<StreamCandidate | null> => {
        try {
          let target: JellyfinItem | undefined = item;
          if (!isMovie && req.episode != null) {
            const eps = await jf(url, apiKey, `/Shows/${item.Id}/Episodes`, {
              ...(req.season != null ? { season: String(req.season) } : {}),
              Fields: "MediaSources,Width,Height",
            }, signal);
            target = (eps.Items ?? []).find((e) => e.IndexNumber === req.episode);
            if (!target) return null;
          }
          const t = tracksFor(url, apiKey, target, req.audio);
          if (!t) return null;
          return {
            providerId: "jellyfin",
            providerName: "Jellyfin server",
            label: target.Name + (target.Height ? ` · ${target.Height}p` : "") + (t.audio === "dual" ? " · dual audio" : ""),
            url: streamUrl(url, apiKey, target.Id, t.sourceId, t.audioIndex),
            kind: "hls",
            quality: target.Height || undefined,
            audio: t.audio,
            subtitles: t.subtitles,
          };
        } catch {
          return null;
        }
      }),
    );
    return resolved.filter((c): c is StreamCandidate => c !== null);
  },
};
