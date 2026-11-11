import { useSyncExternalStore } from "react";

/** App-wide confirmations ("Added to My List"): one line, bottom centre, gone in a few seconds. */
export interface Toast {
  id: number;
  text: string;
  icon?: string;
  /** Optional one-click follow-up, e.g. Undo. */
  action?: { label: string; run: () => void };
}

const LIFE_MS = 3200;
const MAX = 3;
const listeners = new Set<() => void>();
let toasts: Toast[] = [];
let seq = 0;

const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(text: string, opts: Omit<Toast, "id" | "text"> = {}) {
  const id = ++seq;
  toasts = [...toasts, { id, text, ...opts }].slice(-MAX);
  emit();
  setTimeout(() => dismissToast(id), opts.action ? LIFE_MS + 2000 : LIFE_MS);
}

export function useToasts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
}
