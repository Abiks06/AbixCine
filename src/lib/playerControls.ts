/**
 * Small, pure decisions the player makes on every key press, wheel tick and pointer move.
 * Kept out of components/Player.tsx so they can be tested on their own.
 */

/** What a key press landed on, as far as the player's shortcuts are concerned. */
export type KeyTarget = "text" | "range" | "control" | "other";

/** Inputs that take no typing: shortcuts still belong to the player while one of these has focus. */
const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);

const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="tab"], [role="slider"], [role="radio"], [role="option"], [role="checkbox"], [role="switch"]';

/**
 * - `text`: typing goes there (text fields, textareas, selects, contenteditable): hands off.
 * - `range`: a slider (the volume slider): it keeps its own arrow keys, everything else is ours.
 * - `control`: a button or tab: keeps Space and Enter when it was reached by keyboard.
 */
export function classifyKeyTarget(el: Element | null | undefined): KeyTarget {
  if (!el || typeof (el as Element).tagName !== "string") return "other";
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return "text";
  if ((el as HTMLElement).isContentEditable) return "text";
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (type === "range") return "range";
    return NON_TEXT_INPUTS.has(type) ? "control" : "text";
  }
  if (typeof el.closest === "function" && el.closest(CONTROL_SELECTOR)) return "control";
  return "other";
}

/** Keys a focused list, slider or scrolling panel uses to move around. */
export const NAV_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/**
 * Was this element focused from the keyboard (or a controller)? A button clicked with the mouse
 * keeps focus too, and then Space must still pause the film rather than press that button again.
 */
export function isKeyboardFocused(el: Element | null | undefined): boolean {
  if (!el || typeof (el as Element).matches !== "function") return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Shortcuts that still mean something on a web player (an embed): its picture and sound live in
 * a sealed frame, so seeking, volume, subtitle and speed keys would only show toasts that lie.
 */
export const EMBED_KEYS: ReadonlySet<string> = new Set(["s", "e", "n", "i", "f", "F11", "Escape"]);

/** One step slower or faster through the speed list (an unknown speed starts from 1×). */
export function nextSpeed(speeds: readonly number[], current: number, dir: 1 | -1): number {
  if (!speeds.length) return current;
  const i = speeds.indexOf(current);
  const from = i >= 0 ? i : Math.max(0, speeds.indexOf(1));
  return speeds[Math.max(0, Math.min(speeds.length - 1, from + dir))];
}

/**
 * Mouse wheels send one big notch, trackpads a stream of small deltas. Accumulate pixels and turn
 * every `stepPx` into one volume step; a pause longer than `resetMs` starts a fresh gesture.
 * Line-mode wheels (deltaMode 1) are one step per event. Returns the steps up (+) or down (-).
 */
export interface WheelState {
  acc: number;
  at: number;
}
export function wheelVolumeSteps(state: WheelState, deltaY: number, deltaMode: number, now: number, stepPx = 60, resetMs = 250): number {
  if (!deltaY) return 0;
  if (deltaMode === 1) {
    state.acc = 0;
    state.at = now;
    return deltaY < 0 ? 1 : -1;
  }
  if (now - state.at > resetMs) state.acc = 0;
  state.at = now;
  state.acc += deltaY;
  if (Math.abs(state.acc) < stepPx) return 0;
  const steps = Math.trunc(state.acc / stepPx);
  state.acc -= steps * stepPx;
  return -steps;
}

/** Where on the seek bar a pointer is: pixels from its left edge, the time there, the bar's width. */
export function scrubPoint(clientX: number, rect: { left: number; width: number } | null | undefined, dur: number): { x: number; t: number; w: number } {
  if (!rect || !(rect.width > 0) || !Number.isFinite(clientX)) return { x: 0, t: 0, w: 0 };
  const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return { x: f * rect.width, t: Number.isFinite(dur) && dur > 0 ? f * dur : 0, w: rect.width };
}

/** Left edge (px) for a tooltip of `half` half-width centred on `x`, kept inside a bar of width `w`. */
export function clampTip(x: number, w: number, half: number): number {
  if (w <= half * 2) return w / 2;
  return Math.max(half, Math.min(w - half, x));
}

/**
 * The loading indicator only means something while someone is waiting for the picture: while
 * connecting, or while a playing stream rebuffers. A paused video that is still filling its buffer
 * shows its paused state (and the big play button) instead of a spinner that never seems to end.
 */
export function showsSpinner(s: {
  waiting: boolean;
  failed: boolean;
  isEmbed: boolean;
  hasStarted: boolean;
  playing: boolean;
  preparing: boolean;
}): boolean {
  if (!s.waiting || s.failed) return false;
  return s.isEmbed || s.preparing || !s.hasStarted || s.playing;
}

/** The words under the spinner. */
export function loadingStage(s: {
  recovering: boolean;
  preparingTorrent: boolean;
  preparingLocal: boolean;
  localPreparePct?: number | null;
  hasStarted: boolean;
  server?: string;
}): string {
  if (s.recovering) return "Finding another server";
  if (s.preparingTorrent) return "Starting torrent stream";
  if (s.preparingLocal) {
    if (s.localPreparePct != null && Number.isFinite(s.localPreparePct) && s.localPreparePct > 0) {
      return `Optimizing audio track (${Math.round(s.localPreparePct)}%)`;
    }
    return "Preparing the audio track";
  }
  if (s.hasStarted) return "Buffering";
  return `Connecting to ${s.server || "server"}`;
}

/** Seconds before the end at which the Up next card appears. */
export const UP_NEXT_AT = 25;

/**
 * Up next shows in the last stretch of a long-enough video, and stays once it has ended (with
 * autoplay off, the end is exactly when the viewer wants the button). "Keep watching" hides it.
 */
export function upNextVisible(s: { hasNext: boolean; dismissed: boolean; remaining: number; duration: number; ended: boolean }): boolean {
  if (!s.hasNext || s.dismissed || !(s.duration > 120)) return false;
  if (s.ended) return true;
  return s.remaining <= UP_NEXT_AT && s.remaining > 0.5;
}

/** Inside the Up next stretch (or at the end): leaving it again re-arms a dismissed card. */
export function inUpNextWindow(remaining: number, ended: boolean): boolean {
  return ended || (remaining <= UP_NEXT_AT && remaining > 0.5);
}

/* --------------------------------------------------- per-session preferences */

/**
 * Mute follows you from one episode to the next (the player is rebuilt for each), but not into
 * the next launch of the app, which always starts with sound.
 */
const MUTE_KEY = "abx.muted.session";

export function loadSessionMute(): boolean {
  try {
    return sessionStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSessionMute(muted: boolean): void {
  try {
    if (muted) sessionStorage.setItem(MUTE_KEY, "1");
    else sessionStorage.removeItem(MUTE_KEY);
  } catch {
    /* storage blocked */
  }
}

/** Short, human reason for a failed stream (the raw one stays available as detail). */
export function friendlyFailure(why: string): string {
  const w = why.toLowerCase();
  if (/\b(401|403|410)\b|forbidden|expired|token/.test(w)) return "The server refused the stream (its link may have expired).";
  if (/\b404\b|not found|no stream/.test(w)) return "The server no longer has this stream.";
  if (/stall|didn't start|timeout|timed out/.test(w)) return "The stream stopped sending video.";
  if (/unsupported|codec|decode|media_err|mediaerror|bufferappend|fragparsing/.test(w)) return "This stream's format can't be played here.";
  if (/network|manifest|levelload|fragload|unreachable|failed to fetch/.test(w)) return "The server couldn't be reached.";
  return "The stream wouldn't play.";
}
