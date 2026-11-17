import { searchTmdb } from "../lib/tmdb";
import type { Settings } from "../lib/settings";
import { isFilm, type PlaybackRequest } from "../lib/types";
import { DEFAULT_UA, normalizeHeaders, type StreamHeaders } from "./native";
import { matchTargetFor, pickTitleMatch, type MatchTarget } from "./titleMatch";
import type { SourceProvider, StreamCandidate, VideoSource } from "./types";

const serverHeaders = (origin: string): StreamHeaders => ({
  referer: `${origin}/`,
  origin,
  ua: DEFAULT_UA,
});

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
    headers: serverHeaders("https://vidfast.vc"),
    urls: {
      movie: "https://vidfast.vc/movie/{id}?autoPlay=true",
      tv: "https://vidfast.vc/tv/{id}/{season}/{episode}?autoPlay=true",
    },
  },
  {
    id: "vidnest",
    name: "Vidnest",
    isFrench: false,
    headers: serverHeaders("https://vidnest.fun"),
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
    headers: serverHeaders("https://vidlink.pro"),
    urls: {
      movie: "https://vidlink.pro/movie/{id}",
      tv: "https://vidlink.pro/tv/{id}/{season}/{episode}",
      anime: "https://vidlink.pro/anime/{mal}/{episode}/{audio}?fallback=true",
    },
  },
  {
    id: "vidrock-embed",
    name: "VidRock Player",
    isFrench: false,
    headers: serverHeaders("https://vidrock.net"),
    urls: {
      movie: "https://vidrock.net/movie/{id}",
      tv: "https://vidrock.net/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "zxcstream-embed",
    name: "ZXCStream Player",
    isFrench: false,
    headers: serverHeaders("https://zxcstream.cc"),
    urls: {
      movie: "https://zxcstream.cc/player/movie/{id}",
      tv: "https://zxcstream.cc/player/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "hexa",
    name: "Hexa",
    isFrench: false,
    headers: serverHeaders("https://hexa.su"),
    urls: {
      movie: "https://hexa.su/watch/movie/{id}",
      tv: "https://hexa.su/watch/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "vidmario",
    name: "VidMario",
    isFrench: false,
    headers: serverHeaders("https://player.vidmario.net"),
    urls: {
      movie: "https://player.vidmario.net/embed/movie/{id}",
      tv: "https://player.vidmario.net/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "vidsrcsu",
    name: "VidSrc.su",
    isFrench: false,
    headers: serverHeaders("https://vidsrc.su"),
    urls: {
      movie: "https://vidsrc.su/embed/movie/{id}",
      tv: "https://vidsrc.su/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "aether",
    name: "Aether",
    isFrench: false,
    headers: serverHeaders("https://aether.ist"),
    urls: {
      movie: "https://aether.ist/media/tmdb-movie-{id}",
      tv: "https://aether.ist/media/tmdb-tv-{id}/{season}/{episode}",
    },
  },
  {
    id: "vidsrccc",
    extra: true,
    name: "VidSrc",
    isFrench: false,
    headers: serverHeaders("https://vidsrcme.ru"),
    urls: {
      movie: "https://vidsrcme.ru/embed/movie/{id}",
      tv: "https://vidsrcme.ru/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "vidsrcto",
    extra: true,
    name: "VidSrc.to",
    isFrench: false,
    headers: serverHeaders("https://vidsrc.to"),
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
    headers: serverHeaders("https://www.2embed.cc"),
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
    headers: serverHeaders("https://multiembed.mov"),
    urls: {
      movie: "https://multiembed.mov/?video_id={id}&tmdb=1",
      tv: "https://multiembed.mov/?video_id={id}&tmdb=1&s={season}&e={episode}",
    },
  },
  {
    id: "vidsrcrip",
    extra: true,
    name: "VidSrc.rip",
    isFrench: false,
    headers: serverHeaders("https://vidsrc.rip"),
    urls: {
      movie: "https://vidsrc.rip/embed/movie/{id}",
      tv: "https://vidsrc.rip/embed/tv/{id}/{season}/{episode}",
    },
  },
];

interface TmdbLookupEntry {
  promise: Promise<string | null>;
  callers: number;
  settled: boolean;
  aborted: boolean;
  /** The search result the id came from. */
  match?: { title: string; year?: number };
}

const MAX_TMDB_CACHE = 200;
const tmdbResolutionMap = new Map<string, TmdbLookupEntry>();

export function buildEmbedUrl(template?: string, id?: string, season?: number, episode?: number): string {
  if (!template?.trim() || !id) return "";
  return template
    .replaceAll("{id}", id)
    .replaceAll("{season}", String(season ?? 1))
    .replaceAll("{episode}", String(episode ?? 1));
}

type TmdbSearchHit = { key: string; kind: string; title: string; originalTitle?: string; year?: number };

/**
 * The TMDB search result that *is* this title, or undefined. Never "the closest one": the old
 * fuzzy pick fell back to the first result, so a search for The Odyssey (2026) could hand every
 * TMDB-keyed server the id of the 1997 miniseries. Movie vs series must agree, the title (or
 * original title) must be equal once normalized, the year within one when both are known, and
 * several equally-named results the year can't separate mean no match.
 */
export function pickBestTmdbMatch(results: TmdbSearchHit[], req: PlaybackRequest, isMovie: boolean, extraTitles: string[] = []) {
  if (!results.length) return undefined;
  const pool = results.filter((item) => (isMovie ? item.kind === "movie" : item.kind !== "movie"));
  const base = matchTargetFor(req, { titles: extraTitles });
  // An AniList entry for a later season carries that season's year, while TMDB files the whole
  // show under its first year: the show must simply have started by then.
  const target: MatchTarget =
    !isMovie && isAnimeReq(req) && req.media.year != null
      ? { ...base, kind: undefined, year: undefined, yearRange: { max: req.media.year + 1 }, season: undefined }
      : { ...base, kind: undefined, season: undefined };
  return pickTitleMatch(pool, target, (item) => ({ titles: [item.title, item.originalTitle], year: item.year }))?.item;
}

/**
 * For a title that had to be looked up on TMDB by name: what the search settled on, so a server's
 * row can say what it is really playing. Undefined for titles keyed by a TMDB id (nothing guessed).
 */
export function searchedTmdbMatch(req: PlaybackRequest): { title: string; year?: number } | undefined {
  const key = (req.media as { canonicalKey?: string }).canonicalKey ?? req.media.key;
  const entry = tmdbResolutionMap.get(key);
  return entry?.settled ? entry.match : undefined;
}

function attachTmdbSignal(key: string, entry: TmdbLookupEntry, signal?: AbortSignal): Promise<string | null> {
  if (!signal) {
    entry.callers++;
    return entry.promise;
  }
  if (signal.aborted) return Promise.resolve(null);
  if (!entry.settled) entry.callers++;
  return new Promise<string | null>((resolve, reject) => {
    const onAbort = () => {
      if (!entry.settled) {
        entry.callers = Math.max(0, entry.callers - 1);
        if (entry.callers === 0) {
          entry.aborted = true;
          if (tmdbResolutionMap.get(key) === entry) tmdbResolutionMap.delete(key);
        }
      }
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? null : v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) resolve(null);
        else reject(e);
      },
    );
  });
}

export function resolveTmdbId(req: PlaybackRequest, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const key = (req.media as { canonicalKey?: string }).canonicalKey ?? req.media.key;

  // Direct TMDB item
  const m = key.match(/^tmdb:(movie|tv):(\d+)$/) ?? req.media.key.match(/^tmdb:(movie|tv):(\d+)$/);
  if (m) return Promise.resolve(m[2]);

  if (req.media.tmdbId) {
    return Promise.resolve(String(req.media.tmdbId));
  }

  // De-duplicate in-flight lookups with LRU refresh
  const existing = tmdbResolutionMap.get(key);
  if (existing) {
    tmdbResolutionMap.delete(key);
    tmdbResolutionMap.set(key, existing);
    return attachTmdbSignal(key, existing, signal);
  }

  const entry: TmdbLookupEntry = {
    promise: Promise.resolve(null),
    callers: 0,
    settled: false,
    aborted: false,
  };

  entry.promise = (async () => {
    try {
      const q = req.media.title || req.media.originalTitle;
      if (!q) return null;

      const isMovie = isFilm(req.media) || Boolean((req as { isAnimeMovie?: boolean }).isAnimeMovie);
      let results = await searchTmdb(q);
      let match = pickBestTmdbMatch(results, req, isMovie);

      // Try originalTitle if no match or different
      if (!match && req.media.originalTitle && req.media.originalTitle !== q) {
        results = await searchTmdb(req.media.originalTitle);
        match = pickBestTmdbMatch(results, req, isMovie);
      }

      // If still not matched, strip secondary titles/brackets. Only anime entries ("Frieren: Beyond
      // Journey's End") may then match on the shortened name; for anything else the shorter search
      // just widens the net and the full title must still match exactly.
      if (!match && /[:\-(\[]/.test(q)) {
        const cleaned = q.split(/[:\-(\[]/)[0].trim();
        if (cleaned.length > 2) {
          results = await searchTmdb(cleaned);
          match = pickBestTmdbMatch(results, req, isMovie, isAnimeReq(req) ? [cleaned] : []);
        }
      }

      if (match?.key) {
        const matchId = match.key.match(/^tmdb:(movie|tv):(\d+)$/);
        if (matchId) {
          entry.match = { title: match.title, ...(match.year != null ? { year: match.year } : {}) };
          return matchId[2];
        }
      }
    } catch {
      /* ignore lookup failures */
    }
    return null;
  })().then((resolved) => {
    entry.settled = true;
    // Never poison the LRU map with null on transient failures or fully-aborted lookups.
    if (!resolved || entry.aborted) {
      if (tmdbResolutionMap.get(key) === entry) tmdbResolutionMap.delete(key);
      return null;
    }
    return resolved;
  });

  if (tmdbResolutionMap.size >= MAX_TMDB_CACHE) {
    const oldest = tmdbResolutionMap.keys().next().value;
    if (oldest !== undefined) tmdbResolutionMap.delete(oldest);
  }
  tmdbResolutionMap.set(key, entry);
  return attachTmdbSignal(key, entry, signal);
}

/** Fill an anime template. Returns null when missing or lacking a required id. */
export function buildAnimeUrl(
  template: string | undefined,
  anilist: string,
  mal: number | undefined,
  episode: number | undefined,
  audio: "sub" | "dub",
): string | null {
  if (!template?.trim() || !anilist) return null;
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
    isEnabled: (s: Settings) =>
      !s.disabledSources?.includes(src.id) && (!src.extra || s.enabledExtras == null || s.enabledExtras.includes(src.id)),
    async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
      if (signal.aborted) return [];
      const base = {
        providerId: src.id,
        providerName: src.name,
        kind: "embed" as const,
        via: "embed" as const,
        startParam: src.startParam,
      };
      const anime = isAnimeReq(req);
      const audio = req.audio ?? "sub";
      const anilist =
        req.media.key.match(/^anilist:(\d+)$/)?.[1] ??
        (req.media.anilistId != null ? String(req.media.anilistId) : undefined);

      // Native anime endpoint: the right cour and episode numbering, and a real sub/dub switch.
      if (anime && anilist && src.urls.anime) {
        const url = buildAnimeUrl(src.urls.anime, anilist, req.media.malId, req.courEpisode ?? req.episode, audio);
        if (url) {
          return [
            {
              ...base,
              url,
              pageUrl: url,
              headers: normalizeHeaders(src.headers, url),
              audio,
              label: `${src.name} · ${audio === "dub" ? "English dub" : "Japanese · subtitled"}`,
            },
          ];
        }
      }
      // A TMDB-keyed player can't be told which audio to serve and almost always plays the
      // original track, so it is only a fallback for "sub", never a stand-in for a dub.
      if (anime && audio === "dub") return [];

      const tmdbId = await resolveTmdbId(req, signal);
      if (!tmdbId || signal.aborted) return [];
      const isMovie = isFilm(req.media) || Boolean((req as { isAnimeMovie?: boolean }).isAnimeMovie);
      const template = isMovie ? src.urls?.movie : src.urls?.tv;
      const url = buildEmbedUrl(template, tmdbId, req.season, req.episode);
      if (!url) return [];
      const matched = searchedTmdbMatch(req);
      return [
        {
          ...base,
          url,
          pageUrl: url,
          headers: normalizeHeaders(src.headers, url),
          audio: anime ? "unknown" : undefined,
          label: `${src.name}${src.isFrench ? " · French" : ""}${anime ? " · audio not guaranteed" : ""}`,
          ...(matched ? { matched } : {}),
        },
      ];
    },
  };
}

export const embedProviders: SourceProvider[] = availableSources.map(createEmbedProvider);
