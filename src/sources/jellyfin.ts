import type { PlaybackRequest } from "../lib/types";
import type { SourceProvider, StreamCandidate } from "./types";

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

function streamUrl(base: string, key: string, itemId: string) {
  const b = base.replace(/\/$/, "");
  return `${b}/Videos/${itemId}/master.m3u8?MediaSourceId=${itemId}&api_key=${encodeURIComponent(key)}&VideoCodec=h264&AudioCodec=aac&TranscodingMaxAudioChannels=2`;
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
      out.push({
        providerId: "jellyfin",
        providerName: "Jellyfin server",
        label: target.Name + (target.Height ? ` · ${target.Height}p` : ""),
        url: streamUrl(url, apiKey, target.Id),
        kind: "hls",
        quality: target.Height || undefined,
      });
    }
    return out;
  },
};
