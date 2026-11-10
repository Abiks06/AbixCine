import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { fmtRuntime } from "../lib/format";
import { useFeatured, type Featured } from "../lib/useLogos";
import { toggleList, useWatchlist } from "../lib/watchlist";
import { playHref } from "../lib/play";
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
        ? `${m.episodeCount} episodes`
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

  useEffect(() => {
    if (n < 2 || paused) return;
    const t = setTimeout(() => setI((x) => (x + 1) % n), SLIDE_MS);
    return () => clearTimeout(t);
  }, [n, cur, paused]);

  useEffect(() => {
    if (m) onActive?.(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key, m?.backdrop]);

  if (!m) return <section className="hero hero-skeleton" />;
  const saved = list.some((e) => e.media.key === m.key);
  const upNext = [1, 2, 3].map((k) => picks[(cur + k) % n]).filter((x) => x && x.key !== m.key);
  const len = length(m);

  return (
    <section className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="hero-stage" style={{ viewTransitionName: "hero" }}>
        {picks.map((p, j) => (
          <div key={p.key} className={`hero-bg ${j === cur ? "on" : ""}`}>
            <Art media={p} variant="backdrop" />
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
            {j === cur && <i key={cur} style={{ animationPlayState: paused ? "paused" : "running", animationDuration: `${SLIDE_MS}ms` }} />}
          </button>
        ))}
      </div>
      {upNext.length > 0 && (
        <div className="next">
          <h6>Up next</h6>
          <div className="row3">
            {upNext.map((p) => (
              <button key={p.key} className="mini" onClick={() => setI(picks.indexOf(p))}>
                <Art media={p} variant="backdrop" />
                <span className="lt">{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
