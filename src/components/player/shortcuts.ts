/**
 * The player's keyboard shortcuts: one pure handler over a context of player actions, and a
 * hook that binds it to the window once. Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { useEffect, useRef, type RefObject } from "react";
import { EMBED_KEYS, NAV_KEYS, classifyKeyTarget, isKeyboardFocused } from "../../lib/playerControls";
import type { Sheet } from "./shared";

export interface ShortcutContext {
  video: RefObject<HTMLVideoElement>;
  sheet: Sheet | null;
  setSheet: (s: Sheet | null | ((x: Sheet | null) => Sheet | null)) => void;
  keysOpen: boolean;
  setKeysOpen: (v: boolean | ((x: boolean) => boolean)) => void;
  isEmbed: boolean;
  isFull: boolean;
  hasEpisodes: boolean;
  /** A subtitle track (primary or secondary) is on, so [ / ] nudge its timing. */
  hasSubtitle: () => boolean;
  poke: () => void;
  toggle: () => void;
  seek: (d: number) => void;
  seekTo: (t: number) => void;
  changeVol: (d: number) => void;
  toggleMute: (announce?: boolean) => void;
  changeSpeed: (dir: 1 | -1) => void;
  toggleSub: () => void;
  cycleSub: () => void;
  nudge: (d: number) => void;
  toggleFull: () => void;
  setFull: (on: boolean) => Promise<void>;
  togglePip: () => Promise<void>;
  skipActive?: () => void;
  cycleFit?: () => void;
  goNext: () => void;
  goInfo: () => void;
  leave: () => void;
}

/** Keys whose auto-repeat means "more of the same": seeks, volume, frame steps, sub timing. */
const REPEATABLE = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "j", "l", ",", ".", "[", "]", "{", "}"]);

export function handlePlayerKey(e: KeyboardEvent, ctx: ShortcutContext) {
  const el = e.target as HTMLElement | null;
  const target = classifyKeyTarget(el);
  const { sheet, setSheet } = ctx;
  // Typing belongs to the field. Escape still closes the panel the field is in, instead of
  // trapping you in the subtitle search box.
  if (target === "text") {
    if (e.key === "Escape" && sheet && el?.closest?.(".psheet")) {
      e.preventDefault();
      el.blur();
      setSheet(null);
    }
    return;
  }
  // Ctrl+K and friends belong to the app, not the player (Ctrl+K used to pause as well).
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // A modal on top (the command palette) owns the keyboard until it closes. The player's own
  // shortcuts card is handled just below (Escape / ? close it).
  if (document.querySelector('[aria-modal="true"]:not(.pkeys)')) return;
  // Letters work with Caps Lock on.
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Holding a key repeats seeks and volume steps, never a toggle: a held F used to flick in and
  // out of fullscreen, a held N skipped several episodes.
  if (e.repeat && !REPEATABLE.has(k)) {
    if (k === " " && target !== "control") e.preventDefault();
    return;
  }
  // The shortcuts card is modal too: Escape or ? closes it, and nothing else leaks through to
  // the video underneath (closing it with Space used to pause as well).
  if (ctx.keysOpen) {
    e.preventDefault();
    if (k === "Escape" || k === "?") ctx.setKeysOpen(false);
    return;
  }
  // A slider keeps its arrows (the volume slider: our handler on top doubled every step), and so
  // does the side panel, whose lists and tabs move and scroll with them.
  if (NAV_KEYS.has(k) && (target === "range" || el?.closest?.(".psheet"))) return;
  // A control reached from the keyboard keeps its own Space/Enter: Space on a focused "Next
  // server" presses that button. One that was only clicked keeps focus too; then Space is the
  // film's again (it used to toggle fullscreen again after a click on Fullscreen).
  if (target === "control" && (k === " " || k === "Enter")) {
    if (k === "Enter" || isKeyboardFocused(el)) return;
    e.preventDefault();
    el?.blur();
  }
  // A web player plays in a sealed frame: only the keys that drive our own chrome apply.
  if (ctx.isEmbed && !EMBED_KEYS.has(k)) return;
  ctx.poke();
  // Speed: Shift+comma / Shift+period by physical key, so it works on layouts where < and > live elsewhere.
  if (e.shiftKey && (e.code === "Comma" || e.code === "Period")) {
    ctx.changeSpeed(e.code === "Period" ? 1 : -1);
    return;
  }
  if (k >= "0" && k <= "9" && k.length === 1) {
    const v = ctx.video.current;
    if (v?.duration) ctx.seekTo((Number(k) / 10) * v.duration);
    return;
  }
  switch (k) {
    case " ": case "k": e.preventDefault(); ctx.toggle(); break;
    case "ArrowLeft": e.preventDefault(); ctx.seek(e.shiftKey ? -30 : -5); break;
    case "ArrowRight": e.preventDefault(); ctx.seek(e.shiftKey ? 30 : 5); break;
    case "j": ctx.seek(-10); break;
    case "l": ctx.seek(10); break;
    case "ArrowUp": e.preventDefault(); ctx.changeVol(0.1); break;
    case "ArrowDown": e.preventDefault(); ctx.changeVol(-0.1); break;
    case "m": ctx.toggleMute(true); break;
    case "c":
      if (e.shiftKey) ctx.cycleSub();
      else ctx.toggleSub();
      break;
    case "s": setSheet((x) => (x === "servers" ? null : "servers")); break;
    case "e": if (ctx.hasEpisodes) setSheet((x) => (x === "episodes" ? null : "episodes")); break;
    case "[": case "{":
      if (ctx.hasSubtitle()) ctx.nudge(e.shiftKey || k === "{" ? -0.1 : -0.5);
      break;
    case "]": case "}":
      if (ctx.hasSubtitle()) ctx.nudge(e.shiftKey || k === "}" ? 0.1 : 0.5);
      break;
    case "<": ctx.changeSpeed(-1); break;
    case ">": ctx.changeSpeed(1); break;
    case ",": case ".": {
      // Frame step, the way editors do it: only while paused.
      const v = ctx.video.current;
      if (v && v.paused && !ctx.isEmbed) ctx.seekTo(v.currentTime + (k === "." ? 1 : -1) / 24);
      break;
    }
    case "f": ctx.toggleFull(); break;
    // The Windows fullscreen key, for people who reach for it out of habit.
    case "F11": e.preventDefault(); ctx.toggleFull(); break;
    case "p": void ctx.togglePip(); break;
    case "x": ctx.skipActive?.(); break;
    case "z": ctx.cycleFit?.(); break;
    case "n": ctx.goNext(); break;
    case "i": ctx.goInfo(); break;
    case "?": ctx.setKeysOpen((x) => !x); break;
    case "Escape":
      if (sheet) setSheet(null);
      else if (ctx.isFull) void ctx.setFull(false);
      else ctx.leave();
      break;
  }
}

/** Bound once via a ref, so playhead ticks don't re-bind the window listener. */
export function usePlayerShortcuts(ctx: ShortcutContext) {
  const ref = useRef(ctx);
  ref.current = ctx;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handlePlayerKey(e, ref.current);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
