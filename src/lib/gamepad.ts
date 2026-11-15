/**
 * Couch control: a game controller drives the app.
 *
 *   D-pad / left stick  move focus to the nearest control in that direction (spatial navigation);
 *                       in the player, seek and change volume (its arrow-key shortcuts)
 *   A                   activate          B   close what's open (Escape), else go back
 *   Start               play / pause      LB / RB   previous / next tab or chip (Shift+Tab / Tab)
 *
 * Polling only runs while a controller is connected, so this costs nothing otherwise.
 */

type Dir = "up" | "down" | "left" | "right";

const DEADZONE = 0.5;
const REPEAT_DELAY_MS = 380;
const REPEAT_MS = 110;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="slider"], [role="tab"]';

function visible(el: HTMLElement): boolean {
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}

/** The candidates focus may move to: inside an open dialog only, else the whole page. */
function candidates(): HTMLElement[] {
  const modal = document.querySelector<HTMLElement>('[aria-modal="true"]');
  const root: ParentNode = modal ?? document;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** Nearest element in a direction: distance along it, with a penalty for drifting sideways. */
export function nearestInDirection(from: DOMRect, dir: Dir, rects: { el: HTMLElement; r: DOMRect }[]): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const { el, r } of rects) {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let along: number;
    let across: number;
    if (dir === "right") [along, across] = [r.left - from.right, dy];
    else if (dir === "left") [along, across] = [from.left - r.right, dy];
    else if (dir === "down") [along, across] = [r.top - from.bottom, dx];
    else [along, across] = [from.top - r.bottom, dx];
    // Must lie in that direction (a little overlap allowed for rows of uneven height).
    if (along < -Math.min(from.width, from.height) / 2) continue;
    const score = Math.max(0, along) + Math.abs(across) * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function moveFocus(dir: Dir) {
  const list = candidates();
  if (!list.length) return;
  const cur = document.activeElement instanceof HTMLElement && list.includes(document.activeElement) ? document.activeElement : null;
  const target = cur
    ? nearestInDirection(cur.getBoundingClientRect(), dir, list.filter((el) => el !== cur).map((el) => ({ el, r: el.getBoundingClientRect() })))
    : list[0];
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function key(k: string, opts: KeyboardEventInit = {}) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
}

/** In the player with nothing focused (or the video): the D-pad is the player's arrow keys. */
function inPlayerSurface(): boolean {
  if (!document.querySelector(".player")) return false;
  if (document.querySelector('.psheet.open, [aria-modal="true"]')) return false;
  const a = document.activeElement;
  return !a || a === document.body || a.tagName === "VIDEO";
}

export function installGamepad(): () => void {
  if (typeof window === "undefined" || typeof navigator === "undefined" || !("getGamepads" in navigator)) return () => {};
  let raf = 0;
  const held = new Map<string, number>(); // control -> next repeat time
  const pressedBefore = new Set<string>();

  const markActive = () => document.documentElement.classList.add("gamepad-active");
  const onMouse = () => document.documentElement.classList.remove("gamepad-active");
  window.addEventListener("mousemove", onMouse, { passive: true });

  const press = (id: string, now: number, repeatable: boolean, act: () => void) => {
    const first = !pressedBefore.has(id);
    pressedBefore.add(id);
    if (first) {
      held.set(id, now + REPEAT_DELAY_MS);
      markActive();
      act();
    } else if (repeatable && now >= (held.get(id) ?? Infinity)) {
      held.set(id, now + REPEAT_MS);
      act();
    }
  };

  const direction = (dir: Dir) => {
    if (inPlayerSurface()) {
      key({ up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[dir]);
      return;
    }
    moveFocus(dir);
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find((p): p is Gamepad => !!p && p.connected);
    if (!pad) return;
    const now = performance.now();
    const down = new Set<string>();
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const ax = (i: number) => pad.axes[i] ?? 0;
    const dirs: [Dir, boolean][] = [
      ["up", b(12) || ax(1) < -DEADZONE],
      ["down", b(13) || ax(1) > DEADZONE],
      ["left", b(14) || ax(0) < -DEADZONE],
      ["right", b(15) || ax(0) > DEADZONE],
    ];
    for (const [dir, on] of dirs) {
      if (!on) continue;
      down.add(dir);
      press(dir, now, true, () => direction(dir));
    }
    if (b(0)) {
      down.add("a");
      press("a", now, false, () => {
        const a = document.activeElement as HTMLElement | null;
        if (a && a !== document.body) a.click();
        else if (inPlayerSurface()) key(" ");
      });
    }
    if (b(1)) {
      down.add("b");
      press("b", now, false, () => {
        if (document.querySelector('[aria-modal="true"], .psheet.open')) key("Escape");
        else if (document.querySelector(".player")) key("Escape");
        else history.back();
      });
    }
    if (b(9)) {
      down.add("start");
      press("start", now, false, () => (document.querySelector(".player") ? key(" ") : undefined));
    }
    if (b(4)) {
      down.add("lb");
      press("lb", now, true, () => key("Tab", { shiftKey: true }));
    }
    if (b(5)) {
      down.add("rb");
      press("rb", now, true, () => key("Tab"));
    }
    for (const id of [...pressedBefore]) {
      if (!down.has(id)) {
        pressedBefore.delete(id);
        held.delete(id);
      }
    }
  };

  const start = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const stopIfNone = () => {
    const any = [...(navigator.getGamepads?.() ?? [])].some((p) => p?.connected);
    if (!any && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  window.addEventListener("gamepadconnected", start);
  window.addEventListener("gamepaddisconnected", stopIfNone);
  // Already connected before the app loaded (the event fires again on first input anyway).
  if ([...(navigator.getGamepads?.() ?? [])].some((p) => p?.connected)) start();

  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("gamepadconnected", start);
    window.removeEventListener("gamepaddisconnected", stopIfNone);
    window.removeEventListener("mousemove", onMouse);
  };
}
