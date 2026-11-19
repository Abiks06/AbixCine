import { getSettings } from "./settings";

/**
 * Cards catch the light where the pointer is and lean a few degrees toward it. One listener for
 * the whole app writes four CSS variables on the card under the pointer (see styles/browse.css); a card
 * the pointer has left gets them removed, so it settles back flat.
 *
 * Panes of glass catch it too: the pane under the pointer gets its position in pixels (--gx, --gy)
 * and a `glow` class, which styles/frost.css turns into a highlight that travels along the rim.
 * Those two properties are registered as non-inheriting, so moving the pointer restyles the pane
 * and its rim, never the content inside it.
 */
const VARS = ["--mx", "--my", "--rx", "--ry"] as const;
const TILT_DEG = 7;
// Keep in step with the glow selectors in styles/frost.css. A menu is its own pane: the pointer on
// the account menu must not light the tools capsule the menu happens to hang from.
const PANES =
  ".panel, .smart, .auth-card, .hero-queue, .file, .notice, .facts, .update-toast, .top-hit, .dock, .tools, .menu, .palette, .psheet, .race-grid-wrap, .pbot, .ptop-actions";
// On the watch page the glass lights only where someone is actually using it: the source race,
// an open side sheet, the palette, and the HUD while paused. Over playing video nothing is written.
const WATCH_PANES = ".race-grid-wrap, .psheet.open, .palette, .player.is-paused :is(.pbot, .ptop-actions)";

// The big "play" calls to action lean a few pixels toward the pointer while it is over them.
const MAGNETS = ":is(.hero, .tp-top) .btn.play:not(:disabled), .cc-btn.main";
const MAGNET_PX = 4;

export function installPointerLight() {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let lit: HTMLElement | null = null;
  let litRect: DOMRect | null = null;
  let pane: HTMLElement | null = null;
  let paneRect: DOMRect | null = null;
  let appEl: Element | null = document.querySelector(".app");
  let last: PointerEvent | null = null;
  let frame = 0;

  let mag: HTMLElement | null = null;
  let magRect: DOMRect | null = null;

  const invalidateRects = () => {
    litRect = null;
    paneRect = null;
    magRect = null;
  };
  // Released: the variables go, and the spring in base.css brings the button home.
  const unmag = () => {
    if (!mag) return;
    mag.style.removeProperty("--mag-x");
    mag.style.removeProperty("--mag-y");
    mag.classList.remove("mag");
    mag = null;
    magRect = null;
  };

  const clear = () => {
    if (!lit) return;
    for (const v of VARS) lit.style.removeProperty(v);
    lit.classList.remove("lit");
    lit = null;
    litRect = null;
  };
  // The position stays where it was, so the highlight fades out in place instead of jumping away.
  const dim = () => {
    pane?.classList.remove("glow");
    pane = null;
    paneRect = null;
  };

  const apply = () => {
    frame = 0;
    const e = last;
    if (!appEl || !appEl.isConnected) appEl = document.querySelector(".app");
    if (!e || e.pointerType === "touch" || getSettings().reduceMotion) {
      dim();
      unmag();
      return clear();
    }
    const target = e.target as Element | null;

    const m = target?.closest?.<HTMLElement>(MAGNETS) ?? null;
    if (m !== mag) unmag();
    if (m) {
      mag = m;
      // Measured once per hover, from where it sits at rest (the lean itself mustn't feed back).
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
    const watching = !!appEl?.classList.contains("is-watching");

    const hit = target?.closest?.<HTMLElement>(PANES) ?? null;
    const glass = !hit || hit.classList.contains("menu") || (watching && !hit.matches(WATCH_PANES)) ? null : hit;
    if (glass !== pane) dim();
    if (glass) {
      pane = glass;
      paneRect ??= glass.getBoundingClientRect();
      glass.style.setProperty("--gx", `${Math.round(e.clientX - paneRect.left)}px`);
      glass.style.setProperty("--gy", `${Math.round(e.clientY - paneRect.top)}px`);
      glass.classList.add("glow");
    }

    const el = target?.closest?.<HTMLElement>(".card .art-wrap") ?? null;
    if (el !== lit) clear();
    if (!el) return;
    lit = el;
    // Track the pointer 1:1 while it steers the tilt; the spring only plays on release (styles/browse.css).
    el.classList.add("lit");
    litRect ??= el.getBoundingClientRect();
    const r = litRect;
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.style.setProperty("--rx", `${((x - 0.5) * TILT_DEG).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${((0.5 - y) * TILT_DEG).toFixed(2)}deg`);
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
  // pointerleave doesn't bubble: it has to be heard on the root element to catch the pointer
  // leaving the window, or the last card and pane would stay lit.
  document.documentElement.addEventListener("pointerleave", () => {
    last = null;
    dim();
    unmag();
    clear();
  });
}
