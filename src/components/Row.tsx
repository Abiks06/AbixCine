import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rankMoves } from "../lib/ranks";
import type { Media } from "../lib/types";
import { Card, CardSkeleton, type CardVariant } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

/** A shelf: eyebrow, title, and a snap-scrolling track with arrow paging. */
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
  const list = ranked ? items?.slice(0, 10) : items;
  const moves = useMemo(() => (ranked && chart && list?.length ? rankMoves(chart, list) : null), [ranked, chart, list]);

  const update = () => {
    const el = ref.current;
    if (!el) return;
    const next = { left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 };
    // Scroll fires every frame: only touch state when an edge actually flips.
    setEdges((e) => (e.left === next.left && e.right === next.right ? e : next));
  };
  useEffect(() => {
    update();
    // Resizing the window changes whether the shelf overflows.
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items, loading]);

  const page = (dir: 1 | -1) => {
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
  };

  if (!loading && !children && !items?.length) return null;
  return (
    <section className="sec" id={id}>
      <SectionHead
        eyebrow={ranked && chart ? `${eyebrow ?? "Trending today"}${moves ? " · movement since yesterday" : ""}` : eyebrow}
        title={title}
        to={to}
        right={
          <>
            {right}
            <div className="row-nav">
              <button className="nav-btn" disabled={!edges.left} onClick={() => page(-1)} aria-label="Scroll left"><Icon name="chevL" size={16} /></button>
              <button className="nav-btn" disabled={!edges.right} onClick={() => page(1)} aria-label="Scroll right"><Icon name="chevR" size={16} /></button>
            </div>
          </>
        }
      />
      <div className={`track ${ranked ? "ranked" : ""} ${edges.left ? "fade-l" : ""} ${edges.right ? "fade-r" : ""}`} ref={ref} onScroll={update}>
        {children ??
          (loading
            ? Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} variant={ranked ? "rank" : variant} />)
            : list!.map((m, i) => (
                <Card key={m.key} media={m} index={i} variant={ranked ? "rank" : variant} rank={ranked ? i + 1 : undefined} move={moves?.[m.key]} />
              )))}
      </div>
    </section>
  );
});
