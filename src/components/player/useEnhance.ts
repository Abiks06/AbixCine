/**
 * Anime4K picture enhancement (lib/enhance) for the player: the chosen mode, the running
 * enhancer's lifecycle and stats, the before/after compare line, and the CSS "vivid" lift
 * used for embeds (whose pixels are cross-origin). Split out of Player.tsx (PERF-06).
 */
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { ENHANCE_MODES, startEnhancer, type EnhanceMode, type Enhancer, type EnhancerStats } from "../../lib/enhance";
import { ENHANCE_KEY, loadEnhance } from "./shared";

export type EnhanceState = "idle" | "starting" | "on" | "error";

export function useEnhance(opts: {
  video: RefObject<HTMLVideoElement>;
  canvas: RefObject<HTMLCanvasElement>;
  /** The stream on screen: a new one restarts the enhancer. */
  sourceUrl: string | undefined;
  isEmbed: boolean;
  /** A local file is being converted: nothing to enhance yet. */
  preparingLocal: boolean;
  flash: (msg: string) => void;
}) {
  const { video, canvas, sourceUrl, isEmbed, preparingLocal } = opts;
  const flashRef = useRef(opts.flash);
  flashRef.current = opts.flash;

  const [enhance, setEnhance] = useState<EnhanceMode>(loadEnhance);
  const [enhancing, setEnhancing] = useState<EnhanceState>("idle");
  /**
   * Before/after: the upscaled canvas sits exactly over the video, so clipping it shows the original
   * on the left of the line and Anime4K on the right, live, at no GPU cost. null = off.
   */
  const [compareAt, setCompareAt] = useState<number | null>(null);
  const comparing = compareAt != null && enhancing === "on";
  const onCompareDrag = (e: PointerEvent<HTMLDivElement>) => {
    const box = canvas.current?.parentElement?.getBoundingClientRect();
    if (!box || !box.width) return;
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setCompareAt(Math.max(2, Math.min(98, ((e.clientX - box.left) / box.width) * 100)));
  };
  const [enhError, setEnhError] = useState<string | null>(null);
  const [enhStats, setEnhStats] = useState<EnhancerStats | null>(null);
  /** Embeds get a CSS colour/contrast lift instead: their pixels are cross-origin. */
  const [vivid, setVivid] = useState(() => {
    try {
      return localStorage.getItem("abx.vivid") === "1";
    } catch {
      return false;
    }
  });
  const pickEnhance = (m: EnhanceMode) => {
    setEnhError(null);
    setEnhance(m);
    try { localStorage.setItem(ENHANCE_KEY, m); } catch { /* ignore */ }
  };
  useEffect(() => {
    try { localStorage.setItem("abx.vivid", vivid ? "1" : "0"); } catch { /* ignore */ }
  }, [vivid]);

  useEffect(() => {
    const v = video.current, c = canvas.current;
    if (enhance === "off" || isEmbed || preparingLocal || !v || !c) {
      setEnhancing("idle");
      setEnhError(null);
      setEnhStats(null);
      return;
    }
    const flash = (msg: string) => flashRef.current(msg);
    const ac = new AbortController();
    let stopped = false;
    let eng: Enhancer | null = null;
    setEnhancing("starting");
    setEnhError(null);
    startEnhancer(v, c, enhance, {
      signal: ac.signal,
      // The governor stepped down because the GPU couldn't keep up: say so, and stop if it reached "off".
      onDowngrade: (to, why) => {
        if (stopped) return;
        if (to === "off") {
          eng?.stop();
          eng = null;
          setEnhancing("error");
          setEnhError("GPU couldn't keep up at this resolution — switched to native video");
          setEnhStats(null);
          flash("Enhancement turned off: this GPU can't keep up at this size");
          return;
        }
        flash(`Enhancement eased to ${ENHANCE_MODES.find((m) => m.id === to)?.name} (${why})`);
      },
      // Hardware context loss, uncaptured shader error, or CORS taint: fall back to native <video>.
      onFallback: (why) => {
        if (stopped) return;
        eng?.stop();
        eng = null;
        setEnhancing("error");
        setEnhError(why);
        setEnhStats(null);
        flash(why);
      },
    })
      .then((e) => {
        if (stopped || ac.signal.aborted) return e.stop();
        eng = e;
        setEnhancing("on");
        setEnhStats(e.stats());
      })
      .catch((err) => {
        if (stopped || ac.signal.aborted) return;
        const msg = err?.message ?? String(err);
        setEnhancing("error");
        setEnhError(msg);
        setEnhStats(null);
        flash(`Enhancement fallback (native video): ${msg}`);
      });
    // Live stats for the Picture panel (GPU time per frame, chain, skipped frames).
    const statTimer = window.setInterval(() => eng && setEnhStats(eng.stats()), 1000);
    return () => {
      stopped = true;
      ac.abort();
      clearInterval(statTimer);
      eng?.stop();
      setEnhStats(null);
    };
  }, [enhance, sourceUrl, isEmbed, preparingLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  return { enhance, pickEnhance, enhancing, enhError, enhStats, compareAt, setCompareAt, comparing, onCompareDrag, vivid, setVivid };
}
