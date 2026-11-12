import { useEffect, useMemo, useState } from "react";
import { getDetail } from "../lib/catalog";
import { fmtRuntime } from "../lib/format";
import type { Media } from "../lib/types";
import { Card, kindLabel } from "./Card";
import { SectionHead } from "./SectionHead";

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Cut-offs that still make sense right now: 11 pm and midnight while they're ahead of us, else hours from now. */
function cutoffs(now: Date) {
  const mins = (h: number) => {
    const t = new Date(now);
    t.setHours(h, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return Math.round((t.getTime() - now.getTime()) / 60000);
  };
  const out: { label: string; max: number }[] = [];
  const to11 = mins(23), to12 = mins(24);
  if (to11 >= 45 && to11 < 14 * 60) out.push({ label: "Before 11 pm", max: to11 });
  if (to12 >= 45 && to12 < 15 * 60) out.push({ label: "Before midnight", max: to12 });
  if (out.length < 2) out.unshift({ label: "Under 2 hours", max: 120 }, { label: "Under 1 hour", max: 60 });
  out.splice(2);
  out.sort((a, b) => a.max - b.max);
  out.push({ label: "All night", max: 24 * 60 });
  return out;
}

/**
 * "Fits tonight": what you can finish before you need to sleep. Movies by runtime,
 * series by one episode, with the end time worked out from the clock.
 */
export function FitsTonight({ pool }: { pool: Media[] }) {
  const [now, setNow] = useState(() => new Date());
  const opts = useMemo(() => cutoffs(now), [now.getHours() * 60 + now.getMinutes()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState(0);
  const [runtimes, setRuntimes] = useState<Record<string, number>>({});
  const keys = pool.map((m) => m.key).join("|");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    // One state update for the whole pool instead of a re-render per title.
    Promise.all(pool.slice(0, 18).map((m) => getDetail(m.key).then((d) => [m.key, d.runtime] as const).catch(() => [m.key, undefined] as const))).then((all) => {
      if (!live) return;
      const found = Object.fromEntries(all.filter(([, rt]) => rt)) as Record<string, number>;
      if (Object.keys(found).length) setRuntimes((r) => ({ ...r, ...found }));
    });
    return () => {
      live = false;
    };
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps

  const max = opts[Math.min(sel, opts.length - 1)].max;
  const fits = pool
    .filter((m, i, a) => runtimes[m.key] && runtimes[m.key] <= max && a.findIndex((x) => x.key === m.key) === i)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 10);
  if (!Object.keys(runtimes).length) return null;

  return (
    <section className="sec">
      <SectionHead
        eyebrow="Built around your evening"
        title="Fits tonight"
        right={
          <div className="fit">
            <span className="fit-now">It’s {clock(now)} · finish</span>
            <div className="seg-pills" role="radiogroup">
              {opts.map((o, i) => (
                <button key={o.label} role="radio" aria-checked={i === sel} className={i === sel ? "on" : ""} onClick={() => setSel(i)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <div className="track">
        {fits.length === 0 && <div className="track-empty">Nothing short enough. Try a later finish.</div>}
        {fits.map((m, i) => {
          const rt = runtimes[m.key];
          const end = clock(new Date(now.getTime() + rt * 60000));
          return (
            <Card
              key={m.key}
              media={m}
              index={i}
              // An end time, not a bar: a bar on a poster reads as "half watched".
              extra={
                <div className="fit-end">
                  <span className="fit-clock" aria-hidden />
                  {m.kind === "movie" ? `Ends ${end}` : `One episode · ends ${end}`}
                </div>
              }
              sub={
                <>
                  <span className="badge">{kindLabel(m.kind).toUpperCase()}</span>
                  {fmtRuntime(rt)}
                  {m.kind !== "movie" ? " per episode" : ""}
                </>
              }
            />
          );
        })}
      </div>
    </section>
  );
}
