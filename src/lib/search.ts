import { searchAnime } from "./anilist";
import { normTitle } from "./format";
import { searchTmdb } from "./tmdb";
import type { Media } from "./types";

/** "dune 2021" → { text: "dune", year: 2021 }. A number that can't be a release year ("Blade Runner 2049") stays in the text. */
export function parseQuery(q: string): { text: string; year?: number } {
  const m = q.trim().match(/^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/);
  if (!m) return { text: q.trim() };
  const year = Number(m[2]);
  return year <= new Date().getFullYear() + 2 ? { text: m[1], year } : { text: q.trim() };
}

/** One typo is forgiven in words long enough for it to be a typo rather than another word. */
function near(a: string, b: string) {
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well one title answers one query: exact > starts with > every word > partial > near miss. */
function textScore(t: string, nq: string) {
  if (!nq) return 0;
  if (t === nq) return 100;
  if (t.startsWith(nq)) return 75 - Math.min(20, (t.length - nq.length) / 2);
  const qw = nq.split(" "), tw = t.split(" ");
  if (qw.every((w) => t.includes(w))) return 55;
  if (t.includes(nq)) return 40;
  // Each word of the query starts, or nearly spells, a word of the title ("jujutu kaisen").
  if (qw.every((w) => tw.some((x) => x.startsWith(w) || near(x, w)))) return 46;
  // The query merely contains a short title ("Kaisen" inside "jujutu kaisen"): a weak lead.
  if (t.length >= 4 && nq.includes(t)) return 20;
  return 0;
}

/**
 * Series and anime get a small nudge over spin-off movies with the same name, so typing
 * "Jujutsu Kaisen" shows the show first and "Jujutsu Kaisen 0" still finds the film.
 * A year in the query lifts the release from that year.
 */
function relevance(m: Media, q: string, position: number) {
  const { text: stripped, year } = parseQuery(q);
  const forms = [...new Set([normTitle(q), normTitle(stripped)])];
  const titles = [m.title, m.originalTitle].filter(Boolean).map((t) => normTitle(t!));
  let text = 0;
  for (const t of titles) for (const f of forms) text = Math.max(text, textScore(t, f));
  const wantsMovie = /\b(movie|film)\b/i.test(q);
  const kind = m.kind === "movie" ? (wantsMovie ? 8 : 0) : wantsMovie ? 0 : 8;
  const quality = (m.rating ?? 6) * 1.2 + (m.poster ? 3 : -10);
  const when = year && m.year ? (m.year === year ? 30 : Math.abs(m.year - year) === 1 ? 8 : -6) : 0;
  return text + kind + quality + when - position * 0.8;
}

/** Recent searches, so retyping, backspacing or reopening the palette answers instantly. */
const TTL = 10 * 60_000;
const MAX = 40;
const memo = new Map<string, { at: number; value: Media[] }>();
const inflight = new Map<string, Promise<Media[]>>();

/** A cached answer for this exact query, if there is a fresh one (no request made). */
export function peekSearch(term: string): Media[] | undefined {
  const hit = memo.get(term.trim().toLowerCase());
  return hit && Date.now() - hit.at < TTL ? hit.value : undefined;
}

/** Both catalogs for one piece of text, ranked against the query the viewer actually typed. */
async function fetchBoth(text: string, term: string): Promise<Media[]> {
  const [a, b] = await Promise.all([searchTmdb(text).catch(() => [] as Media[]), searchAnime(text).catch(() => [] as Media[])]);
  const aniTitles = new Set(b.flatMap((m) => [normTitle(m.title), m.originalTitle ? normTitle(m.originalTitle) : ""]).filter(Boolean));
  // TMDB lists anime too; keep its entry only when AniList didn't return the same show.
  const tmdb = a.filter((m) => !(m.kind === "anime" && (aniTitles.has(normTitle(m.title)) || aniTitles.has(normTitle(m.originalTitle ?? "")))));
  const scored = [...tmdb.map((m, i) => ({ m, s: relevance(m, term, i) })), ...b.map((m, i) => ({ m, s: relevance(m, term, i) }))];
  return scored.sort((x, y) => y.s - x.s).map((x) => x.m);
}

/**
 * The catalogs match whole words, so one typo ("jujutu kaisen") returns nothing at all.
 * Second chances: the longest words on their own, or the start of a single word. Whatever
 * comes back is kept only if its title still resembles what was typed.
 */
function looserQueries(text: string): string[] {
  const words = normTitle(text).split(" ").filter(Boolean);
  if (words.length > 1) return [...words].filter((w) => w.length >= 4).sort((x, y) => y.length - x.length).slice(0, 2);
  const w = words[0] ?? "";
  return w.length >= 5 ? [w.slice(0, Math.max(3, w.length - 2))] : [];
}

function resembles(m: Media, text: string) {
  const nq = normTitle(text);
  return [m.title, m.originalTitle].some((t) => !!t && textScore(normTitle(t), nq) > 0);
}

/** Search both catalogs at once and merge by relevance. Anime appears once, from AniList. */
export function searchAll(term: string): Promise<Media[]> {
  const id = term.trim().toLowerCase();
  const hit = peekSearch(id);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(id);
  if (running) return running;

  const { text } = parseQuery(term);
  const p = fetchBoth(text, term)
    .then(async (found) => {
      let value = found;
      for (const q of value.length ? [] : looserQueries(text)) {
        value = (await fetchBoth(q, term)).filter((m) => resembles(m, text));
        if (value.length) break;
      }
      // Don't remember an empty answer: it may just be a catalog that was briefly unreachable.
      if (value.length) {
        memo.set(id, { at: Date.now(), value });
        if (memo.size > MAX) memo.delete(memo.keys().next().value!);
      }
      return value;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Split a title around the part that matches the query, for highlighting. */
export function matchParts(title: string, q: string): [string, string, string] | null {
  const needle = parseQuery(q).text.toLowerCase();
  if (needle.length < 2) return null;
  const i = title.toLowerCase().indexOf(needle);
  return i < 0 ? null : [title.slice(0, i), title.slice(i, i + needle.length), title.slice(i + needle.length)];
}
