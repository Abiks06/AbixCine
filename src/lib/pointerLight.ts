import { getSettings } from "./settings";

/**
 * Magnetic micro-pull for primary Play CTAs (.btn.play on Hero / Title Monograph and
 * the paused player's .cc-btn.main). Card 3D tilts and frosted rim tracking were retired
 * in favor of crisp projection gate corner brackets in CSS.
 */
const MAGNETS = ":is(.hero, .tp-top) .btn.play:not(:disabled), .cc-btn.main";
const MAGNET_PX = 4;

export function installPointerLight() {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let last: PointerEvent | null = null;
  let frame = 0;
  let mag: HTMLElement | null = null;
  let magRect: DOMRect | null = null;

  const invalidateRects = () => {
    magRect = null;
  };

  const unmag = () => {
    if (!mag) return;
    mag.style.removeProperty("--mag-x");
    mag.style.removeProperty("--mag-y");
    mag.classList.remove("mag");
    mag = null;
    magRect = null;
  };

  const apply = () => {
    frame = 0;
    const e = last;
    if (!e || e.pointerType === "touch" || getSettings().reduceMotion) {
      return unmag();
    }
    const target = e.target as Element | null;
    const m = target?.closest?.<HTMLElement>(MAGNETS) ?? null;
    if (m !== mag) unmag();
    if (!m) return;
    mag = m;
    magRect ??= m.getBoundingClientRect();
    const r = magRect;
    if (r.width && r.height) {
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      m.style.setProperty("--mag-x", `${(Math.max(-1, Math.min(1, dx)) * MAGNET_PX).toFixed(2)}px`);
      m.style.setProperty("--mag-y", `${(Math.max(-1, Math.min(1, dy)) * MAGNET_PX * 0.6).toFixed(2)}px`);
      m.classList.add("mag");
    }
  };

  window.addEventListener("scroll", invalidateRects, { passive: true, capture: true });
  window.addEventListener("resize", invalidateRects, { passive: true });
  document.addEventListener(
    "pointermove",
    (e) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    last = null;
    unmag();
  });
}
