import { memo, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { fmtAirBadge } from "../lib/format";
import { cancelHoverPreview, closeHoverPreviewNow, scheduleHoverPreview } from "../lib/hoverPreview";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import { burst } from "../lib/burst";
import {
  BASE_REEL_SPEED,
  clamp,
  classifyWheelGesture,
  DRAG_THRESHOLD,
  SPROCKET_PITCH,
  spoolAngleDeg,
  stepReelPhysics,
  velocityTiltDeg,
  wrapOffset,
} from "../lib/reelPhysics";
import { useSettings } from "../lib/settings";
import type { Media } from "../lib/types";
import { toggleList, useSaved } from "../lib/watchlist";
import { Art } from "./Art";
import { CardSkeleton, kindLabel, seedState, tagForMorph } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

const SPEEDS = [0.75, 1, 1.6] as const;

function fmtAiringChip(nextAiring?: Media["nextAiring"]) {
  if (!nextAiring) return null;
  return fmtAirBadge(nextAiring).toUpperCase();
}

function ReelSpool({ innerRef }: { innerRef: RefObject<SVGSVGElement> }) {
  return (
    <svg
      ref={innerRef}
      className="fr-spool"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" opacity="0.88" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
      <circle cx="8" cy="4" r="1.15" fill="currentColor" opacity="0.85" />
      <circle cx="4.55" cy="10" r="1.15" fill="currentColor" opacity="0.85" />
      <circle cx="11.45" cy="10" r="1.15" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

const ReelFrame = memo(function ReelFrame({
  media,
  index,
  variant,
  clone = false,
}: {
  media: Media;
  index: number;
  variant: "poster" | "landscape";
  clone?: boolean;
}) {
  registerMedia(media);
  const nav = useNavigate();
  const frameRef = useRef<HTMLElement>(null);
  const saved = useSaved(media.key);
  const port = variant === "poster";
  const unreleased = isUnreleasedMedia(media);
  const airing = fmtAiringChip(media.nextAiring);

  return (
    <article
      ref={frameRef}
      className={`fr-frame card ${port ? "port" : ""}`}
      data-media-key={media.key}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") scheduleHoverPreview(media, frameRef.current);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") cancelHoverPreview();
      }}
    >
      <div className="fr-head">
        <span className="fr-code">{String(index + 1).padStart(2, "0")}A</span>
        {airing ? (
          <span className="fr-air"><i />{airing}</span>
        ) : media.rating ? (
          <span className="star">★ {media.rating.toFixed(1)}</span>
        ) : media.year ? (
          <span className="fr-yr">{media.year}</span>
        ) : null}
      </div>

      <Link
        to={`/title/${encodeKey(media.key)}`}
        state={seedState(media)}
        viewTransition
        tabIndex={clone ? -1 : undefined}
        className="card-hit"
        title={media.title}
        onClick={(e) => {
          closeHoverPreviewNow();
          if (!clone) tagForMorph(e);
        }}
        onMouseEnter={() => previewLight(media)}
        onMouseLeave={() => previewLight(null)}
        onFocus={clone ? undefined : () => previewLight(media)}
        onBlur={clone ? undefined : () => previewLight(null)}
      >
        <div className="art-wrap gate-frame">
          <Art media={media} variant={port ? "poster" : "backdrop"} size="md" eager={index < 8} />
          <span className="gate-brackets" aria-hidden><i /></span>
        </div>
        <div className="card-info">
          <div className="card-name">
            <span className="card-name-tx">{media.title}</span>
          </div>
          <div className="card-sub">
            <span className="badge">{kindLabel(media.kind, media.format)}</span>
            {media.genres[0] && <span className="card-genre">{media.genres[0]}</span>}
          </div>
        </div>
      </Link>

      <div className="card-acts">
        {!unreleased && (
          <button
            type="button"
            tabIndex={clone ? -1 : undefined}
            className="act play"
            aria-label={`Play ${media.title}`}
            title="Play"
            onClick={() => nav(playHref(media), { viewTransition: true, state: { from: "app" } })}
          >
            <Icon name="play" size={12} />
          </button>
        )}
        <button
          type="button"
          tabIndex={clone ? -1 : undefined}
          className="act inspect"
          aria-label={`Quick inspect ${media.title}`}
          title="Quick dossier"
          onClick={() => openDossier(media)}
        >
          <Icon name="layers" size={12} />
        </button>
        <button
          type="button"
          tabIndex={clone ? -1 : undefined}
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
});

/**
 * Animated 35mm Cinema Film Reel:
 * Physics-driven flywheel transport supporting 60/120fps continuous roll, weighted ease-to-stop
 * deceleration on hover/focus/pause, synchronized sprocket tracks, rotating spool indicator, and
 * full gesture scrubbing (trackpad swipe, Shift+wheel, touch swipe, and mouse click-and-drag with inertia).
 */
export function FilmReel({
  eyebrow,
  title,
  accentWord,
  to,
  items,
  loading,
  variant = "poster",
  edgeLabel = "SIMULCAST",
}: {
  eyebrow?: string;
  title: string;
  accentWord?: string;
  to?: string;
  items?: Media[];
  loading?: boolean;
  variant?: "poster" | "landscape";
  edgeLabel?: string;
}) {
  const still =
    useSettings().reduceMotion ||
    (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [paused, setPaused] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);

  const reelRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const primarySetRef = useRef<HTMLDivElement>(null);
  const topPerfRef = useRef<HTMLDivElement>(null);
  const botPerfRef = useRef<HTMLDivElement>(null);
  const spoolRef = useRef<SVGSVGElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  const pausedRef = useRef(paused);
  const speedRef = useRef<number>(SPEEDS[speedIdx]);
  pausedRef.current = paused;
  speedRef.current = SPEEDS[speedIdx];

  const physRef = useRef({
    pos: 0,
    vel: BASE_REEL_SPEED,
    span: 0,
    hovering: false,
    focused: false,
    dragging: false,
    coastUntil: 0,
    suppressClickUntil: 0,
    inView: true,
    docHidden: false,
  });

  const dragCancelRef = useRef<(() => void) | null>(null);

  const list = useMemo(() => (items ?? []).slice(0, 32), [items]);
  const speed = SPEEDS[speedIdx];
  const shouldRoll = !still && !loading && list.length >= 4;
  const cloneCount = list.length <= 6 ? 3 : list.length <= 12 ? 2 : 1;

  const paintTransforms = () => {
    const p = physRef.current;
    const track = trackRef.current;
    if (track) {
      const tilt = velocityTiltDeg(p.vel);
      track.style.transform =
        tilt !== 0
          ? `translate3d(${-p.pos.toFixed(2)}px, 0, 0) skewX(${tilt.toFixed(3)}deg)`
          : `translate3d(${-p.pos.toFixed(2)}px, 0, 0)`;
    }
    const perfShift = -wrapOffset(p.pos, SPROCKET_PITCH);
    const perfTx = `translate3d(${perfShift.toFixed(2)}px, 0, 0)`;
    if (topPerfRef.current) topPerfRef.current.style.transform = perfTx;
    if (botPerfRef.current) botPerfRef.current.style.transform = perfTx;
    if (spoolRef.current) {
      spoolRef.current.style.transform = `rotate(${spoolAngleDeg(p.pos).toFixed(1)}deg)`;
    }
    if (progressRef.current) {
      const ratio = p.span > 0 ? p.pos / p.span : 0;
      progressRef.current.style.transform = `scaleX(${ratio.toFixed(4)})`;
    }
  };

  // Measure the primary set width cleanly for seamless infinite wrap
  useEffect(() => {
    const primary = primarySetRef.current;
    if (!shouldRoll || !primary) {
      physRef.current.span = 0;
      physRef.current.pos = 0;
      if (trackRef.current) trackRef.current.style.transform = "";
      if (topPerfRef.current) topPerfRef.current.style.transform = "";
      if (botPerfRef.current) botPerfRef.current.style.transform = "";
      if (spoolRef.current) spoolRef.current.style.transform = "";
      if (progressRef.current) progressRef.current.style.transform = "";
      return;
    }

    const measure = () => {
      const w = primary.getBoundingClientRect().width || primary.scrollWidth;
      if (w > 0) {
        physRef.current.span = w;
        physRef.current.pos = wrapOffset(physRef.current.pos, w);
        paintTransforms();
      }
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(primary);
    return () => ro.disconnect();
  }, [shouldRoll, list.length, variant]);

  // Flywheel rAF loop gated by IntersectionObserver + tab visibility
  useEffect(() => {
    if (!shouldRoll) return;
    const p = physRef.current;
    let rafId = 0;
    let lastTs = 0;
    let running = false;

    const tick = (ts: number) => {
      rafId = 0;
      if (!running) return;
      const dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
      lastTs = ts;

      if (p.span <= 0 && primarySetRef.current) {
        const w = primarySetRef.current.getBoundingClientRect().width || primarySetRef.current.scrollWidth;
        if (w > 0) p.span = w;
      }

      const now = performance.now();
      const held = pausedRef.current || p.hovering || p.focused;
      const targetVel = held ? 0 : BASE_REEL_SPEED * speedRef.current;
      const next = stepReelPhysics(
        { pos: p.pos, vel: p.vel },
        {
          span: p.span,
          targetVel,
          dt,
          coasting: now < p.coastUntil,
          dragging: p.dragging,
        },
      );
      p.pos = next.pos;
      p.vel = next.vel;
      paintTransforms();

      rafId = requestAnimationFrame(tick);
    };

    const syncLoop = () => {
      const want = p.inView && !p.docHidden;
      if (want && !running) {
        running = true;
        lastTs = 0;
        rafId = requestAnimationFrame(tick);
      } else if (!want && running) {
        running = false;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      }
    };

    const reelEl = reelRef.current;
    let io: IntersectionObserver | null = null;
    if (reelEl && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          p.inView = !entry || entry.isIntersecting || entry.intersectionRatio > 0;
          syncLoop();
        },
        { rootMargin: "160px 0px" },
      );
      io.observe(reelEl);
    }

    p.docHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const onVis = () => {
      p.docHidden = document.visibilityState === "hidden";
      syncLoop();
    };
    document.addEventListener("visibilitychange", onVis);

    syncLoop();
    return () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [shouldRoll]);

  // Non-passive horizontal wheel / trackpad gesture handler (preserves vertical page scroll)
  useEffect(() => {
    const vp = viewportRef.current;
    if (!shouldRoll || !vp) return;

    const onWheel = (e: WheelEvent) => {
      const { delta, discrete } = classifyWheelGesture(
        e.deltaX,
        e.deltaY,
        e.shiftKey,
        e.deltaMode,
        vp.clientWidth || 800,
      );
      if (delta === 0) return;

      e.preventDefault();
      previewLight(null);
      closeHoverPreviewNow();
      const p = physRef.current;
      const now = performance.now();

      if (discrete) {
        p.vel = clamp(p.vel * 0.35 + delta * 7.5, -2600, 2600);
        p.coastUntil = now + 680;
      } else {
        if (p.span > 0) {
          p.pos = wrapOffset(p.pos + delta, p.span);
        }
        p.vel = clamp(delta * 12, -2000, 2000) * 0.36;
        p.coastUntil = now + 260;
        paintTransforms();
      }
    };

    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [shouldRoll]);

  // Cleanup active pointer listeners on unmount
  useEffect(() => {
    return () => {
      dragCancelRef.current?.();
    };
  }, []);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!shouldRoll) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest(".card-acts")) return;

    dragCancelRef.current?.();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = e.clientX;
    let lastTime = performance.now();
    let dragVel = 0;
    let locked = false;

    const finish = (applyCoast: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      dragCancelRef.current = null;

      const p = physRef.current;
      p.dragging = false;
      reelRef.current?.classList.remove("dragging");

      if (locked) {
        p.suppressClickUntil = performance.now() + 220;
        if (applyCoast) {
          p.vel = clamp(dragVel, -2800, 2800);
          p.coastUntil = performance.now() + 1050;
        }
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - lastX;
      const totalDx = ev.clientX - startX;
      const totalDy = ev.clientY - startY;

      if (!locked) {
        if (Math.abs(totalDy) > 8 && Math.abs(totalDy) > Math.abs(totalDx) * 1.25) {
          finish(false);
          return;
        }
        if (Math.abs(totalDx) < DRAG_THRESHOLD) return;
        locked = true;
        physRef.current.dragging = true;
        physRef.current.vel = 0;
        reelRef.current?.classList.add("dragging");
        previewLight(null);
        closeHoverPreviewNow();
      }

      const now = performance.now();
      const dt = Math.max(0.004, (now - lastTime) / 1000);
      lastTime = now;
      lastX = ev.clientX;

      const p = physRef.current;
      if (p.span > 0) {
        p.pos = wrapOffset(p.pos - dx, p.span);
      }
      const instVel = -dx / dt;
      dragVel = dragVel * 0.55 + instVel * 0.45;
      p.vel = clamp(dragVel * 0.45, -2400, 2400);
      paintTransforms();
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finish(true);
    };

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finish(false);
    };

    dragCancelRef.current = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const step = (dir: -1 | 1) => {
    const vp = viewportRef.current;
    if (!shouldRoll && vp) {
      vp.scrollBy({ left: dir * vp.clientWidth * 0.72, behavior: "smooth" });
      return;
    }
    const p = physRef.current;
    p.vel = clamp(p.vel * 0.38 + dir * 1550, -3000, 3000);
    p.coastUntil = performance.now() + 850;
  };

  if (!loading && !list.length) return null;

  return (
    <section className="shelf filmreel-section">
      <SectionHead
        eyebrow={eyebrow}
        title={title}
        accentWord={accentWord}
        to={to}
        right={
          !loading && list.length > 0 ? (
            <div className="fr-transport">
              {!still && (
                <>
                  <button
                    type="button"
                    className={`fr-pill ${paused ? "paused" : "rolling"}`}
                    onClick={() => setPaused((p) => !p)}
                    aria-pressed={paused}
                    title={paused ? "Resume reel motion" : "Pause reel motion"}
                  >
                    <ReelSpool innerRef={spoolRef} />
                    <span>{paused ? "PAUSED" : "ROLLING"}</span>
                  </button>
                  <button
                    type="button"
                    className="fr-speed"
                    onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
                    title="Cycle reel speed"
                  >
                    {speed}×
                  </button>
                </>
              )}
              <div className="shelf-nav">
                <button type="button" className="nav-btn" onClick={() => step(-1)} aria-label="Step reel back">
                  <Icon name="chevL" size={15} />
                </button>
                <button type="button" className="nav-btn" onClick={() => step(1)} aria-label="Step reel forward">
                  <Icon name="chevR" size={15} />
                </button>
              </div>
            </div>
          ) : undefined
        }
      />

      <div
        ref={reelRef}
        className={`filmreel ${paused ? "paused" : ""} ${shouldRoll ? "rolling" : "static"}`}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") physRef.current.hovering = true;
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") physRef.current.hovering = false;
        }}
        onFocus={() => {
          physRef.current.focused = true;
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            physRef.current.focused = false;
          }
        }}
      >
        <div className="fr-perfs top" aria-hidden="true">
          <div className="fr-perfs-rail" ref={topPerfRef} />
          <span className="fr-edge-code">ABX 35MM · {edgeLabel} · {list.length} REELS</span>
          {shouldRoll && <span className="fr-gate-mark" />}
          {shouldRoll && <span className="fr-hint">DRAG · SWIPE</span>}
        </div>

        <div
          className="fr-viewport"
          ref={viewportRef}
          onPointerDown={handlePointerDown}
          onDragStart={(e) => e.preventDefault()}
          onClickCapture={(e) => {
            if (performance.now() < physRef.current.suppressClickUntil) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          {loading && !list.length ? (
            <div className="fr-set">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="fr-frame-sk">
                  <CardSkeleton variant={variant} />
                </div>
              ))}
            </div>
          ) : shouldRoll ? (
            <div className="fr-track" ref={trackRef}>
              <div className="fr-set" ref={primarySetRef}>
                {list.map((m, i) => (
                  <ReelFrame key={m.key} media={m} index={i} variant={variant} />
                ))}
              </div>
              {Array.from({ length: cloneCount }, (_, cIdx) => (
                <div key={`clone-${cIdx}`} className="fr-set" aria-hidden="true">
                  {list.map((m, i) => (
                    <ReelFrame key={`dup-${cIdx}-${m.key}`} media={m} index={i} variant={variant} clone />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="fr-track static" ref={trackRef}>
              <div className="fr-set" ref={primarySetRef}>
                {list.map((m, i) => (
                  <ReelFrame key={m.key} media={m} index={i} variant={variant} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="fr-perfs bottom" aria-hidden="true">
          <div className="fr-perfs-rail" ref={botPerfRef} />
          {shouldRoll && <span className="fr-gate-mark" />}
          {shouldRoll && (
            <div className="fr-progress">
              <span className="fr-progress-fill" ref={progressRef} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
