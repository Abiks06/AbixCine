import { searchTmdb } from "../lib/tmdb";
import type { Settings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import type { SourceProvider, StreamCandidate, VideoSource } from "./types";

/**
 * Web players keyed on TMDB ids (and, for some, AniList/MAL ids with a real sub/dub switch).
 * In the desktop app none of these pages is shown: each is loaded off-screen and its stream
 * captured (see native.ts / shield.rs), which both proves the title is there and lets it play
 * ad-free in AbixCine's own player. Ordered by how reliably that capture works.
 *
 * Removed after testing: VidEasy (its new host player.videasy.to serves an invalid,
 * self-signed certificate that any browser refuses) and vsembed (its player chain loads from
 * a host that no longer exists, so the page never finishes loading). P-Stream's domain now
 * redirects into an ad network.
 */
export const availableSources: VideoSource[] = [
  {
    id: "vidfast",
    name: "VidFast",
    isFrench: false,
    startParam: "startAt",
    urls: {
      movie: "https://vidfast.vc/movie/{id}?autoPlay=true",
      tv: "https://vidfast.vc/tv/{id}/{season}/{episode}?autoPlay=true",
    },
  },
  {
    id: "vidnest",
    name: "Vidnest",
    isFrench: false,
    urls: {
      movie: "https://vidnest.fun/movie/{id}",
      tv: "https://vidnest.fun/tv/{id}/{season}/{episode}",
      anime: "https://vidnest.fun/anime/{anilist}/{episode}/{audio}",
    },
  },
  {
    id: "vidlink",
    name: "VidLink",
    isFrench: false,
    startParam: "startAt",
    urls: {
      movie: "https://vidlink.pro/movie/{id}",
      tv: "https://vidlink.pro/tv/{id}/{season}/{episode}",
      anime: "https://vidlink.pro/anime/{mal}/{episode}/{audio}?fallback=true",
    },
  },
  {
    id: "vidsrcsu",
    name: "VidSrc.su",
    isFrench: false,
    urls: {
      movie: "https://vidsrc.su/embed/movie/{id}",
      tv: "https://vidsrc.su/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "vidrift",
    name: "Vidrift",
    isFrench: false,
    urls: {
      movie: "https://embed.vidrift.net/embed/movie/{id}",
      tv: "https://embed.vidrift.net/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "aether",
    name: "Aether",
    isFrench: false,
    urls: {
      movie: "https://aether.ist/media/tmdb-movie-{id}",
      tv: "https://aether.ist/media/tmdb-tv-{id}/{season}/{episode}",
    },
  },
  {
    id: "smashystream",
    name: "SmashyStream",
    isFrench: false,
    urls: {
      movie: "https://embed.smashystream.com/playere.php?tmdb={id}",
      tv: "https://embed.smashystream.com/playere.php?tmdb={id}&season={season}&episode={episode}",
    },
  },
  {
    id: "vidsrccc",
    extra: true,
    name: "VidSrc.cc",
    isFrench: false,
    urls: {
      movie: "https://vidsrc.cc/v2/embed/movie/{id}",
      tv: "https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}",
      anime: "https://vidsrc.cc/v2/embed/anime/ani{anilist}/{episode}/{audio}",
    },
  },
  {
    id: "vidsrcto",
    extra: true,
    name: "VidSrc.to",
    isFrench: false,
    urls: {
      movie: "https://vidsrc.to/embed/movie/{id}",
      tv: "https://vidsrc.to/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "2embed",
    extra: true,
    name: "2Embed",
    isFrench: false,
    urls: {
      movie: "https://www.2embed.cc/embed/{id}",
      tv: "https://www.2embed.cc/embedtv/{id}&s={season}&e={episode}",
    },
  },
  {
    id: "multiembed",
    extra: true,
    name: "MultiEmbed",
    isFrench: false,
    urls: {
      movie: "https://multiembed.mov/?video_id={id}&tmdb=1",
      tv: "https://multiembed.mov/?video_id={id}&tmdb=1&s={season}&e={episode}",
    },
  },
  {
    id: "embedsu",
    extra: true,
    name: "Embed.su",
    isFrench: false,
    urls: {
      movie: "https://embed.su/embed/movie/{id}",
      tv: "https://embed.su/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "vidsrcrip",
    extra: true,
    name: "VidSrc.rip",
    isFrench: false,
    urls: {
      movie: "https://vidsrc.rip/embed/movie/{id}",
      tv: "https://vidsrc.rip/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "frembed",
    extra: true,
    name: "Frembed",
    isFrench: true,
    urls: {
      movie: "https://frembed.uno/embed/movie/{id}",
      tv: "https://frembed.uno/embed/serie/{id}?sa={season}&epi={episode}",
    },
  },
];

const tmdbResolutionMap = new Map<string, Promise<string | null>>();

export function buildEmbedUrl(template: string, id: string, season?: number, episode?: number): string {
  return template
    .replaceAll("{id}", id)
    .replaceAll("{season}", String(season ?? 1))
    .replaceAll("{episode}", String(episode ?? 1));
}

export function resolveTmdbId(req: PlaybackRequest): Promise<string | null> {
  const key = req.media.key;

  // Direct TMDB item
  const m = key.match(/^tmdb:(movie|tv):(\d+)$/);
  if (m) return Promise.resolve(m[2]);

  if ((req.media as any).tmdbId) {
    return Promise.resolve(String((req.media as any).tmdbId));
  }

  // De-duplicate in-flight lookups
  if (tmdbResolutionMap.has(key)) {
    return tmdbResolutionMap.get(key)!;
  }

  const lookup = (async () => {
    try {
      const q = req.media.title || req.media.originalTitle;
      if (!q) return null;

      const isMovie = req.media.kind === "movie";
      let results = await searchTmdb(q);
      let match =
        results.find((item) => (isMovie ? item.kind === "movie" : item.kind !== "movie")) ??
        results[0];

      // Try originalTitle if no match or different
      if (!match && req.media.originalTitle && req.media.originalTitle !== q) {
        results = await searchTmdb(req.media.originalTitle);
        match = results.find((item) => (isMovie ? item.kind === "movie" : item.kind !== "movie")) ?? results[0];
      }

      // If still not matched, strip secondary titles/brackets (common in anime entries)
      if (!match && /[:\-(\[]/.test(q)) {
        const cleaned = q.split(/[:\-(\[]/)[0].trim();
        if (cleaned.length > 2) {
          results = await searchTmdb(cleaned);
          match = results.find((item) => (isMovie ? item.kind === "movie" : item.kind !== "movie")) ?? results[0];
        }
      }

      if (match?.key) {
        const matchId = match.key.match(/^tmdb:(movie|tv):(\d+)$/);
        if (matchId) return matchId[2];
      }
    } catch {
      /* ignore lookup failures */
    }
    return null;
  })();

  tmdbResolutionMap.set(key, lookup);
  return lookup;
}

/** Fill an anime template. Returns null when it needs an id this entry doesn't have. */
function buildAnimeUrl(template: string, anilist: string, mal: number | undefined, episode: number | undefined, audio: "sub" | "dub") {
  if (template.includes("{mal}") && !mal) return null;
  return template
    .replaceAll("{anilist}", anilist)
    .replaceAll("{mal}", String(mal ?? ""))
    .replaceAll("{episode}", String(episode ?? 1))
    .replaceAll("{audio}", audio)
    .replaceAll("{dub}", audio === "dub" ? "true" : "false");
}

const isAnimeReq = (req: PlaybackRequest) => req.media.kind === "anime" || req.media.key.startsWith("anilist:");

export function createEmbedProvider(src: VideoSource, index: number): SourceProvider {
  return {
    id: src.id,
    name: src.name,
    category: "embed",
    // Below local files (30) and Jellyfin (20); list order breaks ties.
    priority: 15 - index * 0.1,
    isFrench: src.isFrench,
    isEnabled: (s: Settings) => (src.extra ? !!s.enabledExtras?.includes(src.id) : !s.disabledSources?.includes(src.id)),
    async find(req: PlaybackRequest, _s: Settings, _signal: AbortSignal): Promise<StreamCandidate[]> {
      const base = { providerId: src.id, providerName: src.name, kind: "embed" as const, via: "embed" as const, startParam: src.startParam };
      const anime = isAnimeReq(req);
      const audio = req.audio ?? "sub";
      const anilist = req.media.key.match(/^anilist:(\d+)$/)?.[1];

      // Native anime endpoint: the right cour and episode numbering, and a real sub/dub switch.
      if (anime && anilist && src.urls.anime) {
        const url = buildAnimeUrl(src.urls.anime, anilist, req.media.malId, req.episode, audio);
        if (url) return [{ ...base, url, pageUrl: url, audio, label: `${src.name} · ${audio === "dub" ? "English dub" : "Japanese · subtitled"}` }];
      }
      // A TMDB-keyed player can't be told which audio to serve and almost always plays the
      // original track, so it is only a fallback for "sub", never a stand-in for a dub.
      if (anime && audio === "dub") return [];

      const tmdbId = await resolveTmdbId(req);
      if (!tmdbId) return [];
      const url =
        req.media.kind === "movie"
          ? buildEmbedUrl(src.urls.movie, tmdbId)
          : buildEmbedUrl(src.urls.tv, tmdbId, req.season, req.episode);
      return [{ ...base, url, pageUrl: url, audio: anime ? "unknown" : undefined, label: `${src.name}${src.isFrench ? " · French" : ""}${anime ? " · audio not guaranteed" : ""}` }];
    },
  };
}

export const embedProviders: SourceProvider[] = availableSources.map(createEmbedProvider);
