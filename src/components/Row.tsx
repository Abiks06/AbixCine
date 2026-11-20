import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rankMoves, type Move } from "../lib/ranks";
import type { Media } from "../lib/types";
import { Card, CardSkeleton, type CardVariant } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

/** A curated shelf or 35mm contact sheet track with hairline controls. */
export const Row = memo(function Row({
  title,
  accentWord,
  eyebrow,
  to,
  items,
  loading,
  children,
  variant = "landscape",
  frames = false,
  ranked,
  chart,
  right,
  id,
}: {
  title: string;
  accentWord?: string;
  eyebrow?: string;
  to?: string;
  items?: Media[];
  loading?: boolean;
  children?: ReactNode;
  variant?: CardVariant;
  frames?: boolean;
  ranked?: boolean;
  chart?: string;
  right?: ReactNode;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const list = useMemo(() => (ranked ? items?.slice(0, 10) : items), [ranked, items]);
  const [moves, setMoves] = useState<Record<string, Move> | null>(null);
  useEffect(() => {
    setMoves(ranked && chart && list?.length ? rankMoves(chart, list) : null);
  }, [ranked, chart, list]);

  const frame = useRef(0);
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const rightEdge = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((e) => (e.left === left && e.right === rightEdge ? e : { left, right: rightEdge }));
  };
  const update = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
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
    <section className={`shelf ${frames ? "contact-sheet" : ""}`} id={id}>
      <SectionHead
        eyebrow={ranked && chart ? `${eyebrow ?? "Trending today"}${moves ? " · movement since yesterday" : ""}` : eyebrow}
        title={title}
        accentWord={accentWord}
        to={to}
        right={
          <>
            {right}
            {(edges.left || edges.right) && (
              <div className="shelf-nav">
                <button className="nav-btn" disabled={!edges.left} onClick={() => page(-1)} aria-label="Scroll left"><Icon name="chevL" size={15} /></button>
                <button className="nav-btn" disabled={!edges.right} onClick={() => page(1)} aria-label="Scroll right"><Icon name="chevR" size={15} /></button>
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
                <Card
                  key={m.key}
                  media={m}
                  index={i}
                  variant={ranked ? "rank" : variant}
                  rank={ranked ? i + 1 : undefined}
                  move={moves?.[m.key]}
                  frameLabel={frames ? `F${String(i + 1).padStart(2, "0")}` : undefined}
                />
              )))}
      </div>
    </section>
  );
});
