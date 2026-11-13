import {
  areSameTmdbSeasonCoursSync,
  getTmdbSeasonMappingSync,
  resolveAnimeIdsSync,
  resolveCourEpisodeMappingSync,
} from "./animeMapping";
import { stripHtml } from "./format";
import type { CanonicalSeason, Episode, Media, MediaDetail, PlaybackRequest, SeasonCour } from "./types";

/** Raw AniList node shape used for franchise season/cour reconciliation. */
export interface RawAnilistNode {
  id: number;
  idMal?: number | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: number | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  nextAiringEpisode?: { episode: number; airingAt?: number } | null;
}

/** Raw TMDB season summary inside a `/tv/{id}` response. */
export interface RawTmdbSeason {
  season_number?: number | null;
  name?: string | null;
  episode_count?: number | null;
  air_date?: string | null;
}

/** Result of reconciling a series' seasons into playable seasons, specials, and upcoming/TBA entries. */
export interface ReconciledSeasons {
  seasons: CanonicalSeason[];
  specials: CanonicalSeason[];
  upcomingSeasons: CanonicalSeason[];
  /** Canonical season number corresponding to the entry that initiated the lookup. */
  initialSeason?: number;
  /** Canonical root key for the franchise (earliest mainline entry). */
  canonicalKey?: string;
}

const MAINLINE_FORMATS = new Set(["TV", "ONA"]);
const SPECIAL_FORMATS = new Set(["OVA", "SPECIAL", "TV_SHORT"]);

const WORD_NUMS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  "1st": 1,
  "2nd": 2,
  "3rd": 3,
  "4th": 4,
  "5th": 5,
  "6th": 6,
  "7th": 7,
  "8th": 8,
  "9th": 9,
  "10th": 10,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
};

/** Extract an explicit season number from a title when present (e.g. "Season 2", "2nd Season"). */
export function parseExplicitSeasonNumber(title: string): number | undefined {
  const clean = title.toLowerCase();
  const m1 = clean.match(/\bseason\s*(\d+)\b/i);
  if (m1) return Number(m1[1]);
  const m2 = clean.match(/\b(1st|2nd|3rd|[4-9]th|10th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/i);
  if (m2) return WORD_NUMS[m2[1].toLowerCase()];
  return undefined;
}

/**
 * Detect whether an AniList entry is a split cour / part continuation (e.g. "Part 2", "Cour 2",
 * "2nd Cour") rather than a brand-new numbered season.
 */
export function isCourOrPartContinuation(title: string, romajiTitle?: string | null): boolean {
  const combined = `${title} ${romajiTitle ?? ""}`;
  if (/\b(?:part|cour)\s*(?:[2-9]|\d{2,}|ii|iii|iv)\b/i.test(combined)) return true;
  if (/\b(?:2nd|second|3rd|third|final)\s+(?:cour|part)\b/i.test(combined)) return true;
  return false;
}

/** Detect short-form ONA/mini-anime spin-offs or specials (e.g. "●● no Mahou", "Mini Anime", recaps). */
function isShortOrSpecialNode(node: RawAnilistNode, rootFormat?: string | null): boolean {
  const fmt = node.format ?? "";
  if (SPECIAL_FORMATS.has(fmt)) return true;
  const title = `${node.title?.english ?? ""} ${node.title?.romaji ?? ""}`.toLowerCase();
  if (/\b(mini\s*anime|specials?|ova|oad|recap|summary|picture\s*drama|chibi)\b/i.test(title)) return true;
  // Short-duration ONAs (< 15 min per episode) attached to a full-length TV series are mini-anime specials.
  if (fmt === "ONA" && rootFormat === "TV" && node.duration != null && node.duration > 0 && node.duration < 15) {
    return true;
  }
  return false;
}

/** Calculate how many episodes have aired or are available for an AniList entry. */
export function resolveAnilistEpisodeCount(node: RawAnilistNode): number {
  const status = node.status ?? "";
  if (status === "NOT_YET_RELEASED") return 0;
  if (node.nextAiringEpisode && typeof node.nextAiringEpisode.episode === "number") {
    const aired = Math.max(0, node.nextAiringEpisode.episode - 1);
    // For currently airing shows, use the total planned episodes if known and > 0, or aired count if total is unknown.
    if (typeof node.episodes === "number" && node.episodes > 0) return node.episodes;
    return aired;
  }
  if (typeof node.episodes === "number" && node.episodes > 0) return node.episodes;
  return 0;
}

/** Sort key for chronological ordering of AniList nodes. */
function nodeSortKey(m: RawAnilistNode): number {
  const y = m.startDate?.year ?? m.seasonYear ?? 9999;
  const mo = m.startDate?.month ?? 12;
  const d = m.startDate?.day ?? 31;
  return y * 10000 + mo * 100 + d;
}

/**
 * Normalize TMDB `seasons` array into playable `seasons`, `specials` (`Season 0`), and
 * `upcomingSeasons` (0-episode / unaired TBA entries).
 */
export function normalizeTmdbSeasons(
  rawSeasons: RawTmdbSeason[] | undefined | null,
  seriesKey?: string,
  tmdbId?: number,
): ReconciledSeasons {
  const seasons: CanonicalSeason[] = [];
  const specials: CanonicalSeason[] = [];
  const upcomingSeasons: CanonicalSeason[] = [];

  if (!Array.isArray(rawSeasons)) {
    return { seasons, specials, upcomingSeasons };
  }

  const nowIso = new Date().toISOString().slice(0, 10);

  for (const s of rawSeasons) {
    if (!s || typeof s.season_number !== "number" || !Number.isInteger(s.season_number) || s.season_number < 0) {
      continue;
    }
    const num = s.season_number;
    const epCount = typeof s.episode_count === "number" && Number.isFinite(s.episode_count) && s.episode_count > 0
      ? Math.floor(s.episode_count)
      : 0;
    const airDate = typeof s.air_date === "string" && s.air_date.trim() ? s.air_date.trim() : undefined;
    const year = airDate ? Number(airDate.slice(0, 4)) || undefined : undefined;
    const name = (s.name && s.name.trim()) || (num === 0 ? "Specials" : `Season ${num}`);

    if (num === 0) {
      if (epCount > 0) {
        specials.push({
          number: 0,
          name: name || "Specials",
          episodeCount: epCount,
          year,
          airDate,
          status: "special",
          key: seriesKey,
        });
      }
      continue;
    }

    // Exclude seasons with 0 episodes or strictly future air dates when no episodes exist yet.
    if (epCount <= 0) {
      upcomingSeasons.push({
        number: num,
        name,
        episodeCount: 0,
        year,
        airDate,
        status: "upcoming",
        key: seriesKey,
      });
      continue;
    }

    const isUpcoming = !!airDate && airDate > nowIso;
    const mapped = tmdbId ? getTmdbSeasonMappingSync(tmdbId, num, epCount) : undefined;
    seasons.push({
      number: num,
      name,
      episodeCount: epCount,
      year,
      airDate,
      status: isUpcoming ? "upcoming" : "aired",
      key: seriesKey,
      ...(mapped?.anilistId ? { anilistId: mapped.anilistId } : {}),
      ...(mapped?.malId ? { malId: mapped.malId } : {}),
      ...(mapped?.cours ? { cours: mapped.cours } : {}),
    });
  }

  seasons.sort((a, b) => a.number - b.number);
  upcomingSeasons.sort((a, b) => a.number - b.number);

  return {
    seasons,
    specials,
    upcomingSeasons,
    canonicalKey: seriesKey ?? (tmdbId ? `tmdb:tv:${tmdbId}` : undefined),
    initialSeason: seasons[0]?.number,
  };
}

/**
 * Reconcile a franchise's AniList nodes (and optional TMDB season counts) into canonical
 * playable `seasons` (with split cours folded), `specials`, and `upcomingSeasons`.
 */
export function reconcileAnimeSeasons(
  nodes: RawAnilistNode[],
  requestedKey?: string,
  tmdbSeasons?: CanonicalSeason[],
): ReconciledSeasons {
  const seasons: CanonicalSeason[] = [];
  const specials: CanonicalSeason[] = [];
  const upcomingSeasons: CanonicalSeason[] = [];

  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { seasons, specials, upcomingSeasons };
  }

  const requestedId = requestedKey?.startsWith("anilist:") ? Number(requestedKey.split(":")[1]) : undefined;
  const deduped = new Map<number, RawAnilistNode>();
  for (const n of nodes) {
    if (n && typeof n.id === "number" && Number.isFinite(n.id)) {
      deduped.set(n.id, n);
    }
  }

  const sorted = [...deduped.values()].sort((a, b) => nodeSortKey(a) - nodeSortKey(b) || a.id - b.id);
  const rootTv = sorted.find((n) => n.format === "TV") ?? sorted[0];
  const rootFormat = rootTv?.format ?? "TV";

  const mainlineAired: RawAnilistNode[] = [];
  let specialIdx = 0;

  for (const node of sorted) {
    const title = node.title?.english || node.title?.romaji || `Season`;
    const epCount = resolveAnilistEpisodeCount(node);
    const year = node.seasonYear ?? node.startDate?.year ?? undefined;
    const malId = node.idMal ?? resolveAnimeIdsSync({ anilistId: node.id }).malId;
    const isShortOrSpecial = isShortOrSpecialNode(node, rootFormat);
    const isMainlineFormat = MAINLINE_FORMATS.has(node.format ?? "") && !isShortOrSpecial;

    if (isShortOrSpecial) {
      if (epCount > 0) {
        specialIdx++;
        specials.push({
          number: 0,
          name: specialIdx === 1 ? "Specials" : `Specials ${specialIdx}`,
          episodeCount: epCount,
          year,
          status: "special",
          key: `anilist:${node.id}`,
          anilistId: node.id,
          malId,
          cours: [
            {
              key: `anilist:${node.id}`,
              anilistId: node.id,
              malId,
              title,
              startEpisode: 1,
              endEpisode: epCount,
              episodeCount: epCount,
              year,
            },
          ],
        });
      }
      continue;
    }

    if (!isMainlineFormat && node.id !== requestedId) {
      continue;
    }

    if (epCount <= 0 || node.status === "NOT_YET_RELEASED") {
      upcomingSeasons.push({
        number: upcomingSeasons.length + 1,
        name: title,
        episodeCount: 0,
        year,
        status: "upcoming",
        key: `anilist:${node.id}`,
        anilistId: node.id,
        malId,
      });
      continue;
    }

    mainlineAired.push(node);
  }

  // Group mainline aired nodes into canonical seasons by folding split cours/parts.
  const validTmdbSeasons = (tmdbSeasons ?? []).filter((s) => s.number > 0 && s.episodeCount > 0);

  for (const node of mainlineAired) {
    const title = node.title?.english || node.title?.romaji || "Season";
    const romaji = node.title?.romaji ?? undefined;
    const epCount = resolveAnilistEpisodeCount(node);
    const year = node.seasonYear ?? node.startDate?.year ?? undefined;
    const explicitSeason = parseExplicitSeasonNumber(title) ?? (romaji ? parseExplicitSeasonNumber(romaji) : undefined);
    const isContinuationByTitle = isCourOrPartContinuation(title, romaji);

    const prevSeason = seasons[seasons.length - 1];
    let foldIntoPrev = false;

    if (prevSeason) {
      if (isContinuationByTitle) {
        // E.g. "Spy x Family Part 2", "Season 1 Part 2", "Season 2 Cour 2"
        if (explicitSeason == null || explicitSeason === prevSeason.number) {
          foldIntoPrev = true;
        }
      } else if (validTmdbSeasons.length > 0) {
        // Cross-check against TMDB season episode count: if TMDB groups Cour 1 + Cour 2 into one season
        // (e.g., TMDB S1 has 24 eps while AniList Cour 1 has 12 and Cour 2 has 12), fold them together.
        const matchingTmdb = validTmdbSeasons[prevSeason.number - 1];
        const ExplicitlyNextSeason = explicitSeason != null && explicitSeason > prevSeason.number;
        if (
          matchingTmdb &&
          !ExplicitlyNextSeason &&
          prevSeason.episodeCount < matchingTmdb.episodeCount &&
          prevSeason.episodeCount + epCount <= matchingTmdb.episodeCount + 1
        ) {
          foldIntoPrev = true;
        }
      }

      if (
        !foldIntoPrev &&
        prevSeason.anilistId != null &&
        (explicitSeason == null || explicitSeason === prevSeason.number) &&
        areSameTmdbSeasonCoursSync(prevSeason.anilistId, node.id)
      ) {
        foldIntoPrev = true;
      }
    }

    const nodeMalId = node.idMal ?? resolveAnimeIdsSync({ anilistId: node.id }).malId;

    if (foldIntoPrev && prevSeason) {
      const startEpisode = prevSeason.episodeCount + 1;
      const endEpisode = prevSeason.episodeCount + epCount;
      const cour: SeasonCour = {
        key: `anilist:${node.id}`,
        anilistId: node.id,
        malId: nodeMalId,
        title,
        startEpisode,
        endEpisode,
        episodeCount: epCount,
        year,
      };
      prevSeason.cours = [...(prevSeason.cours ?? []), cour];
      prevSeason.episodeCount = endEpisode;
      if (node.status === "RELEASING") prevSeason.status = "airing";
    } else {
      const seasonNumber = seasons.length + 1;
      const cour: SeasonCour = {
        key: `anilist:${node.id}`,
        anilistId: node.id,
        malId: nodeMalId,
        title,
        startEpisode: 1,
        endEpisode: epCount,
        episodeCount: epCount,
        year,
      };
      seasons.push({
        number: seasonNumber,
        name: `Season ${seasonNumber}`,
        episodeCount: epCount,
        year,
        status: node.status === "RELEASING" ? "airing" : "aired",
        key: `anilist:${node.id}`,
        anilistId: node.id,
        malId: nodeMalId,
        cours: [cour],
      });
    }
  }

  // Re-number upcoming seasons to follow the aired mainline seasons.
  upcomingSeasons.forEach((u, idx) => {
    u.number = seasons.length + idx + 1;
  });

  // Consolidate multiple special nodes into a single Season 0 entry with multiple cours if > 1.
  let mergedSpecials: CanonicalSeason[] = [];
  if (specials.length === 1) {
    mergedSpecials = specials;
  } else if (specials.length > 1) {
    let running = 0;
    const allSpecialCours: SeasonCour[] = [];
    for (const sp of specials) {
      for (const c of sp.cours ?? []) {
        const startEpisode = running + 1;
        const endEpisode = running + c.episodeCount;
        running = endEpisode;
        allSpecialCours.push({ ...c, startEpisode, endEpisode });
      }
    }
    mergedSpecials = [
      {
        number: 0,
        name: "Specials",
        episodeCount: running,
        year: specials[0].year,
        status: "special",
        key: specials[0].key,
        anilistId: specials[0].anilistId,
        malId: specials[0].malId,
        cours: allSpecialCours,
      },
    ];
  }

  // Find which canonical season corresponds to the requested key.
  let initialSeason: number | undefined;
  if (requestedKey) {
    const matchedMain = seasons.find(
      (s) => s.key === requestedKey || s.cours?.some((c) => c.key === requestedKey),
    );
    if (matchedMain) {
      initialSeason = matchedMain.number;
    } else if (mergedSpecials.some((s) => s.key === requestedKey || s.cours?.some((c) => c.key === requestedKey))) {
      initialSeason = 0;
    }
  }
  if (initialSeason == null && seasons.length > 0) {
    initialSeason = seasons[0].number;
  }

  const canonicalKey = seasons[0]?.key ?? (mainlineAired[0] ? `anilist:${mainlineAired[0].id}` : requestedKey);

  return {
    seasons,
    specials: mergedSpecials,
    upcomingSeasons,
    initialSeason,
    canonicalKey,
  };
}

/** Normalize raw episode items for a single season, ensuring strict numbering, fallback titles, and no NaN values. */
export function normalizeEpisodes(
  rawEpisodes: Partial<Episode>[] | undefined | null,
  seasonNumber: number,
  expectedCount?: number,
  defaultRuntime?: number,
  courMeta?: { key: string; malId?: number },
): Episode[] {
  const safeSeason = Number.isInteger(seasonNumber) && seasonNumber >= 0 ? seasonNumber : 1;
  const byNumber = new Map<number, Episode>();

  if (Array.isArray(rawEpisodes)) {
    for (const raw of rawEpisodes) {
      if (!raw || typeof raw.number !== "number" || !Number.isInteger(raw.number) || raw.number < 1) {
        continue;
      }
      const n = raw.number;
      byNumber.set(n, {
        season: safeSeason,
        number: n,
        title: raw.title && String(raw.title).trim() ? stripHtml(String(raw.title).trim()) : `Episode ${n}`,
        overview: raw.overview && String(raw.overview).trim() ? stripHtml(String(raw.overview).trim()) : undefined,
        still: raw.still && String(raw.still).trim() ? String(raw.still).trim() : undefined,
        runtime: typeof raw.runtime === "number" && Number.isFinite(raw.runtime) && raw.runtime > 0 ? Math.round(raw.runtime) : defaultRuntime,
        airDate: raw.airDate && String(raw.airDate).trim() ? String(raw.airDate).trim() : undefined,
        rating: typeof raw.rating === "number" && Number.isFinite(raw.rating) && raw.rating > 0 ? Math.round(raw.rating * 10) / 10 : undefined,
        sourceKey: raw.sourceKey ?? courMeta?.key,
        malId: raw.malId ?? courMeta?.malId,
        courEpisode: raw.courEpisode ?? n,
      });
    }
  }

  const count = typeof expectedCount === "number" && Number.isFinite(expectedCount) && expectedCount > 0 ? Math.floor(expectedCount) : 0;
  for (let n = 1; n <= count; n++) {
    if (!byNumber.has(n)) {
      byNumber.set(n, {
        season: safeSeason,
        number: n,
        title: `Episode ${n}`,
        runtime: defaultRuntime,
        sourceKey: courMeta?.key,
        malId: courMeta?.malId,
        courEpisode: n,
      });
    }
  }

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Stitch episodes across multiple cours of a single canonical season into one contiguous
 * 1..N episode list while preserving each cour's `sourceKey`, `malId`, and `courEpisode`.
 */
export function stitchCourEpisodes(
  season: CanonicalSeason,
  courEpisodesMap: Map<string, Episode[]>,
  defaultRuntime?: number,
): Episode[] {
  const cours = season.cours;
  if (!cours || cours.length === 0) {
    return normalizeEpisodes(
      courEpisodesMap.get(season.key ?? "") ?? [],
      season.number,
      season.episodeCount,
      defaultRuntime,
      season.key ? { key: season.key, malId: season.malId } : undefined,
    );
  }

  const stitched: Episode[] = [];
  for (const cour of cours) {
    const raw = courEpisodesMap.get(cour.key) ?? [];
    const normalizedCour = normalizeEpisodes(raw, season.number, cour.episodeCount, defaultRuntime, {
      key: cour.key,
      malId: cour.malId,
    });
    for (let i = 0; i < cour.episodeCount; i++) {
      const courEpNum = i + 1;
      const canonicalEpNum = cour.startEpisode + i;
      const found = normalizedCour.find((e) => e.number === courEpNum);
      const rawTitle = found?.title;
      const isGenericTitle = !rawTitle || /^Episode\s+\d+$/i.test(rawTitle);
      stitched.push({
        season: season.number,
        number: canonicalEpNum,
        title: isGenericTitle ? `Episode ${canonicalEpNum}` : rawTitle!,
        overview: found?.overview,
        still: found?.still,
        runtime: found?.runtime ?? defaultRuntime,
        airDate: found?.airDate,
        rating: found?.rating,
        sourceKey: cour.key,
        malId: cour.malId,
        courEpisode: courEpNum,
      });
    }
  }
  return stitched;
}

/** Parse and sanitize season/episode parameters from URL search params or raw inputs. */
export function parseSeasonEpisodeParams(
  input?: URLSearchParams | { s?: string | number | null; e?: string | number | null } | null,
): { season?: number; episode?: number } {
  if (!input) return {};
  const rawS = input instanceof URLSearchParams ? input.get("s") : input.s;
  const rawE = input instanceof URLSearchParams ? input.get("e") : input.e;

  let season: number | undefined;
  if (rawS != null && String(rawS).trim() !== "") {
    const n = Number(rawS);
    if (Number.isInteger(n) && n >= 0 && n <= 1000) {
      season = n;
    }
  }

  let episode: number | undefined;
  if (rawE != null && String(rawE).trim() !== "") {
    const n = Number(rawE);
    if (Number.isInteger(n) && n >= 1 && n <= 10000) {
      episode = n;
    }
  }

  return { season, episode };
}

/**
 * Clamp a requested season number to a valid, non-empty `CanonicalSeason` on `detail`.
 * Returns `undefined` when the title has no playable seasons at all.
 */
export function clampSeason(
  detail: Pick<MediaDetail, "seasons" | "specials" | "initialSeason"> | null | undefined,
  requestedSeason?: number | null,
): CanonicalSeason | undefined {
  if (!detail) return undefined;
  const playableSeasons = (detail.seasons ?? []).filter((s) => s.number > 0 && s.episodeCount > 0);
  const playableSpecials = (detail.specials ?? []).filter((s) => s.episodeCount > 0);

  if (requestedSeason === 0 && playableSpecials.length > 0) {
    return playableSpecials[0];
  }

  if (requestedSeason != null && Number.isInteger(requestedSeason) && requestedSeason > 0) {
    const exact = playableSeasons.find((s) => s.number === requestedSeason);
    if (exact) return exact;
  }

  if (detail.initialSeason != null) {
    if (detail.initialSeason === 0 && playableSpecials.length > 0) return playableSpecials[0];
    const initMatch = playableSeasons.find((s) => s.number === detail.initialSeason);
    if (initMatch) return initMatch;
  }

  if (playableSeasons.length > 0) return playableSeasons[0];
  if (playableSpecials.length > 0) return playableSpecials[0];
  return undefined;
}

/**
 * Clamp a requested episode number into `[1, maxEpisodes]` for a given season or standalone show.
 * Returns `undefined` when `maxEpisodes <= 0`.
 */
export function clampEpisode(
  season: Pick<CanonicalSeason, "episodeCount"> | null | undefined,
  requestedEpisode?: number | null,
  fallbackEpisodeCount?: number,
): number | undefined {
  const max =
    season && typeof season.episodeCount === "number" && season.episodeCount > 0
      ? season.episodeCount
      : typeof fallbackEpisodeCount === "number" && fallbackEpisodeCount > 0
        ? fallbackEpisodeCount
        : 0;
  if (max <= 0) return undefined;
  if (requestedEpisode == null || !Number.isFinite(requestedEpisode)) return 1;
  const intEp = Math.floor(requestedEpisode);
  return Math.max(1, Math.min(max, intEp));
}

/**
 * Resolve a canonical `(detail, season, episode, audio)` tuple into a `PlaybackRequest`
 * that maps multi-cour/multi-season anime to the exact underlying cour's AniList/MAL ID
 * and cour-relative episode while preserving canonical `season`, `episode`, and `absolute`.
 */
export function resolvePlaybackRequest(
  detail: MediaDetail,
  requestedSeason?: number | null,
  requestedEpisode?: number | null,
  audio?: "sub" | "dub",
): PlaybackRequest | null {
  if (!detail) return null;

  if (detail.kind === "movie") {
    return { media: detail, audio };
  }

  const targetSeason = clampSeason(detail, requestedSeason);
  let effectiveRequestedEp = requestedEpisode;
  if (
    requestedSeason == null &&
    targetSeason?.cours &&
    targetSeason.cours.length > 1
  ) {
    const matchedCour = targetSeason.cours.find((c) => c.key === detail.key);
    if (matchedCour && matchedCour.startEpisode > 1) {
      if (effectiveRequestedEp == null) {
        effectiveRequestedEp = matchedCour.startEpisode;
      } else if (effectiveRequestedEp >= 1 && effectiveRequestedEp <= matchedCour.episodeCount) {
        effectiveRequestedEp = matchedCour.startEpisode + Math.floor(effectiveRequestedEp) - 1;
      }
    }
  }
  const targetEpisode = clampEpisode(targetSeason, effectiveRequestedEp, detail.episodeCount);

  // If a series/anime has no aired episodes yet, return null so the caller renders a safe empty state.
  if (!targetSeason && !targetEpisode) {
    return null;
  }

  const seasonNum = targetSeason?.number;
  const epNum = targetEpisode ?? 1;

  // Compute absolute episode number across prior mainline seasons.
  let absolute: number | undefined;
  if (detail.seasons?.length && seasonNum != null && seasonNum > 0) {
    const before = detail.seasons
      .filter((s) => s.number > 0 && s.number < seasonNum)
      .reduce((sum, s) => sum + s.episodeCount, 0);
    if (before > 0) absolute = before + epNum;
  }

  // Check if the target season has cour mappings (AniList multi-season or multi-cour).
  const cour =
    targetSeason?.cours?.find((c) => epNum >= c.startEpisode && epNum <= c.endEpisode) ??
    targetSeason?.cours?.[0];

  if (cour) {
    const courEpisode = Math.max(1, epNum - cour.startEpisode + 1);
    const isTmdbDetail = detail.key.startsWith("tmdb:");
    const baseMalId = cour.malId ?? targetSeason?.malId ?? detail.malId;
    const baseAnilistId = cour.anilistId ?? detail.anilistId;
    const mappedIds =
      baseMalId == null || baseAnilistId == null || detail.tmdbId == null
        ? resolveAnimeIdsSync({
            anilistId: baseAnilistId,
            malId: baseMalId,
            tmdbId: detail.tmdbId,
            key: detail.key,
            kind: detail.kind,
            season: seasonNum,
            episode: epNum,
          })
        : undefined;
    const mediaForCour: Media = {
      ...detail,
      key: isTmdbDetail ? detail.key : cour.key,
      anilistId: baseAnilistId ?? mappedIds?.anilistId,
      malId: baseMalId ?? mappedIds?.malId,
      tmdbId: detail.tmdbId ?? mappedIds?.tmdbId,
    };
    return {
      media: mediaForCour,
      season: seasonNum,
      episode: epNum,
      courEpisode,
      absolute,
      audio,
    };
  }

  if (detail.kind === "anime" || detail.key.startsWith("anilist:")) {
    const mapped = resolveCourEpisodeMappingSync({
      key: detail.key,
      kind: detail.kind,
      tmdbId: detail.tmdbId,
      anilistId: detail.anilistId,
      malId: detail.malId,
      season: seasonNum,
      episode: epNum,
    });
    if (mapped.malId || mapped.anilistId || mapped.tmdbId || mapped.source) {
      return {
        media: {
          ...detail,
          anilistId: detail.anilistId ?? mapped.anilistId,
          malId: detail.malId ?? mapped.malId,
          tmdbId: detail.tmdbId ?? mapped.tmdbId,
        },
        season: seasonNum,
        episode: epNum,
        courEpisode: mapped.courEpisode,
        absolute,
        audio,
      };
    }
  }

  return {
    media: detail,
    season: seasonNum,
    episode: epNum,
    absolute,
    audio,
  };
}

export interface NextEpisodeTarget {
  s?: number;
  e: number;
  key?: string;
  courEpisode?: number;
  malId?: number;
  label: string;
}

/**
 * Determine the next playable episode after `(currentSeason, currentEpisode)` across
 * stitched cours and canonical seasons, returning `null` at the end of the aired run.
 */
export function resolveNextEpisode(
  detail: MediaDetail | null | undefined,
  currentSeason?: number | null,
  currentEpisode?: number | null,
  audio?: "sub" | "dub",
): NextEpisodeTarget | null {
  if (!detail || detail.kind === "movie" || currentEpisode == null) return null;

  const allSeasons = [...(detail.seasons ?? []), ...(detail.specials ?? [])].filter((s) => s.episodeCount > 0);
  if (allSeasons.length > 0 && currentSeason != null) {
    const cur = allSeasons.find((s) => s.number === currentSeason);
    if (cur && currentEpisode < cur.episodeCount) {
      const nextEp = currentEpisode + 1;
      const req = resolvePlaybackRequest(detail, currentSeason, nextEp, audio);
      const prefix = currentSeason === 0 ? "Specials" : `Season ${currentSeason}`;
      return {
        s: currentSeason,
        e: nextEp,
        key: req?.media.key,
        courEpisode: req?.courEpisode,
        malId: req?.media.malId,
        label: `${prefix} · Episode ${nextEp}`,
      };
    }
    if (currentSeason > 0) {
      const nextSeason = (detail.seasons ?? [])
        .filter((s) => s.number > currentSeason && s.episodeCount > 0)
        .sort((a, b) => a.number - b.number)[0];
      if (nextSeason) {
        const req = resolvePlaybackRequest(detail, nextSeason.number, 1, audio);
        return {
          s: nextSeason.number,
          e: 1,
          key: req?.media.key,
          courEpisode: req?.courEpisode,
          malId: req?.media.malId,
          label: `Season ${nextSeason.number} · Episode 1`,
        };
      }
    }
    return null;
  }

  if (detail.episodeCount && currentEpisode < detail.episodeCount) {
    const nextEp = currentEpisode + 1;
    return {
      s: undefined,
      e: nextEp,
      key: detail.key,
      label: `Episode ${nextEp}`,
    };
  }

  return null;
}
