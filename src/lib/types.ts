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
  /** Used for generated artwork in demo mode. */
  hue?: number;
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
}

export interface MediaDetail extends Media {
  runtime?: number;
  tagline?: string;
  seasons?: { number: number; name: string; episodeCount: number }[];
  /** Absolute episode count (anime). */
  episodeCount?: number;
  trailerYouTubeId?: string;
  cast: { name: string; character?: string; photo?: string }[];
  related: Media[];
  status?: string;
  nextAiring?: { episode: number; at: number };
}

/** What the player asks the source layer to find. */
export interface PlaybackRequest {
  media: Media;
  season?: number;
  episode?: number;
  /** Anime only: subtitled original audio or English dub. */
  audio?: "sub" | "dub";
}

export const reqKey = (r: PlaybackRequest) =>
  `${r.media.key}${r.season != null ? `:s${r.season}` : ""}${r.episode != null ? `:e${r.episode}` : ""}${r.audio ? `:${r.audio}` : ""}`;
