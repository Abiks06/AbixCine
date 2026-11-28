import { getSettings } from "./settings";

/**
 * Magnetic micro-pull for primary Play CTAs (.btn.play on Hero / Title Monograph and
 * the paused player's .cc-btn.main) plus pointer-reactive specular catch-light (--gx/--gy)
 * on liquid-glass surfaces and frosted cards.
 */
const MAGNETS = ":is(.hero, .tp-top) .btn.play:not(:disabled), .cc-btn.main";
const GLASS =
  ".topbar-search, .topbar-theme, .topbar-dl, .search-box, .btn.glass, .btn-glass, .hero-next, .palette, .theme-popover, .dl-queue-pop, .dl-pop, .dl-modal, .qd-drawer, .person-modal, .trailer-pane, .col-pick-pop, .tp-servers-pop > .smart, .race-grid-wrap, .tp-telemetry-card, .nw-spotlight, .lp-card, .spread-lead, .reel-lead, .top-hit, .pbot, .psheet, .hover-preview";
const MAGNET_PX = 4;

export function installPointerLight() {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let last: PointerEvent | null = null;
  let frame = 0;
  let mag: HTMLElement | null = null;
  let magRect: DOMRect | null = null;
  let glass: HTMLElement | null = null;
  let glassRect: DOMRect | null = null;

  const invalidateRects = () => {
    magRect = null;
    glassRect = null;
  };

  const unmag = () => {
    if (!mag) return;
    mag.style.removeProperty("--mag-x");
    mag.style.removeProperty("--mag-y");
    mag.classList.remove("mag");
    mag = null;
    magRect = null;
  };

  const unglass = () => {
    if (!glass) return;
    glass.style.removeProperty("--gx");
    glass.style.removeProperty("--gy");
    glass.classList.remove("lit");
    glass = null;
    glassRect = null;
  };

  const apply = () => {
    frame = 0;
    const e = last;
    if (!e || e.pointerType === "touch" || getSettings().reduceMotion) {
      unmag();
      unglass();
      return;
    }
    const target = e.target as Element | null;
    if (target?.closest?.(".player.idle")) {
      unmag();
      unglass();
      return;
    }

    const m = target?.closest?.<HTMLElement>(MAGNETS) ?? null;
    if (m !== mag) unmag();
    if (m) {
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
    }

    const g = target?.closest?.<HTMLElement>(GLASS) ?? null;
    if (g !== glass) unglass();
    if (g) {
      glass = g;
      glassRect ??= g.getBoundingClientRect();
      const r = glassRect;
      if (r.width && r.height) {
        const px = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
        const py = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
        g.style.setProperty("--gx", `${px.toFixed(1)}%`);
        g.style.setProperty("--gy", `${py.toFixed(1)}%`);
        g.classList.add("lit");
      }
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
    unglass();
  });
}
