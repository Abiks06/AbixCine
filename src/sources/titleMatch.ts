import { isFilm, type MediaDetail, type PlaybackRequest } from "../lib/types";

/**
 * Deciding whether a provider's catalog entry *is* the title being played.
 *
 * Fuzzy "closest title wins" matching is what made some servers play the wrong film: a search for
 * "The Odyssey" (2026) happily settled on the 1997 miniseries, because the title is identical and a
 * year mismatch only cost a few points. The rule here is strict and the same everywhere:
 *
 *  - a shared id (TMDB / IMDb) decides on its own, either way;
 *  - movie vs series must agree when both sides say;
 *  - the normalized title (or original title) must be *equal*, not similar;
 *  - when both sides know the year, it must be within a year (or, for a series, inside its run);
 *  - when the year can't settle it and more than one entry fits, nothing is picked.
 *
 * No match is better than a wrong one: the session simply moves on to another server.
 * Re-exported from `extractors/common.ts`; kept free of imports so `embeds.ts` can use it too.
 */

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const TRAILING_YEAR = /[\s._-]*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/;

/**
 * Lowercase, strip diacritics, punctuation and a leading article, "&" → "and", drop a trailing
 * "(2026)", and spell roman numerals as digits. Letters of every script are kept, so a Korean or
 * Japanese original title still compares.
 */
export function normalizeMatchTitle(raw?: string | null): string {
  if (!raw) return "";
  let t = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(TRAILING_YEAR, "");
  // "Odyssey, The" (library naming) and "The Odyssey" are the same title.
  t = t.replace(/,\s*(?:the|a|an)\s*$/, "");
  t = t.replace(/&/g, " and ").replace(/['’‘`´]/g, "");
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  t = t.replace(/^(?:the|a|an)\s+/, "");
  return t
    .split(" ")
    .map((w) => ROMAN[w] ?? w)
    .join(" ");
}

/** A four-digit year from a number, a date string or a "Title (2026)" suffix. */
export function parseYear(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1880 && raw <= 2100 ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/\b(18[89]\d|19\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}

const titleYear = (raw?: string | null) => {
  const m = raw?.match(TRAILING_YEAR);
  return m ? Number(m[1]) : undefined;
};

/** "squid game season 2" → { base: "squid game", season: 2 } (input already normalized). */
export function splitSeasonSuffix(norm: string): { base: string; season?: number } {
  const m = norm.match(/^(.+?)\s+(?:season|series|s)\s*(\d{1,2})$/) ?? norm.match(/^(.+?)\s+(\d{1,2})(?:st|nd|rd|th)\s+season$/);
  return m ? { base: m[1], season: Number(m[2]) } : { base: norm };
}

export interface MatchTarget {
  /** Title, original title, any aliases. Empty entries are ignored. */
  titles: (string | null | undefined)[];
  year?: number;
  /** Accept a candidate year inside this window instead of `year` ± 1 (a series spans years). */
  yearRange?: { min?: number; max?: number };
  kind?: "movie" | "tv";
  tmdbId?: string | number | null;
  imdbId?: string | null;
  /** Series: the wanted season, compared with a "Season N" suffix on a candidate's title. */
  season?: number;
  /** Reject an entry titled for another season (providers that list each season separately). */
  strictSeason?: boolean;
}

export interface MatchCandidate {
  titles: (string | null | undefined)[];
  year?: number | string | null;
  kind?: "movie" | "tv" | null;
  tmdbId?: string | number | null;
  imdbId?: string | null;
}

export interface TitleMatch<T> {
  item: T;
  /** The candidate's own title that matched, as the provider wrote it. */
  title: string;
  year?: number;
  byId: boolean;
  /** The year was compared and agreed (or an id decided it). */
  verified: boolean;
}

type Assessment =
  | { ok: false; reason: string }
  | { ok: true; score: number; title: string; year?: number; byId: boolean; verified: boolean; norm: string };

const sameId = (a: string | number, b: string | number) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function assessTitleMatch(target: MatchTarget, cand: MatchCandidate): Assessment {
  const firstTitle = cand.titles.find((t): t is string => !!t?.trim()) ?? "";
  const candYear = parseYear(cand.year ?? undefined) ?? cand.titles.map(titleYear).find((y) => y != null);

  for (const [a, b] of [
    [target.tmdbId, cand.tmdbId],
    [target.imdbId, cand.imdbId],
  ] as const) {
    if (a == null || b == null || String(a).trim() === "" || String(b).trim() === "") continue;
    if (!sameId(a, b)) return { ok: false, reason: "different id" };
    return { ok: true, score: 1000, title: firstTitle, year: candYear, byId: true, verified: true, norm: normalizeMatchTitle(firstTitle) };
  }

  if (target.kind && cand.kind && target.kind !== cand.kind) return { ok: false, reason: "different kind" };

  const wanted = new Set(target.titles.map(normalizeMatchTitle).filter(Boolean));
  if (!wanted.size) return { ok: false, reason: "no title" };
  const seriesLike = target.kind === "tv" || target.season != null;

  let hit: { title: string; norm: string; season?: number } | undefined;
  for (const raw of cand.titles) {
    const n = normalizeMatchTitle(raw);
    if (!n || !raw) continue;
    if (wanted.has(n)) {
      hit = { title: raw, norm: n };
      break;
    }
    if (seriesLike) {
      const split = splitSeasonSuffix(n);
      if (split.season != null && wanted.has(split.base)) hit ??= { title: raw, norm: split.base, season: split.season };
    }
  }
  if (!hit) return { ok: false, reason: "different title" };

  let score = 10;
  if (hit.season != null && target.season != null) {
    if (hit.season !== target.season) {
      if (target.strictSeason) return { ok: false, reason: "different season" };
      score -= 8;
    } else score += 4;
  }

  let verified = false;
  if (candYear != null) {
    if (target.yearRange && (target.yearRange.min != null || target.yearRange.max != null)) {
      const { min, max } = target.yearRange;
      if ((min != null && candYear < min) || (max != null && candYear > max)) return { ok: false, reason: "different year" };
      verified = true;
      score += 20;
    } else if (target.year != null) {
      const diff = Math.abs(candYear - target.year);
      if (diff > 1) return { ok: false, reason: "different year" };
      verified = true;
      score += diff === 0 ? 30 : 20;
    }
  }
  return { ok: true, score, title: hit.title, year: candYear, byId: false, verified, norm: hit.norm };
}

/**
 * The one catalog entry that is the wanted title, or null when none is, or when the year can't
 * tell several equally-titled entries apart ("The Odyssey" with no year: 1997 or 2026?).
 */
export function pickTitleMatch<T>(items: readonly T[], target: MatchTarget, describe: (item: T) => MatchCandidate): TitleMatch<T> | null {
  const accepted: { item: T; a: Extract<Assessment, { ok: true }>; i: number }[] = [];
  items.forEach((item, i) => {
    const a = assessTitleMatch(target, describe(item));
    if (a.ok) accepted.push({ item, a, i });
  });
  if (!accepted.length) return null;
  accepted.sort((x, y) => y.a.score - x.a.score || x.i - y.i);
  const top = accepted[0];
  if (!top.a.verified && !top.a.byId) {
    // Unverified and not alone: the same name could be two different works.
    const rivals = accepted.filter((r) => r !== top && !r.a.byId && r.a.score >= top.a.score - 8);
    if (rivals.length) return null;
  }
  return { item: top.item, title: top.a.title, year: top.a.year, byId: top.a.byId, verified: top.a.verified || top.a.byId };
}

/** The latest year a series' requested season can carry, when the catalog says. */
function seriesLatestYear(m: MediaDetail, season?: number): number | undefined {
  const years: number[] = [];
  const seasonYear = season != null ? m.seasons?.find((s) => s.number === season)?.year : undefined;
  if (seasonYear) years.push(seasonYear);
  for (const s of m.seasons ?? []) if (s.year && (season == null || s.number <= season)) years.push(s.year);
  for (const d of [m.endDate, m.lastEpisode?.airDate, m.nextEpisode?.airDate]) {
    const y = parseYear(d);
    if (y) years.push(y);
  }
  return years.length ? Math.max(...years) : undefined;
}

/** Match target for a playback request: its titles, kind, year (or a series' run) and season. */
export function matchTargetFor(req: PlaybackRequest, extra: { titles?: (string | null | undefined)[]; imdbId?: string | null; tmdbId?: string | number | null } = {}): MatchTarget {
  const m = req.media as MediaDetail;
  const film =
    isFilm(m) || Boolean((req as { isAnimeMovie?: boolean }).isAnimeMovie) || Boolean((m as { isAnimeMovie?: boolean }).isAnimeMovie);
  const titles = [m.title, m.originalTitle, ...(extra.titles ?? [])];
  if (film) return { titles, kind: "movie", year: m.year, imdbId: extra.imdbId, tmdbId: extra.tmdbId };
  const latest = seriesLatestYear(m, req.season);
  return {
    titles,
    kind: "tv",
    year: m.year,
    yearRange: m.year != null ? { min: m.year - 1, ...(latest != null ? { max: Math.max(latest, m.year) + 1 } : {}) } : undefined,
    season: req.season,
    imdbId: extra.imdbId,
    tmdbId: extra.tmdbId,
  };
}
