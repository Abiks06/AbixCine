import { memo, useRef, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey, getDetail, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { cancelHoverPreview, closeHoverPreviewNow, scheduleHoverPreview } from "../lib/hoverPreview";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import type { Move } from "../lib/ranks";
import { toggleList, useSaved } from "../lib/watchlist";
import { burst } from "../lib/burst";
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
  /** Optional 35mm contact sheet frame index (e.g. "F01"). */
  frameLabel?: string;
  /** Overlay inside the artwork (end-time chip, etc.). */
  extra?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  label?: string;
  progress?: number;
  /** Live tracking/airing badge state (new episode, caught up, next air date). */
  tracking?: import("../lib/airing").TrackingState;
  to?: string;
  /** Optional direct navigation target for a secondary info button (e.g. Continue watching cards). */
  infoTo?: string;
  /** Shows a dismiss button on the artwork (Continue watching). */
  onRemove?: () => void;
  removeLabel?: string;
  /** Called when the card is opened (search remembers what you picked). */
  onOpen?: () => void;
}

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
  warmTimer = setTimeout(() => {
    warmed.add(key);
    queue.push(key);
    if (queue.length > 4) queue.shift();
    drain();
  }, 150);
}

/**
 * Memoised gallery card: unobstructed artwork at rest with structured metadata underneath.
 * Hovering reveals a floating Liquid Glass preview with full synopsis, credits, and actions,
 * while keeping card buttons strictly siblings of the anchor link for keyboard & touch access.
 */
export const Card = memo(function Card({
  media,
  index = 0,
  variant = "landscape",
  rank,
  move,
  frameLabel,
  extra,
  sub,
  right,
  label,
  progress,
  tracking,
  to,
  infoTo,
  onRemove,
  removeLabel,
  onOpen,
}: Props) {
  registerMedia(media);
  const saved = useSaved(media.key);
  const nav = useNavigate();
  const articleRef = useRef<HTMLElement>(null);
  const port = variant !== "landscape";
  const unreleased = isUnreleasedMedia(media);
  const peek = () => {
    previewLight(media);
    warm(media.key);
  };
  const aside = right ?? (rank != null && move ? <MoveBadge move={move} /> : media.rating ? <span className="star">★ {media.rating.toFixed(1)}</span> : null);

  const card = (
    <article
      ref={articleRef}
      className={`card ${port ? "port" : ""}`}
      style={{ ["--i" as string]: Math.min(index, 8) }}
      data-media-key={media.key}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") scheduleHoverPreview(media, articleRef.current, { to, onRemove, removeLabel });
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") cancelHoverPreview();
      }}
    >
      <Link
        to={to ?? `/title/${encodeKey(media.key)}`}
        state={to ? { from: "app" } : seedState(media)}
        className="card-hit"
        title={media.title}
        viewTransition
        onClick={(e) => {
          closeHoverPreviewNow();
          if (!to) tagForMorph(e);
          onOpen?.();
        }}
        onMouseEnter={peek}
        onFocus={peek}
        onMouseLeave={() => previewLight(null)}
        onBlur={() => previewLight(null)}
      >
        <div className="art-wrap gate-frame">
          <Art media={media} variant={port ? "poster" : "backdrop"} size="md" />
          <span className="gate-brackets" aria-hidden><i /></span>
          {extra}
          {progress != null && (
            <div className="prog"><i style={{ transform: `scaleX(${Math.min(1, Math.max(0.02, progress / 100))})` }} /></div>
          )}
        </div>
        <div className="card-info">
          <div className="card-name">
            {frameLabel && <span className="card-frame-no">{frameLabel}</span>}
            <span className="card-name-tx">{label ?? media.title}</span>
            {aside}
          </div>
          <div className="card-sub">
            {sub ?? (
              <>
                <span className="badge">{kindLabel(media.kind, media.format)}</span>
                {tracking?.badge ? (
                  <span className={`badge tracking-${tracking.kind}`} title={tracking.detail || tracking.badge}>
                    {tracking.badge}
                  </span>
                ) : (
                  <>
                    {media.year && <span>{media.year}</span>}
                    {unreleased ? (
                      <span className="badge dim">Soon</span>
                    ) : (
                      media.kind === "anime" ? <span className="badge dim">Sub·Dub</span> : media.genres[0] && <span className="card-genre">{media.genres[0]}</span>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </Link>

      {/* Siblings of the link, never nested inside it */}
      <div className="card-acts">
        {onRemove ? (
          <button className="act dismiss" aria-label={removeLabel ?? "Remove"} title={removeLabel ?? "Remove"} onClick={onRemove}>
            <Icon name="x" size={14} />
          </button>
        ) : !unreleased ? (
          <button
            className="act play"
            aria-label={`Play ${media.title}`}
            title="Play"
            onClick={() => {
              onOpen?.();
              nav(to ?? playHref(media), { viewTransition: true, state: { from: "app" } });
            }}
          >
            <Icon name="play" size={12} />
          </button>
        ) : null}
        <button
          className="act inspect"
          aria-label={`Quick view ${media.title}`}
          title="Quick view (I)"
          onClick={() => openDossier(media)}
        >
          <Icon name="layers" size={12} />
        </button>
        {infoTo && (
          <button
            className="act info"
            aria-label={`Details for ${media.title}`}
            title="Details"
            onClick={() => {
              onOpen?.();
              nav(infoTo, { viewTransition: true, state: seedState(media) });
            }}
          >
            <Icon name="info" size={13} />
          </button>
        )}
        <button
          className={`act save ${saved ? "on" : ""}`}
          aria-label={saved ? "Remove from My List" : "Add to My List"}
          title={saved ? "In My List" : "Add to My List"}
          aria-pressed={saved}
          onClick={(e) => {
            if (!saved) burst(e.currentTarget);
            toggleList(media);
          }}
        >
          <Icon name={saved ? "check" : "plus"} size={13} />
        </button>
      </div>
    </article>
  );

  if (rank == null) return card;
  return (
    <div className={`rank ${rank >= 10 ? "r10" : ""}`} style={{ ["--i" as string]: Math.min(index, 8) }}>
      <span className="rank-n" aria-hidden>{String(rank).padStart(2, "0")}</span>
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
