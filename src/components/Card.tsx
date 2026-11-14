import { memo, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey, getDetail } from "../lib/catalog";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import type { Move } from "../lib/ranks";
import { toggleList, useSaved } from "../lib/watchlist";
import type { Media } from "../lib/types";
import { Art } from "./Art";
import { Icon } from "./Icon";

export type CardVariant = "poster" | "landscape" | "rank";

/**
 * Marks the clicked artwork so the view transition morphs it into the title page backdrop.
 * Only one element may carry the name, so whatever stage is on screen gives it up for this
 * navigation, and the card gives it back once the transition has taken its snapshot.
 */
export function tagForMorph(e: MouseEvent<HTMLElement>) {
  const art = e.currentTarget.querySelector<HTMLElement>(".art-wrap");
  if (!art) return;
  const stages = [...document.querySelectorAll<HTMLElement>(".hero-stage, .tp-stage")];
  const before = stages.map((el) => el.style.viewTransitionName);
  stages.forEach((el) => (el.style.viewTransitionName = "none"));
  art.style.viewTransitionName = "hero";
  setTimeout(() => {
    art.style.viewTransitionName = "";
    stages.forEach((el, i) => el.isConnected && (el.style.viewTransitionName = before[i]));
  }, 700);
}

export const kindLabel = (k: Media["kind"], format?: string) =>
  k === "movie" ? "Film" : k === "tv" ? "Series" : format?.toUpperCase() === "MOVIE" ? "Anime film" : "Anime";

/** What a title page needs to paint its first frame before the catalog answers. */
export const seedState = (m: Media) => ({ seed: m });

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
  /** Overlay inside the artwork (end-time chip, etc.). */
  extra?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  label?: string;
  progress?: number;
  to?: string;
  /** Shows a dismiss button on the artwork (Continue watching). */
  onRemove?: () => void;
  removeLabel?: string;
  /** Called when the card is opened (search remembers what you picked). */
  onOpen?: () => void;
}

/**
 * Hovering a card fetches its details in the background, so the title page opens instantly.
 * At most two lookups run at once and the newest hover goes first, so a sweep along a shelf
 * never queues a request per card.
 */
const warmed = new Set<string>();
const queue: string[] = [];
let warming = 0;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
function drain() {
  while (warming < 2 && queue.length) {
    const key = queue.pop()!;
    warming++;
    getDetail(key)
      .catch(() => warmed.delete(key))
      .finally(() => {
        warming--;
        drain();
      });
  }
}
function warm(key: string) {
  if (warmed.has(key)) return;
  if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
  clearTimeout(warmTimer);
  // A short dwell, so sweeping the mouse across a row doesn't fire a request per card.
  warmTimer = setTimeout(() => {
    warmed.add(key);
    queue.push(key);
    if (queue.length > 4) queue.shift();
    drain();
  }, 150);
}

/** Memoised: a shelf of cards shouldn't re-render because the hero above it changed slide. */
export const Card = memo(function Card({ media, index = 0, variant = "landscape", rank, move, extra, sub, right, label, progress, to, onRemove, removeLabel, onOpen }: Props) {
  const saved = useSaved(media.key);
  const nav = useNavigate();
  const port = variant !== "landscape";
  const peek = () => {
    previewLight(media);
    warm(media.key);
  };
  const aside = right ?? (rank != null && move ? <MoveBadge move={move} /> : media.rating ? <span className="star">★ {media.rating.toFixed(1)}</span> : null);
  const card = (
    <article className={`card ${port ? "port" : ""}`} style={{ ["--i" as string]: Math.min(index, 8) }}>
      <Link
        to={to ?? `/title/${encodeKey(media.key)}`}
        state={to ? { from: "app" } : seedState(media)}
        className="card-hit"
        title={media.title}
        viewTransition
        onClick={(e) => {
          if (!to) tagForMorph(e);
          onOpen?.();
        }}
        onMouseEnter={peek}
        onFocus={peek}
        onMouseLeave={() => previewLight(null)}
        onBlur={() => previewLight(null)}
      >
        <div className="art-wrap">
          <Art media={media} variant={port ? "poster" : "backdrop"} size="md" />
          {!port && <div className="card-shade" />}
          {!port && <span className="card-title">{label ?? media.title}</span>}
          {extra}
          {progress != null && <div className="prog"><i style={{ transform: `scaleX(${Math.min(1, Math.max(0.02, progress / 100))})` }} /></div>}
        </div>
        <div className="card-info">
          {port && (
            <div className="card-name">
              <span>{label ?? media.title}</span>
              {aside}
            </div>
          )}
          <div className="card-sub">
            {sub ?? (
              <>
                <span className="badge">{kindLabel(media.kind, media.format)}</span>
                {media.year}
                {media.kind === "anime" && <span className="badge dim">Sub · Dub</span>}
              </>
            )}
            {!port && aside}
          </div>
        </div>
      </Link>
      {/* Siblings of the link, not children: a button inside an anchor is invalid and unreachable by keyboard. */}
      <div className="card-acts">
        {onRemove ? (
          <button className="act dismiss" aria-label={removeLabel ?? "Remove"} title={removeLabel ?? "Remove"} onClick={onRemove}>
            <Icon name="x" size={14} />
          </button>
        ) : (
          <button
            className="act play"
            aria-label={`Play ${media.title}`}
            title="Play"
            onClick={() => {
              onOpen?.();
              nav(to ?? playHref(media), { viewTransition: true, state: { from: "app" } });
            }}
          >
            <Icon name="play" size={13} />
          </button>
        )}
        <button className={`act save ${saved ? "on" : ""}`} aria-label={saved ? "Remove from My List" : "Add to My List"} title={saved ? "In My List" : "Add to My List"} aria-pressed={saved} onClick={() => toggleList(media)}>
          <Icon name={saved ? "check" : "plus"} size={15} />
        </button>
      </div>
    </article>
  );
  if (rank == null) return card;
  return (
    <div className={`rank ${rank >= 10 ? "r10" : ""}`} style={{ ["--i" as string]: Math.min(index, 8) }}>
      <span className="rank-n" aria-hidden>{rank}</span>
      {card}
    </div>
  );
});

export function CardSkeleton({ variant = "landscape" }: { variant?: CardVariant }) {
  return (
    <div className={`card skeleton ${variant !== "landscape" ? "port" : ""}`}>
      <div className="art-wrap" />
      <div className="card-info"><span className="sk-line" /></div>
    </div>
  );
}
