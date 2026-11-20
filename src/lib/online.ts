import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
let attached = false;

function attach() {
  if (attached || typeof window === "undefined") return;
  attached = true;
  const sync = () => {
    const next = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    if (next !== online) {
      online = next;
      listeners.forEach((fn) => fn());
    }
  };
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
}

/** Reactive online/offline state updated synchronously on browser connectivity events. */
export function useOnlineStatus(): boolean {
  attach();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => online,
  );
}
