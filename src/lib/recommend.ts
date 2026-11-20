import type { ProgressEntry } from "./progress";
import { laneOf, tasteFrom, type Lane } from "./taste";
import type { Media } from "./types";
import { isUnreleasedMedia } from "./normalizer";

export type RecommendMode = "for-you" | "queue" | "because" | "acclaimed" | "surprise";
export type RecommendBadge = "queue" | "because" | "taste" | "fresh" | "gem";

export interface RecommendedPick {
  media: Media;
  score: number;
  matchPct: number;
  reason: string;
  badge: RecommendBadge;
  seedTitle?: string;
}

export interface SeedRelated {
  source: Media;
  items: Media[];
}

export interface GenreWeight {
  genre: string;
  weight: number;
}

const DAY = 86_400_000;
const HALF_LIFE_DAYS = 28;

/** Derive weighted genre affinity from watch history (enriched by catalog metadata) and My List. */
export function extractGenreProfile(
  progress: ProgressEntry[],
  watchlist: { media: Media; addedAt: number }[],
  catalogByKey: Map<string, Media>,
  now = Date.now(),
): GenreWeight[] {
  const weights = new Map<string, number>();
  const seen = new Set<string>();

  for (const p of [...progress].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const id = p.media.title?.toLowerCase() || p.media.key;
    if (seen.has(id)) continue;
    seen.add(id);
    const catalogHit = catalogByKey.get(p.media.key);
    const genres = p.media.genres?.length ? p.media.genres : catalogHit?.genres ?? [];
    if (!genres.length) continue;
    const ageDays = Math.max(0, (now - p.updatedAt) / DAY);
    const w = (p.finished ? 1.45 : 1) * 0.5 ** (ageDays / HALF_LIFE_DAYS);
    genres.slice(0, 3).forEach((g, idx) => {
      const factor = idx === 0 ? 1 : idx === 1 ? 0.72 : 0.5;
      weights.set(g, (weights.get(g) ?? 0) + w * factor);
    });
  }

  for (const e of watchlist) {
    const genres = e.media.genres?.length ? e.media.genres : catalogByKey.get(e.media.key)?.genres ?? [];
    genres.slice(0, 3).forEach((g, idx) => {
      weights.set(g, (weights.get(g) ?? 0) + (idx === 0 ? 0.75 : 0.45));
    });
  }

  return [...weights.entries()]
    .map(([genre, weight]) => ({ genre, weight }))
    .sort((a, b) => b.weight - a.weight);
}

interface CandidateMeta {
  media: Media;
  inWatchlist: boolean;
  watchlistRecency: number;
  becauseOf?: string;
  becauseRank: number;
  inFresh: boolean;
  inAiring: boolean;
  inAcclaimed: boolean;
}

/**
 * Curate personalized next-watch picks across watch history, My List, related titles,
 * and catalog feeds while filtering out finished, currently active, or unreleased items.
 */
export function buildRecommendations(opts: {
  progress: ProgressEntry[];
  watchlist: { media: Media; addedAt: number }[];
  seedRelated: SeedRelated[];
  catalogPools: { label: "fresh" | "popular" | "acclaimed" | "airing"; items: Media[] }[];
  lens: "all" | Lane;
  mode: RecommendMode;
  dismissed?: ReadonlySet<string>;
  seedKey?: string;
  shuffleOffset?: number;
  limit?: number;
  now?: number;
}): { picks: RecommendedPick[]; topGenres: string[]; hasSignals: boolean } {
  const {
    progress,
    watchlist,
    seedRelated,
    catalogPools,
    lens,
    mode,
    dismissed = new Set<string>(),
    seedKey,
    shuffleOffset = 0,
    limit = 5,
    now = Date.now(),
  } = opts;

  const catalogByKey = new Map<string, Media>();
  for (const pool of catalogPools) {
    for (const m of pool.items) {
      if (!catalogByKey.has(m.key)) catalogByKey.set(m.key, m);
    }
  }
  for (const sr of seedRelated) {
    for (const m of sr.items) {
      if (!catalogByKey.has(m.key)) catalogByKey.set(m.key, m);
    }
  }
  for (const w of watchlist) {
    if (!catalogByKey.has(w.media.key)) catalogByKey.set(w.media.key, w.media);
  }

  const finishedKeys = new Set<string>();
  const activeKeys = new Set<string>();
  const finishedTitles = new Set<string>();
  const activeTitles = new Set<string>();

  for (const p of progress) {
    const titleNorm = p.media.title?.trim().toLowerCase();
    if (p.finished) {
      finishedKeys.add(p.media.key);
      if (titleNorm) finishedTitles.add(titleNorm);
    } else if (p.position > 30 || p.upNext) {
      activeKeys.add(p.media.key);
      if (titleNorm) activeTitles.add(titleNorm);
    }
  }

  const isExcluded = (m: Media) => {
    if (finishedKeys.has(m.key) || activeKeys.has(m.key) || dismissed.has(m.key) || isUnreleasedMedia(m)) return true;
    const t = m.title?.trim().toLowerCase();
    if (t && (finishedTitles.has(t) || activeTitles.has(t))) return true;
    if (lens !== "all" && laneOf(m) !== lens) return true;
    return false;
  };

  const taste = tasteFrom(progress, watchlist, now);
  const genreProfile = extractGenreProfile(progress, watchlist, catalogByKey, now);
  const topGenres = genreProfile.slice(0, 5).map((g) => g.genre);
  const genreWeightMap = new Map(genreProfile.map((g) => [g.genre, g.weight]));
  const maxGenreWeight = genreProfile[0]?.weight || 1;
  const hasSignals = progress.length > 0 || watchlist.length > 0;

  const candidates = new Map<string, CandidateMeta>();
  const ensure = (m: Media): CandidateMeta | null => {
    if (isExcluded(m)) return null;
    const existing = candidates.get(m.key);
    if (existing) {
      if (!existing.media.backdrop && m.backdrop) existing.media = { ...existing.media, backdrop: m.backdrop };
      if (!existing.media.overview && m.overview) existing.media = { ...existing.media, overview: m.overview };
      if (!existing.media.genres?.length && m.genres?.length) existing.media = { ...existing.media, genres: m.genres };
      return existing;
    }
    const rich = catalogByKey.get(m.key);
    const merged: Media = rich
      ? {
          ...m,
          backdrop: m.backdrop ?? rich.backdrop,
          poster: m.poster ?? rich.poster,
          overview: m.overview || rich.overview,
          genres: m.genres?.length ? m.genres : rich.genres,
          rating: m.rating ?? rich.rating,
        }
      : m;
    const entry: CandidateMeta = {
      media: merged,
      inWatchlist: false,
      watchlistRecency: 0,
      becauseRank: Number.POSITIVE_INFINITY,
      inFresh: false,
      inAiring: false,
      inAcclaimed: false,
    };
    candidates.set(m.key, entry);
    return entry;
  };

  watchlist.forEach((w, idx) => {
    const c = ensure(w.media);
    if (!c) return;
    c.inWatchlist = true;
    c.watchlistRecency = Math.max(0.2, 1 - idx * 0.08);
  });

  seedRelated.forEach((sr, sIdx) => {
    if (seedKey && mode === "because" && sr.source.key !== seedKey) return;
    sr.items.forEach((m, rIdx) => {
      const c = ensure(m);
      if (!c) return;
      const rank = sIdx * 10 + rIdx;
      if (rank < c.becauseRank) {
        c.becauseRank = rank;
        c.becauseOf = sr.source.title;
      }
    });
  });

  for (const pool of catalogPools) {
    for (const m of pool.items) {
      const c = ensure(m);
      if (!c) continue;
      if (pool.label === "fresh") c.inFresh = true;
      if (pool.label === "airing") c.inAiring = true;
      if (pool.label === "acclaimed") c.inAcclaimed = true;
    }
  }

  let poolList = [...candidates.values()].filter((c) => c.media.poster || c.media.backdrop);
  if (mode === "queue") poolList = poolList.filter((c) => c.inWatchlist);
  else if (mode === "because") poolList = poolList.filter((c) => c.becauseOf);
  else if (mode === "acclaimed") {
    const high = poolList.filter((c) => c.inAcclaimed || (c.media.rating ?? 0) >= 7.5);
    if (high.length >= 3) poolList = high;
  } else if (mode === "surprise" && topGenres[0]) {
    const outsideTop = poolList.filter((c) => !c.media.genres.includes(topGenres[0]) && (c.media.rating ?? 0) >= 7.0);
    if (outsideTop.length >= 4) poolList = outsideTop;
  }

  const primaryGenre = topGenres[0];

  const scored: RecommendedPick[] = poolList.map((c) => {
    const m = c.media;
    const lane = laneOf(m);
    const laneShare = taste.share[lane] ?? 1 / 3;
    const matchedGenres = m.genres.filter((g) => (genreWeightMap.get(g) ?? 0) > 0);
    const genreAffinity = matchedGenres.reduce((sum, g) => sum + (genreWeightMap.get(g) ?? 0) / maxGenreWeight, 0) / Math.max(1, Math.min(2, m.genres.length || 1));
    const ratingScore = Math.max(0, Math.min(1, ((m.rating ?? 6.8) - 5) / 4.5));
    const hasWideArt = m.backdrop ? 0.12 : 0;

    let score = ratingScore * 1.4 + laneShare * 1.15 + genreAffinity * 1.65 + hasWideArt;
    let badge: RecommendBadge = "taste";
    let reason = matchedGenres.length >= 2
      ? `Matches your ${matchedGenres.slice(0, 2).join(" & ")} taste`
      : matchedGenres[0]
        ? `Picked for your ${matchedGenres[0]} affinity`
        : m.rating && m.rating >= 8
          ? `Critically acclaimed · ★ ${m.rating.toFixed(1)}`
          : lane === "anime"
            ? "Featured Anime pick"
            : lane === "series"
              ? "Trending Series pick"
              : "Popular Cinema pick";

    if (c.inWatchlist) {
      score += 1.9 + c.watchlistRecency * 0.8;
      badge = "queue";
      reason = c.becauseOf ? `In My List · Similar to ${c.becauseOf}` : "Queued in My List · Ready to start";
    } else if (c.becauseOf) {
      const decay = Math.max(0.4, 1 - c.becauseRank * 0.045);
      score += 1.65 * decay;
      badge = "because";
      reason = `Because you watched ${c.becauseOf}`;
    } else if (c.inAiring && lane === "anime") {
      score += 0.65;
      badge = "fresh";
      if (!matchedGenres.length) reason = m.nextAiring ? `Simulcast Episode ${m.nextAiring.episode} airing soon` : "Airing weekly this season";
    } else if (c.inFresh) {
      score += 0.72;
      badge = "fresh";
      if (!matchedGenres.length) reason = "Fresh arrival matching your calibration";
    } else if (c.inAcclaimed || (m.rating ?? 0) >= 8.2) {
      score += 0.68;
      badge = "gem";
    }

    if (mode === "acclaimed") {
      score = ratingScore * 2.8 + (c.inAcclaimed ? 1.1 : 0) + genreAffinity * 0.7 + hasWideArt;
      badge = "gem";
      reason = m.rating ? `Critically acclaimed · ★ ${m.rating.toFixed(1)}` : "Highly rated highlight";
    } else if (mode === "surprise") {
      const outside = primaryGenre && !m.genres.includes(primaryGenre) ? 1.35 : 0;
      const novel = c.inWatchlist ? -0.6 : 0.3;
      score = ratingScore * 2.0 + outside + novel + hasWideArt + ((m.key.length % 7) * 0.04);
      badge = "gem";
      reason = m.genres[0]
        ? `A ${m.genres[0]} change of pace${m.rating ? ` · ★ ${m.rating.toFixed(1)}` : ""}`
        : "Curated discovery outside your routine";
    } else if (mode === "queue") {
      score = 2.4 + c.watchlistRecency * 1.4 + ratingScore * 0.8 + genreAffinity * 0.8;
      badge = "queue";
      reason = c.becauseOf ? `From My List · Like ${c.becauseOf}` : "Saved in My List · Ready tonight";
    } else if (mode === "because" && c.becauseOf) {
      score = 2.4 - c.becauseRank * 0.06 + ratingScore * 0.9 + genreAffinity * 0.6;
      badge = "because";
      reason = `Because you watched ${c.becauseOf}`;
    }

    return {
      media: m,
      score,
      matchPct: 80,
      reason,
      badge,
      seedTitle: c.becauseOf,
    };
  });

  scored.sort((a, b) => b.score - a.score || (b.media.rating ?? 0) - (a.media.rating ?? 0));

  // Normalize matchPct smoothly onto 81..98 relative to top candidate
  const topScore = scored[0]?.score || 1;
  const minScore = scored[Math.min(scored.length - 1, 14)]?.score || 0;
  const span = Math.max(0.25, topScore - minScore);
  scored.forEach((p, idx) => {
    const rel = Math.max(0, Math.min(1, (p.score - minScore) / span));
    p.matchPct = Math.round(81 + rel * 16 - Math.min(3, Math.floor(idx / 5)));
  });

  // Apply optional shuffle rotation across the strong candidate pool without dropping quality
  let ordered = scored;
  const rotWindow = Math.min(ordered.length, Math.max(limit * 3, 12));
  if (shuffleOffset > 0 && rotWindow > limit) {
    const head = ordered.slice(0, rotWindow);
    const shift = shuffleOffset % Math.max(1, head.length - 1);
    ordered = [...head.slice(shift), ...head.slice(0, shift), ...ordered.slice(rotWindow)];
  }

  // Enforce lane variety for "for-you" in "all" lens (prefer backdrop on #0 spotlight slot)
  let picks: RecommendedPick[];
  if (mode === "for-you" && lens === "all" && ordered.length > limit) {
    const remaining = [...ordered];
    const selected: RecommendedPick[] = [];
    // Spotlight slot prefers rich 16:9 backdrop artwork if available near top
    const firstWithBackdrop = remaining.findIndex((p, idx) => idx < 5 && p.media.backdrop);
    if (firstWithBackdrop > 0) {
      selected.push(remaining.splice(firstWithBackdrop, 1)[0]);
    } else if (remaining.length) {
      selected.push(remaining.shift()!);
    }
    while (selected.length < limit && remaining.length) {
      const counts = new Map<Lane, number>();
      for (const s of selected) counts.set(laneOf(s.media), (counts.get(laneOf(s.media)) ?? 0) + 1);
      const diverseIdx = remaining.findIndex((c) => (counts.get(laneOf(c.media)) ?? 0) < 2);
      const takeIdx = diverseIdx >= 0 && diverseIdx < 8 ? diverseIdx : 0;
      selected.push(remaining.splice(takeIdx, 1)[0]);
    }
    picks = selected;
  } else {
    const remaining = [...ordered];
    const firstWithBackdrop = remaining.findIndex((p, idx) => idx < 4 && p.media.backdrop);
    if (firstWithBackdrop > 0) {
      const [lead] = remaining.splice(firstWithBackdrop, 1);
      picks = [lead, ...remaining.slice(0, limit - 1)];
    } else {
      picks = remaining.slice(0, limit);
    }
  }

  return { picks, topGenres, hasSignals };
}
