import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { isFilm } from "../lib/types";
import { assessTitleMatch, matchTargetFor } from "./titleMatch";
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
  OriginalTitle?: string;
  /** Metadata ids, e.g. { Tmdb: "603", Imdb: "tt0133093" }. */
  ProviderIds?: Record<string, string | undefined>;
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
  priority: 32, // personal server: below local files (60), above online extractors and embeds
  isEnabled: (s) => s.jellyfin.enabled && !!s.jellyfin.url && !!s.jellyfin.apiKey,
  async find(req: PlaybackRequest, s, signal) {
    const { url, apiKey } = s.jellyfin;
    const isMovie = isFilm(req.media);
    const found = await jf(url, apiKey, "/Items", {
      searchTerm: req.media.title,
      IncludeItemTypes: isMovie ? "Movie" : "Series",
      Recursive: "true",
      Fields: "ProductionYear,MediaSources,Width,Height,OriginalTitle,ProviderIds",
      Limit: "5",
    }, signal);
    // Only items that are this title: the same TMDB/IMDb id when the library has one, otherwise
    // the same name and year. (A search used to fall back to whatever it returned when no item had
    // the right year, so a library's 1997 "The Odyssey" played for the 2026 film.)
    const media = req.media as MediaDetail;
    const tmdbId = media.tmdbId ?? (media.canonicalKey ?? media.key).match(/^tmdb:(?:movie|tv):(\d+)$/)?.[1];
    const wanted = { ...matchTargetFor(req, { tmdbId, imdbId: media.imdbId }), season: undefined };
    const items: JellyfinItem[] = (found.Items ?? [])
      .map((item, i) => ({
        item,
        i,
        a: assessTitleMatch(wanted, {
          titles: [item.Name, item.OriginalTitle],
          year: item.ProductionYear,
          tmdbId: item.ProviderIds?.Tmdb,
          imdbId: item.ProviderIds?.Imdb,
        }),
      }))
      .filter((r) => r.a.ok)
      .sort((x, y) => (y.a.ok ? y.a.score : 0) - (x.a.ok ? x.a.score : 0) || x.i - y.i)
      .map((r) => r.item);
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
            downloadUrl: `${url.replace(/\/$/, "")}/Items/${target.Id}/Download?api_key=${encodeURIComponent(apiKey)}`,
            kind: "hls",
            via: "direct",
            quality: target.Height || undefined,
            audio: t.audio,
            subtitles: t.subtitles,
            matched: { title: item.Name, ...(item.ProductionYear ? { year: item.ProductionYear } : {}) },
          };
        } catch {
          return null;
        }
      }),
    );
    return resolved.filter((c): c is StreamCandidate => c !== null);
  },
};
