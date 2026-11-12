import { anilistDetail, animeEpisodes, animeFranchiseNodes } from "./anilist";
import {
  clampEpisode,
  clampSeason,
  normalizeEpisodes,
  normalizeTmdbSeasons,
  parseSeasonEpisodeParams,
  reconcileAnimeSeasons,
  resolveNextEpisode,
  resolvePlaybackRequest,
  stitchCourEpisodes,
  type NextEpisodeTarget,
  type RawAnilistNode,
} from "./normalizer";
import { tmdbDetail, tmdbSeason } from "./tmdb";
import type { CanonicalSeason, Episode, MediaDetail } from "./types";

export {
  clampEpisode,
  clampSeason,
  normalizeEpisodes,
  normalizeTmdbSeasons,
  parseSeasonEpisodeParams,
  reconcileAnimeSeasons,
  resolveNextEpisode,
  resolvePlaybackRequest,
  stitchCourEpisodes,
  type NextEpisodeTarget,
};

const inflightDetail = new Map<string, Promise<MediaDetail>>();
const inflightSeasonEps = new Map<string, Promise<Episode[]>>();

/**
 * Route a media key to whichever catalog owns it and return a canonical, normalized
 * `MediaDetail` with reconciled `seasons`, `specials`, and `upcomingSeasons`.
 */
export function getDetail(key: string): Promise<MediaDetail> {
  const cleanKey = key.trim();
  const existing = inflightDetail.get(cleanKey);
  if (existing) return existing;

  const p = (async (): Promise<MediaDetail> => {
    if (cleanKey.startsWith("anilist:")) {
      const [base, franchiseNodes] = await Promise.all([
        anilistDetail(cleanKey),
        animeFranchiseNodes(cleanKey).catch((): RawAnilistNode[] => []),
      ]);

      // Movies stay standalone without season pickers.
      if (base.format?.toUpperCase() === "MOVIE" || base.kind === "movie") {
        return {
          ...base,
          canonicalKey: base.key,
        };
      }

      const fallbackNode: RawAnilistNode = {
        id: base.anilistId ?? Number(cleanKey.split(":")[1]),
        idMal: base.malId,
        format: base.format?.toUpperCase() ?? "TV",
        status: base.status,
        episodes: base.episodeCount,
        duration: base.runtime,
        seasonYear: base.year,
        title: { english: base.title, romaji: base.originalTitle ?? base.title },
      };

      const nodes = franchiseNodes.length > 0 ? franchiseNodes : [fallbackNode];
      const reconciled = reconcileAnimeSeasons(nodes, cleanKey);
      const totalMainlineEps = reconciled.seasons.reduce((sum, s) => sum + s.episodeCount, 0);
      const activeSeason = clampSeason(
        {
          seasons: reconciled.seasons,
          specials: reconciled.specials,
          initialSeason: reconciled.initialSeason,
        },
        reconciled.initialSeason,
      );

      return {
        ...base,
        seasons: reconciled.seasons.length > 0 ? reconciled.seasons : undefined,
        specials: reconciled.specials.length > 0 ? reconciled.specials : undefined,
        upcomingSeasons: reconciled.upcomingSeasons.length > 0 ? reconciled.upcomingSeasons : undefined,
        canonicalKey: reconciled.canonicalKey ?? base.key,
        initialSeason: reconciled.initialSeason,
        episodeCount: activeSeason?.episodeCount ?? base.episodeCount,
        totalEpisodes: totalMainlineEps > 0 ? totalMainlineEps : base.episodeCount,
      };
    }

    return tmdbDetail(cleanKey);
  })().finally(() => inflightDetail.delete(cleanKey));

  inflightDetail.set(cleanKey, p);
  return p;
}

/**
 * Load normalized episodes for a canonical season (or Specials `season === 0`) of a title.
 * Never throws on out-of-bounds or empty seasons; returns `[]` safely.
 */
export async function getSeasonEpisodes(
  detailOrKey: MediaDetail | string,
  requestedSeason?: number | null,
): Promise<Episode[]> {
  const detail = typeof detailOrKey === "string" ? await getDetail(detailOrKey).catch(() => null) : detailOrKey;
  if (!detail || detail.kind === "movie") return [];

  // Determine the target canonical season. If a specific season number was requested, check if it exists
  // in playable `seasons` or `specials`; otherwise fall back via `clampSeason`.
  const allPlayable: CanonicalSeason[] = [
    ...(detail.seasons ?? []),
    ...(detail.specials ?? []),
  ].filter((s) => s.episodeCount > 0);

  let targetSeason: CanonicalSeason | undefined;
  if (requestedSeason != null && Number.isInteger(requestedSeason)) {
    targetSeason = allPlayable.find((s) => s.number === requestedSeason);
    // If the caller asked for an invalid/empty season index, clamp to a valid season if available.
    if (!targetSeason) {
      targetSeason = clampSeason(detail, requestedSeason);
    }
  } else {
    targetSeason = clampSeason(detail, detail.initialSeason);
  }

  if (!targetSeason) {
    // Standalone single-entry anime without a seasons array
    if (detail.key.startsWith("anilist:") && detail.episodeCount && detail.episodeCount > 0) {
      return animeEpisodes(detail.key, 1, detail.episodeCount, detail.runtime);
    }
    return [];
  }

  const seasonObj = targetSeason;
  const dedupKey = `${detail.canonicalKey ?? detail.key}:s${seasonObj.number}`;
  const running = inflightSeasonEps.get(dedupKey);
  if (running) return running;

  const task = (async (): Promise<Episode[]> => {
    if (detail.key.startsWith("tmdb:")) {
      const eps = await tmdbSeason(detail.key, seasonObj.number);
      return normalizeEpisodes(eps, seasonObj.number, undefined, detail.runtime, {
        key: detail.key,
      });
    }

    // AniList season (single cour or stitched multi-cour)
    const cours = seasonObj.cours ?? [
      {
        key: seasonObj.key ?? detail.key,
        anilistId: seasonObj.anilistId ?? detail.anilistId,
        malId: seasonObj.malId ?? detail.malId,
        title: seasonObj.name,
        startEpisode: 1,
        endEpisode: seasonObj.episodeCount,
        episodeCount: seasonObj.episodeCount,
        year: seasonObj.year,
      },
    ];

    const entries = await Promise.all(
      cours.map(async (c) => {
        const eps = await animeEpisodes(c.key, seasonObj.number, c.episodeCount, detail.runtime).catch(
          (): Episode[] => [],
        );
        return [c.key, eps] as const;
      }),
    );

    return stitchCourEpisodes(seasonObj, new Map(entries), detail.runtime);
  })().finally(() => inflightSeasonEps.delete(dedupKey));

  inflightSeasonEps.set(dedupKey, task);
  return task;
}

export const encodeKey = (k: string) => encodeURIComponent(k);
export const decodeKey = (k: string) => {
  try {
    return decodeURIComponent(k);
  } catch {
    return k;
  }
};
