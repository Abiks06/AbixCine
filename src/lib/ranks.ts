import type { Media } from "./types";

/**
 * Top 10 movement, measured on this device: we keep yesterday's ranking for each chart and
 * compare. No history yet means no arrows, rather than invented ones.
 */
type Snap = { day: string; ranks: Record<string, number> };
type Store = { cur?: Snap; prev?: Snap };
export type Move = { kind: "up" | "dn" | "new" | "same"; by: number };

const today = () => new Date().toISOString().slice(0, 10);

export function rankMoves(chart: string, items: Media[]): Record<string, Move> | null {
  if (!items.length) return null;
  const k = `abx.ranks.${chart}`;
  let st: Store = {};
  try {
    st = JSON.parse(localStorage.getItem(k) ?? "{}");
  } catch {
    /* ignore */
  }
  const ranks = Object.fromEntries(items.slice(0, 10).map((m, i) => [m.key, i + 1]));
  if (st.cur?.day !== today()) st = { prev: st.cur, cur: { day: today(), ranks } };
  else st.cur = { day: today(), ranks };
  try {
    localStorage.setItem(k, JSON.stringify(st));
  } catch {
    /* ignore */
  }
  const prev = st.prev?.ranks;
  if (!prev) return null;
  const out: Record<string, Move> = {};
  for (const [key, r] of Object.entries(ranks)) {
    const was = prev[key];
    out[key] = was == null ? { kind: "new", by: 0 } : was > r ? { kind: "up", by: was - r } : was < r ? { kind: "dn", by: r - was } : { kind: "same", by: 0 };
  }
  return out;
}
