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

interface TimerState {
  timer?: ReturnType<typeof setTimeout>;
  remaining: number;
  startedAt: number;
}
const timers = new Map<number, TimerState>();

const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  const entry = timers.get(id);
  if (entry?.timer) clearTimeout(entry.timer);
  timers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function armTimer(id: number, delay: number) {
  const entry: TimerState = { remaining: delay, startedAt: Date.now() };
  entry.timer = setTimeout(() => dismissToast(id), delay);
  timers.set(id, entry);
}

export function pauseToast(id: number) {
  const entry = timers.get(id);
  if (!entry?.timer) return;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.remaining = Math.max(600, entry.remaining - (Date.now() - entry.startedAt));
}

export function resumeToast(id: number) {
  const entry = timers.get(id);
  if (!entry || entry.timer) return;
  entry.startedAt = Date.now();
  entry.timer = setTimeout(() => dismissToast(id), entry.remaining);
}

export function toast(text: string, opts: Omit<Toast, "id" | "text"> = {}) {
  const id = ++seq;
  const next = [...toasts, { id, text, ...opts }];
  while (next.length > MAX) {
    const evicted = next.shift();
    if (evicted) {
      const entry = timers.get(evicted.id);
      if (entry?.timer) clearTimeout(entry.timer);
      timers.delete(evicted.id);
    }
  }
  toasts = next;
  emit();
  armTimer(id, opts.action ? LIFE_MS + 2200 : LIFE_MS);
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
