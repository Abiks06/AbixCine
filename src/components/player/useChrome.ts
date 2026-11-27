/**
 * Player chrome state that only touches the DOM and the window: auto-hiding controls,
 * fullscreen (the Tauri window, or the element in a browser) and picture-in-picture.
 * Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
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
  const seqRef = useRef(0);
  const settlingUntilRef = useRef(0);
  const settleTimerRef = useRef<number>();
  const win = useMemo(() => (isTauri() ? getCurrentWindow() : null), []);

  const commitFull = (next: boolean) => {
    isFullRef.current = next;
    if (mountedRef.current) setIsFull(next);
  };

  const readTauriFull = async (): Promise<boolean> => {
    try {
      return await invoke<boolean>("get_window_fullscreen");
    } catch {
      return win ? await win.isFullscreen() : false;
    }
  };

  const setFull = async (on: boolean) => {
    const seq = ++seqRef.current;
    settlingUntilRef.current = performance.now() + 350;
    clearTimeout(settleTimerRef.current);
    // Noted before the await, so a quick second press (F, then F again) toggles back instead of
    // repeating the same request off the not-yet-updated state.
    commitFull(on);
    try {
      if (!on && document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      if (win) {
        let actual = on;
        try {
          actual = await invoke<boolean>("set_window_fullscreen", { fullscreen: on });
        } catch {
          await win.setFullscreen(on);
          actual = await win.isFullscreen();
        }
        if (seq !== seqRef.current || !mountedRef.current) return;
        commitFull(actual || !!document.fullscreenElement);
        settlingUntilRef.current = performance.now() + 350;
        settleTimerRef.current = window.setTimeout(() => {
          if (seq !== seqRef.current || !mountedRef.current) return;
          void readTauriFull()
            .then((f) => {
              if (seq === seqRef.current && mountedRef.current) {
                commitFull(f || !!document.fullscreenElement);
              }
            })
            .catch(() => {});
        }, 380);
      } else if (on) {
        await wrap.current?.requestFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      if (seq !== seqRef.current || !mountedRef.current) return;
      if (win) {
        void readTauriFull()
          .then((f) => {
            if (seq === seqRef.current && mountedRef.current) {
              commitFull(f || !!document.fullscreenElement);
            }
          })
          .catch(() => {});
      } else {
        commitFull(!!document.fullscreenElement);
      }
    }
  };

  const toggleFull = () => void setFull(!isFullRef.current);

  useEffect(() => {
    const f = () => {
      if (document.fullscreenElement) {
        commitFull(true);
      } else if (win) {
        void readTauriFull()
          .then((full) => {
            if (mountedRef.current) commitFull(full);
          })
          .catch(() => {});
      } else {
        commitFull(false);
      }
    };
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps

  // The player remounts on every episode; pick up the window's state so fullscreen carries over.
  // (Leaving the watch screen altogether exits fullscreen: see the app shell.)
  useEffect(() => {
    if (!win) return;
    let live = true;
    let off: (() => void) | undefined;
    let resizeTimer: number | undefined;
    const sync = () => {
      if (performance.now() < settlingUntilRef.current) return;
      void readTauriFull()
        .then((f) => {
          if (live && performance.now() >= settlingUntilRef.current) {
            commitFull(f || !!document.fullscreenElement);
          }
        })
        .catch(() => {});
    };
    void readTauriFull()
      .then((f) => live && commitFull(f || !!document.fullscreenElement))
      .catch(() => {});
    // Fullscreen can change without us (F11, a snap layout, another screen): follow the window.
    win
      .onResized(() => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(sync, 80);
      })
      .then((un) => (live ? (off = un) : un()))
      .catch(() => {});
    return () => {
      live = false;
      clearTimeout(resizeTimer);
      clearTimeout(settleTimerRef.current);
      off?.();
    };
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Only leave PiP if we exited /watch completely (episode switches keep /watch mounted).
  useEffect(
    () => () => {
      if (document.pictureInPictureElement && !window.location.hash.startsWith("#/watch") && !window.location.pathname.startsWith("/watch")) {
        void document.exitPictureInPicture().catch(() => {});
      }
    },
    [],
  );
  // The PiP button shows whether the picture is popped out (closing the PiP window counts too).
  const vNow = video.current;
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
  }, [isEmbed, vNow]); // eslint-disable-line react-hooks/exhaustive-deps
  return { pipOk, pipOn, togglePip };
}
