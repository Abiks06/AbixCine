import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rankMoves, type Move } from "../lib/ranks";
import type { Media } from "../lib/types";
import { Card, CardSkeleton, type CardVariant } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

/** A shelf: title, caption, and a snap-scrolling track that bleeds to the window edge. */
export const Row = memo(function Row({
  title,
  eyebrow,
  to,
  items,
  loading,
  children,
  variant = "landscape",
  ranked,
  chart,
  right,
  id,
}: {
  title: string;
  eyebrow?: string;
  to?: string;
  items?: Media[];
  loading?: boolean;
  children?: ReactNode;
  variant?: CardVariant;
  ranked?: boolean;
  /** Ranked rows only: an id to remember yesterday's order under, for movement arrows. */
  chart?: string;
  right?: ReactNode;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const list = useMemo(() => (ranked ? items?.slice(0, 10) : items), [ranked, items]);
  // rankMoves writes today's chart to storage, so it belongs in an effect, not in render.
  const [moves, setMoves] = useState<Record<string, Move> | null>(null);
  useEffect(() => {
    setMoves(ranked && chart && list?.length ? rankMoves(chart, list) : null);
  }, [ranked, chart, list]);

  // Scroll fires dozens of times a second: measure once per frame, and only re-render when an edge flips.
  const frame = useRef(0);
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  const update = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // Before paint, from real geometry: the arrows never flash enabled on a shelf that doesn't overflow.
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // Resizing the window changes whether the shelf overflows.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading]);

  const page = (dir: 1 | -1) => {
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.82, behavior: "smooth" });
  };

  if (!loading && !children && !items?.length) return null;
  return (
    <section className="shelf" id={id}>
      <SectionHead
        eyebrow={ranked && chart ? `${eyebrow ?? "Trending today"}${moves ? " · movement since yesterday" : ""}` : eyebrow}
        title={title}
        to={to}
        right={
          <>
            {right}
            {(edges.left || edges.right) && (
              <div className="shelf-nav">
                <button className="nav-btn" disabled={!edges.left} onClick={() => page(-1)} aria-label="Scroll left"><Icon name="chevL" size={16} /></button>
                <button className="nav-btn" disabled={!edges.right} onClick={() => page(1)} aria-label="Scroll right"><Icon name="chevR" size={16} /></button>
              </div>
            )}
          </>
        }
      />
      <div className={`track ${ranked ? "ranked" : ""}`} ref={ref} onScroll={update}>
        {children ??
          (loading
            ? Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} variant={ranked ? "rank" : variant} />)
            : (list ?? []).map((m, i) => (
                <Card key={m.key} media={m} index={i} variant={ranked ? "rank" : variant} rank={ranked ? i + 1 : undefined} move={moves?.[m.key]} />
              )))}
      </div>
    </section>
  );
});
