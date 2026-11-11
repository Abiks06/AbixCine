import { memo, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { encodeKey, getDetail } from "../lib/catalog";
import { previewLight } from "../lib/light";
import type { Move } from "../lib/ranks";
import { toggleList, useWatchlist } from "../lib/watchlist";
import type { Media } from "../lib/types";
import { Art } from "./Art";
import { Icon } from "./Icon";

export type CardVariant = "poster" | "landscape" | "rank";

/** Marks the clicked artwork so the view transition morphs it into the title page backdrop. */
export function tagForMorph(e: MouseEvent<HTMLElement>) {
  const art = e.currentTarget.querySelector<HTMLElement>(".art-wrap");
  if (!art) return;
  // Only one element may carry the name: the card takes it from the hero for this navigation.
  document.querySelectorAll<HTMLElement>(".hero-stage, .backdrop").forEach((el) => (el.style.viewTransitionName = "none"));
  art.style.viewTransitionName = "hero";
}

export const kindLabel = (k: Media["kind"]) => (k === "movie" ? "Movie" : k === "tv" ? "Series" : "Anime");

export function MoveBadge({ move }: { move?: Move }) {
  if (!move || move.kind === "same") return <span className="move same">–</span>;
  return <span className={`move ${move.kind}`}>{move.kind === "new" ? "NEW" : `${move.kind === "up" ? "▲" : "▼"} ${move.by}`}</span>;
}

interface Props {
  media: Media;
  index?: number;
  variant?: CardVariant;
  rank?: number;
  move?: Move;
  /** Overlay inside the artwork (fit bar, etc.). */
  extra?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  label?: string;
  progress?: number;
  to?: string;
  /** Shows a dismiss button on the artwork (Continue watching). */
  onRemove?: () => void;
  removeLabel?: string;
}

/** Hovering a card fetches its details in the background, so the title page opens instantly. */
const warmed = new Set<string>();
let warmTimer: ReturnType<typeof setTimeout> | undefined;
function warm(key: string) {
  if (warmed.has(key)) return;
  clearTimeout(warmTimer);
  // A short dwell, so sweeping the mouse across a row doesn't fire a request per card.
  warmTimer = setTimeout(() => {
    warmed.add(key);
    getDetail(key).catch(() => warmed.delete(key));
  }, 140);
}

/** Memoised: a shelf of cards shouldn't re-render because the hero above it changed slide. */
export const Card = memo(function Card({ media, index = 0, variant = "landscape", rank, move, extra, sub, right, label, progress, to, onRemove, removeLabel }: Props) {
  const saved = useWatchlist().some((e) => e.media.key === media.key);
  const port = variant !== "landscape";
  const card = (
    <Link
      to={to ?? `/title/${encodeKey(media.key)}`}
      className={`card ${port ? "port" : ""}`}
      title={media.title}
      viewTransition
      onClick={tagForMorph}
      onMouseEnter={() => {
        previewLight(media);
        warm(media.key);
      }}
      onFocus={() => {
        previewLight(media);
        warm(media.key);
      }}
      onMouseLeave={() => previewLight(null)}
      onBlur={() => previewLight(null)}
      style={{ ["--i" as any]: Math.min(index, 12) }}
    >
      <div className="art-wrap">
        <Art media={media} variant={port ? "poster" : "backdrop"} size="md" />
        {!port && <div className="shade" />}
        {extra}
        {onRemove ? (
          <button
            className="dismiss"
            aria-label={removeLabel ?? "Remove"}
            title={removeLabel ?? "Remove"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
          >
            <Icon name="x" size={13} />
          </button>
        ) : (
          <span className="hoverplay"><Icon name="play" size={13} /></span>
        )}
        <button
          className={`save ${saved ? "on" : ""}`}
          aria-label={saved ? "Remove from My List" : "Add to My List"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleList(media);
          }}
        >
          <Icon name={saved ? "check" : "plus"} size={14} />
        </button>
        {progress != null && <div className="prog"><i style={{ width: `${Math.max(2, progress)}%` }} /></div>}
      </div>
      <div className="ti">
        <span>{label ?? media.title}</span>
        {right ?? (rank != null && move ? <MoveBadge move={move} /> : media.rating ? <span className="star">★ {media.rating.toFixed(1)}</span> : null)}
      </div>
      <div className="sub">
        {sub ?? (
          <>
            <span className="badge">{kindLabel(media.kind).toUpperCase()}</span>
            {media.year}
            {media.kind === "anime" && <span className="badge">SUB | DUB</span>}
          </>
        )}
      </div>
    </Link>
  );
  if (rank == null) return card;
  return (
    <div className="rank" style={{ ["--i" as any]: Math.min(index, 12) }}>
      <span className="n" aria-hidden>{rank}</span>
      {card}
    </div>
  );
});

export function CardSkeleton({ variant = "landscape" }: { variant?: CardVariant }) {
  return (
    <div className={`card skeleton ${variant !== "landscape" ? "port" : ""}`}>
      <div className="art-wrap" />
      <div className="ti"><span className="sk-line" /></div>
    </div>
  );
}
