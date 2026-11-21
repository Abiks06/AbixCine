import { useSyncExternalStore } from "react";
import { getDetail, peekDetail } from "./catalog";
import type { Media, MediaDetail } from "./types";

export interface PreviewAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HoverPreviewPosition {
  left: number;
  top: number;
  width: number;
  originX: string;
  originY: string;
}

export interface HoverPreviewState {
  media: Media;
  detail?: MediaDetail;
  anchor: PreviewAnchorRect;
  to?: string;
  onRemove?: () => void;
  removeLabel?: string;
}

const OPEN_DELAY_MS = 220;
const GLIDE_DELAY_MS = 110;
const CLOSE_GRACE_MS = 150;

let active: HoverPreviewState | null = null;
let activeAnchorEl: HTMLElement | null = null;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingKey: string | null = null;

function setActiveAnchor(el: HTMLElement | null) {
  if (activeAnchorEl && activeAnchorEl !== el) {
    delete activeAnchorEl.dataset.previewOpen;
  }
  activeAnchorEl = el;
  if (el) el.dataset.previewOpen = "1";
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Compute viewport-safe Liquid Glass hover popover geometry anchored cleanly around a hovered card. */
export function computePreviewPosition(
  anchor: PreviewAnchorRect,
  vw: number,
  vh: number,
  opts?: { cardW?: number; cardH?: number; railW?: number; topH?: number },
): HoverPreviewPosition {
  const railW = opts?.railW ?? (vw <= 760 ? 54 : 68);
  const topH = opts?.topH ?? 40;
  const minLeft = railW + 14;
  const maxRight = Math.max(minLeft + 240, vw - 16);
  const availW = maxRight - minLeft;
  const width = Math.max(260, Math.min(opts?.cardW ?? 404, availW));
  const estH = Math.min(opts?.cardH ?? 415, Math.max(250, vh - topH - 28));

  const rawLeft = anchor.left + anchor.width / 2 - width / 2;
  const maxLeft = Math.max(minLeft, maxRight - width);
  const left = Math.round(Math.max(minLeft, Math.min(maxLeft, rawLeft)));

  const minTop = topH + 12;
  const maxTop = Math.max(minTop, vh - 16 - estH);
  const rawTop = anchor.top - Math.max(26, (estH - anchor.height) * 0.34);
  const top = Math.round(Math.max(minTop, Math.min(maxTop, rawTop)));

  const originX = left > rawLeft + 12 ? "left" : left < rawLeft - 12 ? "right" : "center";
  const originY = top > rawTop + 16 ? "top" : top < rawTop - 16 ? "bottom" : "center";
  return { left, top, width, originX, originY };
}

function clearTimers() {
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = undefined;
  }
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

function isBlockedByOverlay(): boolean {
  if (typeof document === "undefined") return true;
  return Boolean(document.querySelector(".filmreel.dragging, .qd-scrim, .palette-scrim, .dl-modal-scrim, .trailer-scrim"));
}

function hydrateDetail(key: string) {
  void getDetail(key)
    .then((detail) => {
      if (active && active.media.key === key && active.detail !== detail) {
        active = { ...active, detail };
        emit();
      }
    })
    .catch(() => {});
}

export function scheduleHoverPreview(
  media: Media,
  el: HTMLElement | null,
  opts?: { to?: string; onRemove?: () => void; removeLabel?: string },
): void {
  if (!el || isBlockedByOverlay()) return;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  if (active?.media.key === media.key) {
    const r = el.getBoundingClientRect();
    setActiveAnchor(el);
    active = {
      ...active,
      anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
      to: opts?.to,
      onRemove: opts?.onRemove,
      removeLabel: opts?.removeLabel,
    };
    emit();
    return;
  }

  if (openTimer) clearTimeout(openTimer);
  pendingKey = media.key;
  const delay = active ? GLIDE_DELAY_MS : OPEN_DELAY_MS;
  openTimer = setTimeout(() => {
    openTimer = undefined;
    if (pendingKey !== media.key || !el.isConnected || isBlockedByOverlay()) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const detail = peekDetail(media.key);
    setActiveAnchor(el);
    active = {
      media,
      detail,
      anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
      to: opts?.to,
      onRemove: opts?.onRemove,
      removeLabel: opts?.removeLabel,
    };
    emit();
    if (!detail) hydrateDetail(media.key);
  }, delay);
}

export function keepHoverPreviewOpen(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

export function cancelHoverPreview(delayMs = CLOSE_GRACE_MS): void {
  pendingKey = null;
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = undefined;
  }
  if (!active) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = undefined;
    if (active) {
      setActiveAnchor(null);
      active = null;
      emit();
    }
  }, delayMs);
}

export function closeHoverPreviewNow(): void {
  pendingKey = null;
  clearTimers();
  setActiveAnchor(null);
  if (active) {
    active = null;
    emit();
  }
}

export function useHoverPreview(): HoverPreviewState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active,
  );
}
