import { RESUME_MIN_SEC, type ProgressEntry } from "./progress";
import { isFilm } from "./types";

export interface GenreStat {
  genre: string;
  count: number;
  pct: number;
}

export interface ActivityStats {
  totalSeconds: number;
  totalHours: number;
  finishedFilms: number;
  completedEpisodes: number;
  activeShows: number;
  caughtUpShows: number;
  watchlistCount: number;
  topGenres: GenreStat[];
  history: ProgressEntry[];
}

/**
 * Compute aggregate viewing statistics and sorted watch history across v2 per-episode
 * progress entries and legacy v1 single-cursor entries.
 */
export function computeActivityStats(entries: ProgressEntry[], watchlistCount: number): ActivityStats {
  let totalSeconds = 0;
  let finishedFilms = 0;
  let completedEpisodes = 0;
  let activeShows = 0;
  let caughtUpShows = 0;
  const genreCounts = new Map<string, number>();
  let totalGenreHits = 0;
  const history: ProgressEntry[] = [];

  for (const entry of entries) {
    if (!entry?.media?.key) continue;
    const epEntries = entry.episodes ? Object.values(entry.episodes) : [];
    const hasActivity = Boolean(
      entry.finished ||
        entry.caughtUp ||
        entry.position > RESUME_MIN_SEC ||
        epEntries.length > 0,
    );
    if (!hasActivity) continue;
    history.push(entry);

    const film = isFilm(entry.media);
    if (film) {
      if (entry.finished) finishedFilms += 1;
    } else if (entry.caughtUp && !entry.finished) {
      caughtUpShows += 1;
    } else if (!entry.finished) {
      activeShows += 1;
    }

    if (epEntries.length > 0) {
      for (const ep of epEntries) {
        const watchedSec = ep.completed && ep.duration > 0 ? ep.duration : Math.max(0, ep.position || 0);
        totalSeconds += watchedSec;
        if (!film && ep.completed) completedEpisodes += 1;
      }
    } else {
      const watchedSec = entry.finished && entry.duration > 0 ? entry.duration : Math.max(0, entry.position || 0);
      totalSeconds += watchedSec;
      if (!film && (entry.finished || entry.caughtUp)) completedEpisodes += 1;
    }

    const weight = film ? (entry.finished ? 2 : 1) : Math.max(1, Math.min(5, epEntries.length || 1));
    for (const g of entry.media.genres ?? []) {
      if (!g) continue;
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + weight);
      totalGenreHits += weight;
    }
  }

  history.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const topGenres: GenreStat[] = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([genre, count]) => ({
      genre,
      count,
      pct: totalGenreHits > 0 ? Math.round((count / totalGenreHits) * 100) : 0,
    }));

  const totalHours = Math.round((totalSeconds / 3600) * 10) / 10;

  return {
    totalSeconds,
    totalHours,
    finishedFilms,
    completedEpisodes,
    activeShows,
    caughtUpShows,
    watchlistCount,
    topGenres,
    history,
  };
}
