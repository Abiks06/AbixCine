import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { fmtRuntime } from "../lib/format";
import { useFeatured, type Featured } from "../lib/useLogos";
import { toggleList, useWatchlist } from "../lib/watchlist";
import { playHref } from "../lib/play";
import { setStageLight } from "../lib/light";
import { useSettings } from "../lib/settings";
import type { Media } from "../lib/types";
import { Art } from "./Art";
import { kindLabel } from "./Card";
import { Icon } from "./Icon";
import { TitleArt } from "./TitleArt";

const SLIDE_MS = 8000;

const length = (m: Featured) =>
  m.kind === "movie"
    ? fmtRuntime(m.runtime)
    : m.seasons?.length
      ? `${m.seasons.length} season${m.seasons.length > 1 ? "s" : ""}`
      : m.episodeCount
        ? `${m.episodeCount} episode${m.episodeCount === 1 ? "" : "s"}`
        : "";

/** Rotating spotlight: title art, chips, actions, a progress timeline and an "Up next" strip. */
export function Hero({ items, label, onActive }: { items: Media[]; label: string; onActive?: (m: Media) => void }) {
  const picks = useFeatured(items.filter((m) => m.backdrop || m.hue != null).slice(0, 6));
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const nav = useNavigate();
  const list = useWatchlist();
  const n = picks.length;
  const cur = n ? i % n : 0;
  const m = picks[cur];

  // Don't rotate while the window is in the background or the hero is scrolled away.
  const root = useRef<HTMLElement>(null);
  const [away, setAway] = useState(false);
  const ready = n > 0;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let seen = true;
    const sync = () => setAway(document.hidden || !seen);
    const io = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      sync();
    }, { threshold: 0.25 });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [ready]);
  const hold = paused || away;

  // The slide advances when its progress bar finishes (onAnimationEnd below), so pausing on hover,
  // focus or visibility keeps bar and slide in step. Reduced motion: no autoplay at all (WCAG 2.2.2).
  const still = useSettings().reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const advance = () => n > 1 && setI((x) => (x + 1) % n);

  // Only slides that have been on screen carry an image: the current one and both neighbours
  // (so crossfades and either-direction nav still work), kept mounted once shown so a repeat
  // loop never re-downloads or re-fades a picture.
  const mounted = useRef(new Set<string>());
  for (const p of [picks[cur], picks[(cur + 1) % Math.max(1, n)], picks[(cur - 1 + n) % Math.max(1, n)]]) if (p) mounted.current.add(p.key);

  useEffect(() => {
    if (!m) return;
    setStageLight(m);
    onActive?.(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key, m?.backdrop]);

  if (!m) return <section className="hero hero-skeleton" ref={root} />;
  const saved = list.some((e) => e.media.key === m.key);
  const upNext = [1, 2, 3].map((k) => picks[(cur + k) % n]).filter((x) => x && x.key !== m.key);
  const len = length(m);

  return (
    <section
      className="hero"
      ref={root}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setPaused(false)}
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowRight") setI((cur + 1) % n);
        else if (e.key === "ArrowLeft") setI((cur - 1 + n) % n);
      }}
    >
      <div className="hero-stage" style={{ viewTransitionName: "hero" }}>
        {picks.map((p, j) => (
          <div key={p.key} className={`hero-bg ${j === cur ? "on" : ""}`}>
            {mounted.current.has(p.key) && <Art media={p} variant="backdrop" hd priority={j === cur} />}
          </div>
        ))}
      </div>
      <div className="shade" />
      <div className="copy pad" key={m.key}>
        <div className="eyebrow">
          <span className="tag"><Icon name="spark" size={12} /> #{cur + 1} {label}</span>
          {[kindLabel(m.kind), m.year, ...m.genres.slice(0, 2)].filter(Boolean).join(" · ")}
        </div>
        <TitleArt media={m} />
        <div className="meta">
          {m.rating ? <span className="chip score">★ {m.rating.toFixed(1)}</span> : null}
          {len && <span className="chip">{len}</span>}
          {m.kind === "anime" && <span className="chip hi">SUB | DUB</span>}
          {m.genres[2] && <span className="chip">{m.genres[2]}</span>}
        </div>
        <p className="desc">{m.overview}</p>
        <div className="acts">
          <button className="btn play" onClick={() => nav(playHref(m), { viewTransition: true, state: { from: "app" } })}>
            <Icon name="play" size={16} /> Play
          </button>
          <Link className="btn glass" to={`/title/${encodeKey(m.key)}`} viewTransition>
            <Icon name="info" size={18} /> Details
          </Link>
          <button className={`btn glass icon ${saved ? "on" : ""}`} onClick={() => toggleList(m)} aria-label={saved ? "Remove from My List" : "Add to My List"}>
            <Icon name={saved ? "check" : "plus"} size={20} />
          </button>
        </div>
      </div>
      <div className="heroNav pad">
        {picks.map((p, j) => (
          <button key={p.key} className={j === cur ? "on" : j < cur ? "done" : ""} onClick={() => setI(j)} aria-label={`Show ${p.title}`}>
            {j === cur && !still && (
              <i key={cur} onAnimationEnd={advance} style={{ animationPlayState: hold ? "paused" : "running", animationDuration: `${SLIDE_MS}ms` }} />
            )}
          </button>
        ))}
      </div>
      {upNext.length > 0 && (
        <div className="next">
          <h6>Up next</h6>
          <div className="row3">
            {upNext.map((p) => (
              <button key={p.key} className="mini" onClick={() => setI(picks.indexOf(p))}>
                <Art media={p} variant="backdrop" size="sm" />
                <span className="lt">{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
