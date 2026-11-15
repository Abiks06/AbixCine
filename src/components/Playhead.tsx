import { memo, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { fmtTime } from "../lib/format";

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


export const Scrubber = memo(function Scrubber({
  ph,
  dur,
  thumb,
  dragging,
  hover,
  intro,
  outro,
  scrubRef,
  partAt,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
}: {
  ph: PlayheadStore;
  dur: number;
  /** Preview frame for the hovered point (lib/trickplay), when one is ready. */
  thumb?: string | null;
  dragging: boolean;
  hover: { x: number; t: number; w: number } | null;
  intro?: [number, number];
  outro?: [number, number];
  scrubRef: RefObject<HTMLDivElement>;
  partAt: (t: number) => string | null;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerLeave: () => void;
}) {
  // Whole seconds for the slider's accessible value; the bar itself follows every update.
  const time = usePlayhead(ph, (t) => t);
  const buffered = usePlayhead(ph, (_, b) => b);
  const pct = dur ? (time / dur) * 100 : 0;
  return (
    <div
      ref={scrubRef}
      className={`scrub ${dragging ? "drag" : ""}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${fmtTime(time)} of ${fmtTime(dur)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <div className="c">
        <span className="buf" style={{ width: `${dur ? (buffered / dur) * 100 : 0}%` }} />
        {hover && <span className="ghost" style={{ width: hover.x }} />}
        <i style={{ width: `${pct}%` }} />
        {dur > 0 && intro && intro[0] < dur && (
          <span className="part" style={{ left: `${(intro[0] / dur) * 100}%`, width: `${((Math.min(dur, intro[1]) - intro[0]) / dur) * 100}%` }} />
        )}
        {dur > 0 && outro && (
          <span className="part" style={{ left: `${(outro[0] / dur) * 100}%`, width: `${((Math.min(dur, outro[1]) - outro[0]) / dur) * 100}%` }} />
        )}
      </div>
      <span className="knob" style={{ left: `${pct}%` }} />
      {hover && dur > 0 && (
        <span className={`scrub-tip ${thumb ? "has-thumb" : ""}`} style={{ left: Math.max(thumb ? 104 : 34, Math.min(hover.w - (thumb ? 104 : 34), hover.x)) }}>
          {thumb && <img className="scrub-thumb" src={thumb} alt="" />}
          <span className="scrub-tip-row">
            {partAt(hover.t) && <em>{partAt(hover.t)}</em>}
            {fmtTime(hover.t)}
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
