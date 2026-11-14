import { getSettings } from "./settings";

/**
 * Cards catch the light where the pointer is and lean a few degrees toward it. One listener for
 * the whole app writes four CSS variables on the card under the pointer (see aurora.css); a card
 * the pointer has left gets them removed, so it settles back flat.
 */
const VARS = ["--mx", "--my", "--rx", "--ry"] as const;
const TILT_DEG = 7;

export function installPointerLight() {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let lit: HTMLElement | null = null;
  let last: PointerEvent | null = null;
  let frame = 0;

  const clear = () => {
    if (!lit) return;
    for (const v of VARS) lit.style.removeProperty(v);
    lit = null;
  };

  const apply = () => {
    frame = 0;
    const e = last;
    if (!e || e.pointerType === "touch" || getSettings().reduceMotion) return clear();
    const el = (e.target as Element | null)?.closest?.<HTMLElement>(".card .art-wrap") ?? null;
    if (el !== lit) clear();
    if (!el) return;
    lit = el;
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
  document.addEventListener("pointerleave", clear);
}
