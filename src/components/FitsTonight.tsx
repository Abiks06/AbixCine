import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey, getDetail, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { fmtRuntime } from "../lib/format";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import type { Media } from "../lib/types";
import { isFilm } from "../lib/types";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { Art } from "./Art";
import { kindLabel, seedState, tagForMorph } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

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
  if (to11 >= 45 && to11 < 14 * 60) out.push({ label: "Before 23:00", max: to11 });
  if (to12 >= 45 && to12 < 15 * 60) out.push({ label: "Before 00:00", max: to12 });
  if (out.length < 2) out.unshift({ label: "Under 2h", max: 120 }, { label: "Under 1h", max: 60 });
  out.splice(2);
  out.sort((a, b) => a.max - b.max);
  out.push({ label: "All night", max: 24 * 60 });
  return out;
}

/**
 * "Fits tonight": an interactive Evening Screening Timetable showing what finishes before bedtime,
 * rendered as perforated cinema screening tickets with proportional runtime bars and tear-off end times.
 */
export function FitsTonight({ pool, loading }: { pool: Media[]; loading?: boolean }) {
  const nav = useNavigate();
  const finishInd = useSlidingIndicator();
  const [now, setNow] = useState(() => new Date());
  const opts = useMemo(() => cutoffs(now), [now.getHours() * 60 + now.getMinutes()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState(0);
  const [runtimes, setRuntimes] = useState<Record<string, number>>({});
  const runtimeCache = useRef<Map<string, number>>(new Map());
  const [settled, setSettled] = useState("");
  const keys = pool.slice(0, 18).map((m) => m.key).join("|");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    const toFetch: Media[] = [];
    const immediate: Record<string, number> = {};
    for (const m of pool.slice(0, 18)) {
      const hit = runtimeCache.current.get(m.key);
      if (hit != null) immediate[m.key] = hit;
      else if (m.runtime && m.runtime > 0 && !isUnreleasedMedia(m)) {
        runtimeCache.current.set(m.key, m.runtime);
        immediate[m.key] = m.runtime;
      } else {
        toFetch.push(m);
      }
    }
    if (Object.keys(immediate).length) {
      setRuntimes((r) => ({ ...r, ...immediate }));
    }
    if (!toFetch.length) {
      setSettled(keys);
      return;
    }

    let cursor = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (live && cursor < toFetch.length) {
        const m = toFetch[cursor++];
        try {
          const d = await getDetail(m.key);
          if (!live || !d.runtime || isUnreleasedMedia(d)) continue;
          if (!isFilm(d)) {
            const hasAired =
              [...(d.seasons ?? []), ...(d.specials ?? [])].some((s) => s.episodeCount > 0 && s.status !== "upcoming") ||
              ((d.episodeCount ?? 0) > 0 && !isUnreleasedMedia(d));
            if (!hasAired) continue;
          }
          runtimeCache.current.set(m.key, d.runtime);
          setRuntimes((r) => (r[m.key] === d.runtime ? r : { ...r, [m.key]: d.runtime! }));
        } catch {
          /* ignore */
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, worker)).then(() => {
      if (live) setSettled(keys);
    });
    return () => {
      live = false;
    };
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeOpt = opts[Math.min(sel, opts.length - 1)];
  const max = activeOpt.max;
  const fits = pool
    .filter((m, i, a) => !isUnreleasedMedia(m) && runtimes[m.key] && runtimes[m.key] <= max && a.findIndex((x) => x.key === m.key) === i)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 8);
  const pending = loading || (pool.length > 0 && settled !== keys && !Object.keys(runtimes).length);
  if (!pending && (!pool.length || !Object.keys(runtimes).length)) return null;

  const scaleMax = Math.max(120, Math.min(max, 240));
  const midClock = clock(new Date(now.getTime() + (scaleMax / 2) * 60000));
  const endClock = clock(new Date(now.getTime() + scaleMax * 60000));

  return (
    <section className="shelf timetable">
      <SectionHead
        eyebrow="Built around your evening"
        title="Fits"
        accentWord="tonight"
        right={
          <div className="fit">
            <span className="fit-now">NOW {clock(now)} · FINISH</span>
            <div className="seg-pills" role="radiogroup" aria-label="Finish by" ref={finishInd}>
              {opts.map((o, i) => (
                <button key={o.label} role="radio" aria-checked={i === sel} className={i === sel ? "on" : ""} onClick={() => setSel(i)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <div className="tt-ruler" aria-hidden>
        <span>START {clock(now)}</span>
        <span className="tt-rule" />
        <span>+{Math.round(scaleMax / 2)}M · {midClock}</span>
        <span className="tt-rule" />
        <span>CUTOFF · {activeOpt.max >= 24 * 60 ? `+4H (${endClock})` : endClock}</span>
      </div>

      <div className="tt-grid">
        {pending && Array.from({ length: 4 }, (_, i) => <div key={i} className="tt-ticket skeleton" />)}
        {!pending && fits.length === 0 && <div className="track-empty">Nothing short enough for this window. Pick a later cutoff.</div>}
        {fits.map((m, i) => {
          registerMedia(m);
          const rt = runtimes[m.key];
          const end = clock(new Date(now.getTime() + rt * 60000));
          const spanPct = Math.min(100, Math.max(14, Math.round((rt / scaleMax) * 100)));
          return (
            <article
              key={m.key}
              className="tt-ticket"
              style={{ ["--i" as string]: Math.min(i, 7) }}
              data-media-key={m.key}
              onMouseEnter={() => previewLight(m)}
              onMouseLeave={() => previewLight(null)}
            >
              <Link
                to={`/title/${encodeKey(m.key)}`}
                state={seedState(m)}
                viewTransition
                onClick={tagForMorph}
                className="tt-main"
              >
                <div className="tt-th art-wrap">
                  <Art media={m} variant="backdrop" size="sm" />
                </div>
                <div className="tt-copy">
                  <div className="tt-meta">
                    <span className="badge">{kindLabel(m.kind, m.format)}</span>
                    <span>{fmtRuntime(rt)}{!isFilm(m) ? " / ep" : ""}</span>
                    {m.rating ? <span className="star">★ {m.rating.toFixed(1)}</span> : null}
                  </div>
                  <strong className="tt-title">{m.title}</strong>
                  <div className="tt-bar" title={`Runs ${fmtRuntime(rt)}`}>
                    <i style={{ transform: `scaleX(${spanPct / 100})` }} />
                  </div>
                </div>
              </Link>

              <div className="tt-perf" aria-hidden />

              <div className="tt-stub">
                <span className="tt-end-lbl">ENDS</span>
                <b className="tt-end-val">{end}</b>
                <div className="tt-acts">
                  <button
                    type="button"
                    className="tt-btn play"
                    title={`Play ${m.title}`}
                    aria-label={`Play ${m.title}`}
                    onClick={() => nav(playHref(m), { viewTransition: true, state: { from: "app" } })}
                  >
                    <Icon name="play" size={12} />
                  </button>
                  <button
                    type="button"
                    className="tt-btn"
                    title="Quick dossier"
                    aria-label={`Quick inspect ${m.title}`}
                    onClick={() => openDossier(m)}
                  >
                    <Icon name="layers" size={12} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
