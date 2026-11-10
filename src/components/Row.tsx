import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Media } from "../lib/types";
import { Card, CardSkeleton, type CardVariant } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

/** Horizontally scrolling shelf with arrow paging. */
export function Row({
  title,
  eyebrow,
  to,
  items,
  loading,
  children,
  variant = "poster",
  ranked,
}: {
  title: string;
  eyebrow?: string;
  to?: string;
  items?: Media[];
  loading?: boolean;
  children?: ReactNode;
  variant?: CardVariant;
  ranked?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: true });

  const update = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    update();
  }, [items]);

  const page = (dir: 1 | -1) => {
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
  };

  if (!loading && !children && !items?.length) return null;
  const list = ranked ? items?.slice(0, 10) : items;
  return (
    <section className={`row row-${ranked ? "rank" : variant}`}>
      <SectionHead
        eyebrow={eyebrow}
        title={title}
        to={to}
        right={
          <div className="row-nav">
            <button className="icon-btn round" disabled={!edges.left} onClick={() => page(-1)} aria-label="Scroll left"><Icon name="chevL" /></button>
            <button className="icon-btn round" disabled={!edges.right} onClick={() => page(1)} aria-label="Scroll right"><Icon name="chevR" /></button>
          </div>
        }
      />
      <div className="row-track" ref={ref} onScroll={update}>
        {children ??
          (loading
            ? Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} variant={ranked ? "rank" : variant} />)
            : list!.map((m, i) => <Card key={m.key} media={m} index={i} variant={ranked ? "rank" : variant} rank={ranked ? i + 1 : undefined} />))}
      </div>
    </section>
  );
}
