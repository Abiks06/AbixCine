import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard Tab navigation inside an open modal, locks background page scroll,
 * moves initial focus into the container, and restores opener focus on close.
 */
export function useModalFocusTrap(active: boolean, containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const opener = document.activeElement as HTMLElement | null;
    const scroller = document.querySelector<HTMLElement>(".main") ?? document.body;
    const prevOverflow = scroller.style.overflow;
    const prevPad = scroller.style.paddingRight;
    const gap = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
    scroller.style.overflow = "hidden";
    if (gap > 0) scroller.style.paddingRight = `${gap}px`;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    const first = focusables()[0] ?? container;
    first.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const current = document.activeElement;
      if (!container.contains(current)) {
        e.preventDefault();
        head.focus();
      } else if (e.shiftKey && current === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && current === tail) {
        e.preventDefault();
        head.focus();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !container.contains(e.target)) {
        (focusables()[0] ?? container).focus({ preventScroll: true });
      }
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      scroller.style.overflow = prevOverflow;
      scroller.style.paddingRight = prevPad;
      opener?.focus?.({ preventScroll: true });
    };
  }, [active, containerRef]);
}
