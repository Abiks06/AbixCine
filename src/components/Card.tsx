import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { toggleList, useWatchlist } from "../lib/watchlist";
import type { Media } from "../lib/types";
import { Art } from "./Art";
import { Icon } from "./Icon";

export type CardVariant = "poster" | "landscape" | "rank";

/** Marks the clicked artwork so the view transition morphs it into the title page. */
export function tagForMorph(e: MouseEvent<HTMLElement>) {
  const art = e.currentTarget.querySelector<HTMLElement>(".card-frame");
  if (art) art.style.viewTransitionName = "hero-poster";
}

/** Light follows the cursor and the card tilts a few degrees toward it. */
function track(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  el.style.setProperty("--mx", `${x * 100}%`);
  el.style.setProperty("--my", `${y * 100}%`);
  el.style.setProperty("--rx", `${(0.5 - y) * 6}deg`);
  el.style.setProperty("--ry", `${(x - 0.5) * 8}deg`);
}
function reset(e: MouseEvent<HTMLElement>) {
  e.currentTarget.style.setProperty("--rx", "0deg");
  e.currentTarget.style.setProperty("--ry", "0deg");
}

export const kindLabel = (k: Media["kind"]) => (k === "movie" ? "Movie" : k === "tv" ? "Series" : "Anime");

export function Card({ media, index = 0, variant = "poster", rank }: { media: Media; index?: number; variant?: CardVariant; rank?: number }) {
  const saved = useWatchlist().some((e) => e.media.key === media.key);
  const landscape = variant !== "poster";
  return (
    <Link
      to={`/title/${encodeKey(media.key)}`}
      className={`card card-${variant}`}
      title={media.title}
      viewTransition
      onClick={tagForMorph}
      onMouseMove={track}
      onMouseLeave={reset}
      style={{ ["--i" as any]: Math.min(index, 12) }}
    >
      {rank != null && <span className="rank-num" aria-hidden>{rank}</span>}
      <div className="card-body">
        <div className="card-frame">
          <Art media={media} variant={landscape ? "backdrop" : "poster"} />
          <div className="card-light" />
          {landscape && <span className="card-play"><Icon name="play" size={20} /></span>}
          <button
            className={`card-save ${saved ? "on" : ""}`}
            aria-label={saved ? "Remove from My List" : "Add to My List"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleList(media);
            }}
          >
            <Icon name={saved ? "check" : "plus"} size={14} />
          </button>
          {!landscape && media.rating ? <span className="card-rating"><Icon name="star" size={10} />{media.rating.toFixed(1)}</span> : null}
        </div>
        <div className="card-meta">
          <div className="card-title">{media.title}</div>
          <div className="card-sub">
            <span className="type-pill">{kindLabel(media.kind)}</span>
            {media.year && <span>{media.year}</span>}
            {landscape && media.rating ? <span className="card-star"><Icon name="star" size={11} />{media.rating.toFixed(1)}</span> : null}
          </div>
        </div>
      </div>
    </Link>
  );
}

export function CardSkeleton({ variant = "poster" }: { variant?: CardVariant }) {
  return (
    <div className={`card card-${variant} skeleton`}>
      <div className="card-body">
        <div className="card-frame"><div className={`art ${variant === "poster" ? "art-poster" : "art-backdrop"}`} /></div>
      </div>
    </div>
  );
}
