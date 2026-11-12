export type MediaKind = "movie" | "tv" | "anime";

/** One shape for everything the UI shows, whatever catalog it came from. */
export interface Media {
  /** Stable key, e.g. "tmdb:movie:603", "tmdb:tv:1399", "anilist:21". */
  key: string;
  kind: MediaKind;
  title: string;
  originalTitle?: string;
  overview: string;
  year?: number;
  rating?: number; // 0-10
  poster?: string;
  backdrop?: string;
  genres: string[];
  /** Transparent title-treatment image (TMDB logos), when one exists. */
  logo?: string;
  /** Dominant artwork color when the catalog gives one (AniList). Drives the stage light. */
  color?: string;
  /** AniList entries: the matching MyAnimeList id, which some anime players key on. */
  malId?: number;
  /** AniList entry id when resolved or mapped. */
  anilistId?: number;
  /** TMDB entry id when resolved or mapped. */
  tmdbId?: number;
  /** Search results: how many seasons were folded into this entry. */
  seasonCount?: number;
  /** Fallback artwork hue when a title has no image. */
  hue?: number;
  /** ISO 639-1 original language code (e.g. "en", "ja", "ko"). */
  originalLanguage?: string;
}

/** A single cour or split part within a canonical anime season. */
export interface SeasonCour {
  /** Underlying catalog key for this cour/part (e.g. "anilist:154587"). */
  key: string;
  anilistId?: number;
  malId?: number;
  title: string;
  /** 1-based inclusive start episode within the parent canonical season. */
  startEpisode: number;
  /** 1-based inclusive end episode within the parent canonical season. */
  endEpisode: number;
  episodeCount: number;
  year?: number;
}

/** Canonical season representation unified across TMDB and AniList. */
export interface CanonicalSeason {
  /** 1-based season number for mainline seasons; 0 (or negative/special index) for Specials. */
  number: number;
  name: string;
  episodeCount: number;
  year?: number;
  airDate?: string;
  status?: "aired" | "airing" | "upcoming" | "special";
  /** Primary catalog key for this season (e.g. "anilist:154587" or "tmdb:tv:1399"). */
  key?: string;
  anilistId?: number;
  malId?: number;
  /** Ordered cours/parts folded into this canonical season (multi-cour anime). */
  cours?: SeasonCour[];
}

export interface Episode {
  season: number;
  number: number;
  title: string;
  overview?: string;
  still?: string;
  runtime?: number;
  airDate?: string;
  rating?: number;
  /** For multi-cour anime: the specific cour's catalog key, MAL id, and cour-relative episode number. */
  sourceKey?: string;
  malId?: number;
  courEpisode?: number;
}

export interface MediaDetail extends Media {
  runtime?: number;
  tagline?: string;
  /** Playable mainline seasons (number > 0 and episodeCount > 0), with split cours folded. */
  seasons?: CanonicalSeason[];
  /** Season 0 Specials, OVAs, and spin-off shorts separated from mainline seasons. */
  specials?: CanonicalSeason[];
  /** Announced / TBA / unaired seasons with 0 aired episodes, excluded from the primary selector. */
  upcomingSeasons?: CanonicalSeason[];
  /** Root/franchise canonical key when multiple AniList entries belong to one series. */
  canonicalKey?: string;
  /** Which canonical season number corresponds to the specific entry key that was opened. */
  initialSeason?: number;
  /** Absolute episode count (anime). */
  episodeCount?: number;
  trailerYouTubeId?: string;
  cast: { name: string; character?: string; photo?: string; /** Anime: the voice actor. */ actor?: string }[];
  /** Key people behind it: directors, writers, creators, composers, studios' staff. */
  crew: { name: string; job: string; photo?: string }[];
  /** ISO date of first release / first air date. */
  releaseDate?: string;
  endDate?: string;
  budget?: number;
  revenue?: number;
  originalLanguage?: string;
  /** Age rating in the user's region (falls back to US). */
  certification?: string;
  companies?: string[];
  networks?: string[];
  countries?: string[];
  imdbId?: string;
  homepage?: string;
  voteCount?: number;
  collection?: string;
  /** Series: what aired last and what airs next. */
  lastEpisode?: { season: number; episode: number; name?: string; airDate?: string };
  nextEpisode?: { season: number; episode: number; name?: string; airDate?: string };
  totalEpisodes?: number;
  /** Anime: source material and season label, e.g. "Manga", "Fall 2025". */
  source?: string;
  seasonLabel?: string;
  format?: string;
  /** When this record was fetched, so the UI can say how fresh it is. */
  fetchedAt?: number;
  related: Media[];
  status?: string;
  nextAiring?: { episode: number; at: number };
}

/** What the player asks the source layer to find. */
export interface PlaybackRequest {
  media: Media;
  season?: number;
  episode?: number;
  /** Cour-relative episode number when an anime season folds multiple AniList cours/parts. */
  courEpisode?: number;
  /** Episode number counted across all seasons, for libraries that number anime absolutely ("Show - 26"). */
  absolute?: number;
  /** Anime only: subtitled original audio or English dub. */
  audio?: "sub" | "dub";
}

export const reqKey = (r: PlaybackRequest) =>
  `${r.media.key}${r.season != null ? `:s${r.season}` : ""}${r.episode != null ? `:e${r.episode}` : ""}${r.audio ? `:${r.audio}` : ""}`;
