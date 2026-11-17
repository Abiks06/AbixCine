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
const PANES = ".panel, .smart, .auth-card, .hero-queue, .file, .notice, .facts, .update-toast, .top-hit, .dock, .tools, .menu";

export function installPointerLight() {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let lit: HTMLElement | null = null;
  let pane: HTMLElement | null = null;
  let last: PointerEvent | null = null;
  let frame = 0;

  const clear = () => {
    if (!lit) return;
    for (const v of VARS) lit.style.removeProperty(v);
    lit.classList.remove("lit");
    lit = null;
  };
  // The position stays where it was, so the highlight fades out in place instead of jumping away.
  const dim = () => {
    pane?.classList.remove("glow");
    pane = null;
  };

  const apply = () => {
    frame = 0;
    const e = last;
    if (!e || e.pointerType === "touch" || getSettings().reduceMotion) {
      dim();
      return clear();
    }
    const target = e.target as Element | null;

    const hit = target?.closest?.<HTMLElement>(PANES) ?? null;
    const glass = hit?.classList.contains("menu") ? null : hit;
    if (glass !== pane) dim();
    if (glass) {
      pane = glass;
      const g = glass.getBoundingClientRect();
      glass.style.setProperty("--gx", `${Math.round(e.clientX - g.left)}px`);
      glass.style.setProperty("--gy", `${Math.round(e.clientY - g.top)}px`);
      glass.classList.add("glow");
    }

    const el = target?.closest?.<HTMLElement>(".card .art-wrap") ?? null;
    if (el !== lit) clear();
    if (!el) return;
    lit = el;
    // Track the pointer 1:1 while it steers the tilt; the spring only plays on release (styles/browse.css).
    el.classList.add("lit");
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.style.setProperty("--rx", `${((x - 0.5) * TILT_DEG).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${((0.5 - y) * TILT_DEG).toFixed(2)}deg`);
  };

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
    clear();
  });
}
