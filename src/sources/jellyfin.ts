import type { PlaybackRequest } from "../lib/types";
import type { SourceProvider, StreamCandidate, SubtitleTrack } from "./types";

/**
 * Jellyfin (or Emby, same API shape) media server. Uses an API key created in
 * Dashboard > API Keys. Streams come back as HLS so the server transcodes to whatever the device can play.
 */
async function jf<T = any>(base: string, key: string, path: string, params: Record<string, string>, signal: AbortSignal) {
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
function tracksFor(base: string, key: string, item: any, want?: "sub" | "dub") {
  const b = base.replace(/\/$/, "");
  const src = item.MediaSources?.[0];
  const streams: any[] = src?.MediaStreams ?? [];
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
    .filter((st) => st.Type === "Subtitle" && (st.IsTextSubtitleStream ?? true))
    .map((st) => ({
      lang: String(st.Language ?? "und"),
      label: st.DisplayTitle || st.Title || st.Language || `Track ${st.Index}`,
      url: `${b}/Videos/${item.Id}/${sourceId}/Subtitles/${st.Index}/0/Stream.vtt?api_key=${encodeURIComponent(key)}`,
    }));
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
    let items: any[] = found.Items ?? [];
    if (req.media.year) {
      const near = items.filter((i) => !i.ProductionYear || Math.abs(i.ProductionYear - req.media.year!) <= 1);
      if (near.length) items = near;
    }
    const out: StreamCandidate[] = [];
    for (const item of items.slice(0, 2)) {
      let target = item;
      if (!isMovie && req.episode != null) {
        const eps = await jf(url, apiKey, `/Shows/${item.Id}/Episodes`, {
          ...(req.season != null ? { season: String(req.season) } : {}),
          Fields: "MediaSources,Width,Height",
        }, signal);
        target = (eps.Items ?? []).find((e: any) => e.IndexNumber === req.episode);
        if (!target) continue;
      }
      const t = tracksFor(url, apiKey, target, req.audio);
      if (!t) continue;
      out.push({
        providerId: "jellyfin",
        providerName: "Jellyfin server",
        label: target.Name + (target.Height ? ` · ${target.Height}p` : "") + (t.audio === "dual" ? " · dual audio" : ""),
        url: streamUrl(url, apiKey, target.Id, t.sourceId, t.audioIndex),
        kind: "hls",
        quality: target.Height || undefined,
        audio: t.audio,
        subtitles: t.subtitles,
      });
    }
    return out;
  },
};
