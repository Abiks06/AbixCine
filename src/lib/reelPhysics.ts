export const BASE_REEL_SPEED = 38;
export const SPROCKET_PITCH = 36;
export const DRAG_THRESHOLD = 6;

const TILT_DEADZONE = 85;
const TILT_MAX = 1.35;

/** Clamp a finite number between `min` and `max`. */
export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

/**
 * Wrap `pos` cleanly into `[0, span)` for both forward and reverse scrubbing.
 * Returns `0` when `span` or `pos` is invalid or non-positive.
 */
export function wrapOffset(pos: number, span: number): number {
  if (!Number.isFinite(pos) || !Number.isFinite(span) || span <= 0) return 0;
  const wrapped = ((pos % span) + span) % span;
  return wrapped >= span || Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Classify whether a wheel/trackpad event represents intentional horizontal
 * reel scrubbing (`delta !== 0`) or normal vertical page scrolling (`delta === 0`).
 */
export function classifyWheelGesture(
  deltaX: number,
  deltaY: number,
  shiftKey: boolean,
  deltaMode = 0,
  pageWidth = 800,
): { delta: number; discrete: boolean } {
  const mult = deltaMode === 1 ? 28 : deltaMode === 2 ? pageWidth * 0.8 : 1;
  const dx = Number.isFinite(deltaX) ? deltaX * mult : 0;
  const dy = Number.isFinite(deltaY) ? deltaY * mult : 0;

  if (shiftKey && Math.abs(dy) > 0 && Math.abs(dx) < Math.abs(dy)) {
    return { delta: dy, discrete: true };
  }

  if (Math.abs(dx) > 0.5 && Math.abs(dx) >= Math.abs(dy) * 0.65) {
    return { delta: dx, discrete: deltaMode !== 0 || Math.abs(dx) >= 48 };
  }

  return { delta: 0, discrete: false };
}

/**
 * Advance the flywheel reel physics by `dt` seconds with smooth exponential
 * acceleration/deceleration or weighted inertial coasting.
 */
export function stepReelPhysics(
  state: { pos: number; vel: number },
  opts: {
    span: number;
    targetVel: number;
    dt: number;
    coasting: boolean;
    dragging: boolean;
  },
): { pos: number; vel: number } {
  const dt = clamp(opts.dt, 0, 0.05);
  if (opts.dragging || !Number.isFinite(opts.span) || opts.span <= 0) {
    return {
      pos: wrapOffset(state.pos, opts.span),
      vel: state.vel,
    };
  }

  let vel = Number.isFinite(state.vel) ? state.vel : 0;
  if (opts.coasting) {
    vel *= Math.exp(-dt * 4.2);
    if (opts.targetVel === 0 && Math.abs(vel) < 1.5) {
      vel = 0;
    }
  } else {
    const ease = 1 - Math.exp(-dt * 7.5);
    vel += (opts.targetVel - vel) * ease;
    if (Math.abs(vel - opts.targetVel) < 0.35) {
      vel = opts.targetVel;
    }
  }

  const pos = wrapOffset(state.pos + vel * dt, opts.span);
  return { pos, vel };
}

/**
 * Compute subtle celluloid micro-skew (`±1.35deg`) during fast flicks/glides,
 * remaining strictly flat (`0`) during normal cruising speeds.
 */
export function velocityTiltDeg(vel: number): number {
  if (!Number.isFinite(vel)) return 0;
  const abs = Math.abs(vel);
  if (abs <= TILT_DEADZONE) return 0;
  const raw = -Math.sign(vel) * ((abs - TILT_DEADZONE) / 1400) * TILT_MAX;
  return clamp(raw, -TILT_MAX, TILT_MAX);
}

/**
 * Map reel strip offset (px) proportionally to a 35mm spool gear rotation angle.
 */
export function spoolAngleDeg(pos: number): number {
  return wrapOffset(pos * 0.48, 360);
}
