import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { useFeatured } from "../lib/useLogos";
import { toggleList, useWatchlist } from "../lib/watchlist";
import type { Media } from "../lib/types";
import { Art } from "./Art";
import { kindLabel } from "./Card";
import { Icon } from "./Icon";
import { LogoMark } from "./Logo";
import { TitleArt } from "./TitleArt";

const SLIDE_MS = 9000;

/** Rotating spotlight: title art, meta pills, actions, an "Up next" strip, and a segmented timer. */
export function Hero({ items, label, onActive }: { items: Media[]; label: string; onActive?: (m: Media) => void }) {
  const picks = useFeatured(items.filter((m) => m.backdrop || m.hue != null).slice(0, 8));
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

  if (!m) return <div className="hero hero-skeleton" />;
  const saved = list.some((e) => e.media.key === m.key);
  const upNext = [1, 2, 3].map((k) => picks[(cur + k) % n]).filter((x) => x && x.key !== m.key);
  const stars = Math.round((m.rating ?? 0) / 2);

  return (
    <section className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      {picks.map((p, j) => (
        <div key={p.key} className={`hero-bg ${j === cur ? "on" : ""}`}>
          <Art media={p} variant="backdrop" />
        </div>
      ))}
      <div className="hero-scrim" />
      <div className="hero-body" key={m.key}>
        <div className="hero-tags">
          <span className="brand-chip"><LogoMark size={13} /> ABIXCINE</span>
          <span className="eyebrow"><i className="dot" /> #{cur + 1} {label} · {kindLabel(m.kind)}{m.year ? ` · ${m.year}` : ""}</span>
        </div>
        <TitleArt media={m} />
        <div className="hero-meta">
          {m.rating ? (
            <span className="stars" aria-label={`${m.rating} out of 10`}>
              {[0, 1, 2, 3, 4].map((s) => <Icon key={s} name="star" size={15} className={s < stars ? "on" : ""} />)}
              <b>{Math.round(m.rating * 10)}%</b>
            </span>
          ) : null}
          {m.genres.slice(0, 3).map((g) => <span key={g} className="tag">{g}</span>)}
        </div>
        <p>{m.overview}</p>
        <div className="hero-actions">
          <button className="btn btn-primary" onClick={() => nav(`/watch/${encodeKey(m.key)}`, { viewTransition: true })}>
            <Icon name="play" /> Play
          </button>
          <Link className="btn btn-glass" to={`/title/${encodeKey(m.key)}`} viewTransition>
            <Icon name="info" /> More info
          </Link>
          <button className={`icon-btn circle ${saved ? "on" : ""}`} onClick={() => toggleList(m)} aria-label={saved ? "Remove from My List" : "Add to My List"}>
            <Icon name={saved ? "bookmarkOn" : "bookmark"} size={18} />
          </button>
        </div>
        <div className="hero-progress">
          <div className="dashes">
            {picks.map((p, j) => (
              <button key={p.key} className={j === cur ? "on" : j < cur ? "done" : ""} onClick={() => setI(j)} aria-label={`Show ${p.title}`}>
                {j === cur && <i key={`${cur}-${paused}`} style={{ animationPlayState: paused ? "paused" : "running" }} />}
              </button>
            ))}
          </div>
          <button className="icon-btn circle sm" onClick={() => setI((cur - 1 + n) % n)} aria-label="Previous"><Icon name="chevL" size={16} /></button>
          <button className="icon-btn circle sm" onClick={() => setI((cur + 1) % n)} aria-label="Next"><Icon name="chevR" size={16} /></button>
        </div>
      </div>

      {upNext.length > 0 && (
        <div className="up-next">
          <span className="sec-eyebrow">Up next</span>
          <div className="up-next-row">
            {upNext.map((p) => (
              <button key={p.key} className="up-card" onClick={() => setI(picks.indexOf(p))}>
                <Art media={p} variant="backdrop" />
                <span>{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
