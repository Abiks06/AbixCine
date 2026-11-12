import { useSyncExternalStore } from "react";
import type { Media } from "./types";

/**
 * Search history on this device: what you searched for and which titles you opened from a
 * search. Shown when the search box is empty so you can pick up where you left off.
 */

const KEY = "abx.searchHistory.v1";
const MAX_QUERIES = 12;
const MAX_TITLES = 12;

interface History {
  queries: { q: string; at: number }[];
  titles: { media: Media; at: number }[];
}

const listeners = new Set<() => void>();

function load(): History {
  try {
    const h = JSON.parse(localStorage.getItem(KEY) ?? "");
    return {
      queries: Array.isArray(h?.queries) ? h.queries : [],
      titles: Array.isArray(h?.titles) ? h.titles : [],
    };
  } catch {
    return { queries: [], titles: [] };
  }
}

let state: History = load();

function save(next: History) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage blocked: history lasts this session */
  }
  listeners.forEach((l) => l());
}

/** Remember a search. Typing "jujut" then "jujutsu kaisen" keeps only the finished query. */
export function rememberQuery(q: string) {
  const t = q.trim();
  if (t.length < 2) return;
  const low = t.toLowerCase();
  const queries = state.queries.filter((x) => {
    const xl = x.q.toLowerCase();
    return xl !== low && !low.startsWith(xl) && !xl.startsWith(low);
  });
  save({ ...state, queries: [{ q: t, at: Date.now() }, ...queries].slice(0, MAX_QUERIES) });
}

/** Remember a title opened from search results (kept slim, like progress entries). */
export function rememberTitle(m: Media) {
  const slim: Media = { key: m.key, kind: m.kind, title: m.title, originalTitle: m.originalTitle, overview: "", year: m.year, rating: m.rating, poster: m.poster, backdrop: m.backdrop, genres: [], hue: m.hue };
  save({ ...state, titles: [{ media: slim, at: Date.now() }, ...state.titles.filter((x) => x.media.key !== m.key)].slice(0, MAX_TITLES) });
}

export const forgetQuery = (q: string) => save({ ...state, queries: state.queries.filter((x) => x.q !== q) });
export const clearHistory = () => save({ queries: [], titles: [] });

export function useSearchHistory(): History {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
