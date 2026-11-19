/**
 * Player chrome state that only touches the DOM and the window: auto-hiding controls,
 * fullscreen (the Tauri window, or the element in a browser) and picture-in-picture.
 * Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject, type RefObject } from "react";
import { isKeyboardFocused } from "../../lib/playerControls";
import { HOLD_CHROME, IDLE_MS } from "./shared";

/**
 * Auto-hide controls. They stay up while the pointer rests on them or one of them has keyboard
 * focus: nothing fades out from under a still cursor or from under the Tab key.
 */
export function useIdleChrome(wrap: RefObject<HTMLElement>, playing: boolean) {
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number>();
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const lastPokeRef = useRef(0);
  const overChromeRef = useRef(false);
  const lastPointerRef = useRef({ x: Number.NaN, y: Number.NaN });
  const poke = (force = false) => {
    const now = performance.now();
    // Skip redundant state/timer work on high-frequency pointer moves while chrome is already visible.
    if (!force && !idleRef.current && now - lastPokeRef.current < 150) return;
    lastPokeRef.current = now;
    if (idleRef.current) {
      idleRef.current = false;
      setIdle(false);
    }
    clearTimeout(idleTimer.current);
    const later = () => {
      const a = document.activeElement;
      const keyboardOnControls = !!a && !!wrap.current?.contains(a) && !!a.closest?.(HOLD_CHROME) && isKeyboardFocused(a);
      if (overChromeRef.current || keyboardOnControls) {
        idleTimer.current = window.setTimeout(later, IDLE_MS);
        return;
      }
      idleRef.current = true;
      setIdle(true);
    };
    idleTimer.current = window.setTimeout(later, IDLE_MS);
  };
  /**
   * Pointer activity over the player. Chromium also sends mousemoves without any movement (when
   * the layout changes under a still cursor, e.g. as the controls fade): those must not count, or
   * the controls could keep waking themselves up.
   */
  const onPointerActivity = (e: MouseEvent) => {
    overChromeRef.current = !!(e.target as Element | null)?.closest?.(HOLD_CHROME);
    const last = lastPointerRef.current;
    if (e.clientX === last.x && e.clientY === last.y) return;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    poke();
  };
  useEffect(() => () => clearTimeout(idleTimer.current), []);
  // Starting or resuming playback shows the controls for a moment before they fade (they used to
  // vanish the instant a slow stream finally started, if the mouse had been still meanwhile).
  useEffect(() => {
    poke(true);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  return { idle, poke, onPointerActivity, overChromeRef };
}

/**
 * Fullscreen: in the desktop app the window itself goes fullscreen (WebView2's element
 * fullscreen only fills the webview); in a browser, the player element does.
 */
export function useFullscreen(wrap: RefObject<HTMLElement>, mountedRef: MutableRefObject<boolean>) {
  const [isFull, setIsFull] = useState(false);
  const isFullRef = useRef(false);
  isFullRef.current = isFull;
  const win = useMemo(() => (isTauri() ? getCurrentWindow() : null), []);
  const setFull = async (on: boolean) => {
    try {
      if (win) {
        // Noted before the await, so a quick second press (F, then F again) toggles back instead of
        // repeating the same request off the not-yet-updated state.
        isFullRef.current = on;
        await win.setFullscreen(on);
        setIsFull(on);
      } else if (on) await wrap.current?.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      if (win) void win.isFullscreen().then((f) => mountedRef.current && setIsFull(f)).catch(() => {});
    }
  };
  const toggleFull = () => void setFull(!isFullRef.current);
  useEffect(() => {
    if (win) return;
    const f = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The player remounts on every episode; pick up the window's state so fullscreen carries over.
  // (Leaving the watch screen altogether exits fullscreen: see the app shell.)
  useEffect(() => {
    if (!win) return;
    let live = true;
    let off: (() => void) | undefined;
    const sync = () => win.isFullscreen().then((f) => live && setIsFull(f)).catch(() => {});
    void sync();
    // Fullscreen can change without us (F11, a snap layout, another screen): follow the window.
    win
      .onResized(() => void sync())
      .then((un) => (live ? (off = un) : un()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, [win]);
  return { isFull, setFull, toggleFull };
}

/** Picture-in-picture for our own <video> (never for an embed's sealed frame). */
export function usePip(video: RefObject<HTMLVideoElement>, isEmbed: boolean, flash: (msg: string) => void) {
  const [pipOn, setPipOn] = useState(false);
  const pipOk = typeof document !== "undefined" && document.pictureInPictureEnabled;
  const togglePip = async () => {
    const v = video.current;
    if (!v || isEmbed) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      flash("Picture-in-picture isn't available for this stream");
    }
  };
  // Picture-in-picture must not outlive the player that owns the video.
  useEffect(
    () => () => {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    },
    [],
  );
  // The PiP button shows whether the picture is popped out (closing the PiP window counts too).
  useEffect(() => {
    const v = video.current;
    if (!v || isEmbed) {
      setPipOn(false);
      return;
    }
    const sync = () => setPipOn(document.pictureInPictureElement === v);
    sync();
    v.addEventListener("enterpictureinpicture", sync);
    v.addEventListener("leavepictureinpicture", sync);
    return () => {
      v.removeEventListener("enterpictureinpicture", sync);
      v.removeEventListener("leavepictureinpicture", sync);
    };
  }, [isEmbed]); // eslint-disable-line react-hooks/exhaustive-deps
  return { pipOk, pipOn, togglePip };
}
