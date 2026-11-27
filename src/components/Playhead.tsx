import { memo, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { fmtTime } from "../lib/format";
import { clampTip } from "../lib/playerControls";

/**
 * The playhead (current time and buffered end) lives outside React state. `timeupdate` fires
 * about four times a second; as Player state it re-rendered the whole player each time. Now only
 * the scrubber and the time readout follow it, and the player itself subscribes to derived
 * values (inside the intro? how long until the end?) that change rarely.
 */
export interface PlayheadStore {
  get(): number;
  getBuffered(): number;
  set(t: number): void;
  setBuffered(b: number): void;
  subscribe(cb: () => void): () => void;
}

export function createPlayhead(): PlayheadStore {
  let time = 0;
  let buffered = 0;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  return {
    get: () => time,
    getBuffered: () => buffered,
    set(t) {
      if (!Number.isFinite(t) || t === time) return;
      time = t;
      emit();
    },
    setBuffered(b) {
      if (!Number.isFinite(b) || b === buffered) return;
      buffered = b;
      emit();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/**
 * Subscribe to a value derived from the playhead. The component re-renders only when the
 * selector's result changes, so select a primitive (a boolean, a rounded number).
 */
export function usePlayhead<T extends string | number | boolean | null>(ph: PlayheadStore, select: (time: number, buffered: number) => T): T {
  return useSyncExternalStore(ph.subscribe, () => select(ph.get(), ph.getBuffered()));
}


/** Where the pointer is on the seek bar: pixels from the bar's left edge, the time there, the bar's width. */
export interface HoverPoint {
  x: number;
  t: number;
  w: number;
}

/**
 * The seek-bar hover point, also outside React state: pointer moves arrive at the display's rate,
 * and as Player state each one re-rendered the whole player. Only the scrubber follows it.
 */
export interface HoverStore {
  get(): HoverPoint | null;
  set(p: HoverPoint | null): void;
  subscribe(cb: () => void): () => void;
}

export function createHoverStore(): HoverStore {
  let point: HoverPoint | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => point,
    set(p) {
      if (p === point || (p && point && p.x === point.x && p.t === point.t && p.w === point.w)) return;
      point = p;
      subs.forEach((f) => f());
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** Subscribe to a value derived from the hover point (a primitive, so renders stay rare). */
export function useHover<T extends string | number | boolean | null>(hs: HoverStore, select: (p: HoverPoint | null) => T): T {
  return useSyncExternalStore(hs.subscribe, () => select(hs.get()));
}

export const Scrubber = memo(function Scrubber({
  ph,
  dur,
  thumb,
  dragging,
  hoverStore,
  intro,
  outro,
  scrubRef,
  partAt,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onSeekTo,
}: {
  ph: PlayheadStore;
  dur: number;
  /** Preview frame for the hovered point (lib/trickplay), when one is ready. */
  thumb?: string | null;
  dragging: boolean;
  hoverStore: HoverStore;
  intro?: [number, number];
  outro?: [number, number];
  scrubRef: RefObject<HTMLDivElement>;
  partAt: (t: number) => string | null;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  /** The drag ended without a release (capture lost: Alt+Tab, a system dialog, a cancelled touch). */
  onPointerCancel: (e: ReactPointerEvent) => void;
  onPointerLeave: () => void;
  onSeekTo?: (t: number) => void;
}) {
  // Whole seconds for the slider's accessible value; the bar itself follows every update.
  const time = usePlayhead(ph, (t) => t);
  const buffered = usePlayhead(ph, (_, b) => b);
  const hover = useSyncExternalStore(hoverStore.subscribe, hoverStore.get);
  const ratio = dur > 0 ? Math.max(0, Math.min(1, time / dur)) : 0;
  const bufRatio = dur > 0 ? Math.max(0, Math.min(1, buffered / dur)) : 0;
  const hoverRatio = hover && hover.w > 0 ? Math.max(0, Math.min(1, hover.x / hover.w)) : 0;
  const pct = ratio * 100;
  const part = hover && dur > 0 ? partAt(hover.t) : null;
  const tipHalf = thumb ? 101 : 34;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onSeekTo || dur <= 0) return;
    const step = e.shiftKey ? 30 : 5;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, time - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(dur, time + step);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = dur;
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    onSeekTo(next);
  };

  return (
    <div
      ref={scrubRef}
      className={`scrub ${dragging ? "drag" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${fmtTime(time)} of ${fmtTime(dur)}`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <div className="c">
        <span className="buf" style={{ transform: `scaleX(${bufRatio})` }} />
        {hover && <span className="ghost" style={{ transform: `scaleX(${hoverRatio})` }} />}
        <i style={{ transform: `scaleX(${ratio})` }} />
        {dur > 0 && intro && intro[0] < dur && (
          <span className="part" style={{ left: `${(intro[0] / dur) * 100}%`, width: `${((Math.min(dur, intro[1]) - intro[0]) / dur) * 100}%` }} />
        )}
        {dur > 0 && outro && outro[0] < dur && (
          <span className="part" style={{ left: `${(outro[0] / dur) * 100}%`, width: `${((Math.min(dur, outro[1]) - outro[0]) / dur) * 100}%` }} />
        )}
      </div>
      <span className="knob" style={{ left: `${pct}%` }} />
      {hover && dur > 0 && (
        // Positioned with a transform (no layout per pointer move), centred and kept inside the bar.
        <span className={`scrub-tip ${thumb ? "has-thumb" : ""}`} style={{ transform: `translateX(${clampTip(hover.x, hover.w, tipHalf)}px) translateX(-50%)` }}>
          {thumb && <img className="scrub-thumb" src={thumb} alt="" draggable={false} />}
          <span className="scrub-tip-row">
            {part && <em>{part}</em>}
            <b>{fmtTime(hover.t)}</b>
          </span>
        </span>
      )}
    </div>
  );
});

export const TimeReadout = memo(function TimeReadout({
  ph,
  dur,
  timeLeft,
  onToggle,
}: {
  ph: PlayheadStore;
  dur: number;
  timeLeft: boolean;
  onToggle: () => void;
}) {
  // Re-renders once a second at most: the readout only shows whole seconds.
  const sec = usePlayhead(ph, (t) => Math.floor(t));
  return (
    <button className="time" title={timeLeft ? "Show total length" : "Show time left"} onClick={onToggle}>
      {fmtTime(sec)}
      <em> / {timeLeft ? `-${fmtTime(Math.max(0, dur - sec))}` : fmtTime(dur)}</em>
    </button>
  );
});
