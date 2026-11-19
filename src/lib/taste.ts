import { useMemo } from "react";
import { useProgressStore, type ProgressEntry } from "./progress";
import type { Media } from "./types";
import { useWatchlist } from "./watchlist";

/** The three kinds of thing Home mixes. */
export type Lane = "film" | "series" | "anime";
export const LANES: Lane[] = ["film", "series", "anime"];
export const laneOf = (m: Pick<Media, "kind">): Lane => (m.kind === "anime" ? "anime" : m.kind === "movie" ? "film" : "series");

const DAY = 86_400_000;
/** Interest halves every month: last week's binge counts for more than last spring's. */
const HALF_LIFE_DAYS = 30;

export interface Taste {
  /** Each lane's share of attention, summing to 1. Never 0: every lane keeps a foot in the door. */
  share: Record<Lane, number>;
  /** Lanes from most to least watched. */
  order: Lane[];
}

/**
 * How much of each lane someone watches, from what they've played (recent plays weigh more, a
 * finished one a little more again) and what they've saved. A prior of one title per lane keeps a
 * new account mixed evenly and stops one stray film from wiping series off the page.
 */
export function tasteFrom(progress: ProgressEntry[], saved: { media: Pick<Media, "kind" | "key"> }[], now = Date.now()): Taste {
  const score: Record<Lane, number> = { film: 1, series: 1, anime: 1 };
  // One vote per title: a series saves an entry per season or cour, which mustn't count as five shows.
  const seen = new Set<string>();
  for (const p of [...progress].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const id = p.media.title?.toLowerCase() || p.media.key;
    if (seen.has(id)) continue;
    seen.add(id);
    const age = Math.max(0, (now - p.updatedAt) / DAY);
    score[laneOf(p.media)] += (p.finished ? 1.5 : 1) * 0.5 ** (age / HALF_LIFE_DAYS);
  }
  for (const e of saved) score[laneOf(e.media)] += 0.5;
  const total = score.film + score.series + score.anime;
  const share = { film: score.film / total, series: score.series / total, anime: score.anime / total };
  const order = [...LANES].sort((a, b) => share[b] - share[a]);
  return { share, order };
}

/** The viewer's taste, recomputed only when it would actually change the page. */
export function useTaste(): Taste {
  const store = useProgressStore();
  const saved = useWatchlist();
  const t = useMemo(() => tasteFrom(Object.values(store), saved), [store, saved]);
  // Positions tick while something plays: keep the same object unless the mix itself moved.
  const sig = `${t.order.join(",")}|${LANES.map((l) => Math.round(t.share[l] * 12)).join(",")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => t, [sig]);
}

/**
 * `n` titles drawn from each lane's pool in proportion to taste (largest remainder, and at least
 * one from every lane that has anything), then dealt in turn so the lanes alternate rather than
 * arriving in blocks. Titles already used are skipped; a short lane's slots go to the others.
 */
export function mixByTaste(pools: Partial<Record<Lane, Media[]>>, taste: Taste, n: number): Media[] {
  const lanes = taste.order.filter((l) => pools[l]?.length);
  if (!lanes.length) return [];
  const total = lanes.reduce((s, l) => s + taste.share[l], 0);
  const exact = lanes.map((l) => (taste.share[l] / total) * n);
  const slots = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = n - slots.reduce((a, b) => a + b, 0);
  const byRemainder = lanes.map((_, i) => i).sort((a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])));
  for (let k = 0; left > 0 && k < byRemainder.length; k++, left--) slots[byRemainder[k]]++;

  const used = new Set<string>();
  const cursor = lanes.map(() => 0);
  const take = (i: number) => {
    const pool = pools[lanes[i]]!;
    while (cursor[i] < pool.length) {
      const m = pool[cursor[i]++];
      if (!used.has(m.key)) {
        used.add(m.key);
        return m;
      }
    }
    return undefined;
  };

  const out: Media[] = [];
  // Deal round-robin in taste order while each lane still has slots...
  // (each pass spends at least one slot, so this ends).
  while (out.length < n && slots.some((s) => s > 0)) {
    lanes.forEach((_, i) => {
      if (out.length >= n || slots[i] <= 0) return;
      slots[i]--;
      const m = take(i);
      if (m) out.push(m);
    });
  }
  // ...then top up from whichever lanes still have titles.
  for (let i = 0; out.length < n && i < lanes.length; ) {
    const m = take(i);
    if (m) out.push(m);
    else i++;
  }
  return out;
}
