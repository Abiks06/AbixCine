import { useCallback, useRef } from "react";

/**
 * A selector that glides between its options instead of snapping. Put the returned ref on the
 * group; it measures the selected child (`.on` by default) and writes --ind-x / --ind-y / --ind-w /
 * --ind-h on the group, and styles/frost.css draws the pill (or underline) on the group's ::before.
 *
 * It watches the group itself, so call sites don't pass dependencies: a class change, a re-render
 * that swaps the children, or a resize all re-measure on the next frame. Offsets are layout
 * offsets, not client rects, so a group inside a scaling pop-in (the palette) measures true.
 *
 * Until the first measurement lands the selected child keeps its own fill, and the first placement
 * doesn't animate (data-ind="" then "live" a frame later), so nothing ever slides in from 0,0.
 */
export function useSlidingIndicator<T extends HTMLElement = HTMLDivElement>(selector = ":scope > .on") {
  const stop = useRef<(() => void) | null>(null);
  return useCallback(
    (el: T | null) => {
      stop.current?.();
      stop.current = el ? attachIndicator(el, selector) : null;
    },
    [selector],
  );
}

/**
 * The same, for every group matching `groups` inside a root (a page, a sheet) that has several of
 * them, mounting and unmounting as it goes. Put the returned ref on the root.
 */
export function useSlidingIndicators<T extends HTMLElement = HTMLDivElement>(groups: string, selector = ":scope > .on") {
  const stop = useRef<(() => void) | null>(null);
  return useCallback(
    (root: T | null) => {
      stop.current?.();
      stop.current = null;
      if (!root) return;
      const live = new Map<HTMLElement, () => void>();
      let frame = 0;
      const scan = () => {
        frame = 0;
        for (const [el, off] of live) if (!el.isConnected || !root.contains(el)) (off(), live.delete(el));
        root.querySelectorAll<HTMLElement>(groups).forEach((el) => {
          if (!live.has(el)) live.set(el, attachIndicator(el, selector));
        });
      };
      // Only elements arriving or leaving matter here; each group watches its own selection.
      const mo = new MutationObserver(() => {
        if (!frame) frame = requestAnimationFrame(scan);
      });
      mo.observe(root, { subtree: true, childList: true });
      scan();
      stop.current = () => {
        cancelAnimationFrame(frame);
        mo.disconnect();
        live.forEach((off) => off());
        live.clear();
      };
    },
    [groups, selector],
  );
}

export function attachIndicator(el: HTMLElement, selector: string): () => void {
  let frame = 0;
  let last = "";
  let live = 0;

  const place = () => {
    frame = 0;
    const on = el.querySelector<HTMLElement>(selector);
    let x = 0;
    let y = 0;
    let n: HTMLElement | null = on;
    while (n && n !== el) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    // Nothing selected, hidden, or not laid out inside the group: hand the fill back to the child.
    if (!on || n !== el || !on.offsetWidth) {
      if (el.hasAttribute("data-ind")) el.removeAttribute("data-ind");
      last = "";
      return;
    }
    ro.observe(on);
    const key = `${x}|${y}|${on.offsetWidth}|${on.offsetHeight}`;
    if (key === last) return;
    last = key;
    el.style.setProperty("--ind-x", `${x}px`);
    el.style.setProperty("--ind-y", `${y}px`);
    el.style.setProperty("--ind-w", `${on.offsetWidth}px`);
    el.style.setProperty("--ind-h", `${on.offsetHeight}px`);
    if (!el.hasAttribute("data-ind")) {
      el.setAttribute("data-ind", "");
      cancelAnimationFrame(live);
      live = requestAnimationFrame(() => el.hasAttribute("data-ind") && el.setAttribute("data-ind", "live"));
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };

  const ro = new ResizeObserver(schedule);
  ro.observe(el);
  const mo = new MutationObserver(schedule);
  mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  schedule();

  return () => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(live);
    ro.disconnect();
    mo.disconnect();
  };
}
