import { useEffect, useState } from "react";

const EVERY = 30 * 60_000;
const ON_FOCUS_AFTER = 10 * 60_000;

/**
 * A counter that ticks every 30 minutes, and when the window comes back into focus after
 * 10 minutes away. Put it in a useAsync dependency list and the data refetches (the cache
 * serves what is still fresh, so a tick only costs a request when something has expired).
 */
export function useFreshness() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let last = Date.now();
    const bump = () => {
      last = Date.now();
      setTick((n) => n + 1);
    };
    const id = setInterval(bump, EVERY);
    const onFocus = () => {
      if (Date.now() - last > ON_FOCUS_AFTER) bump();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return tick;
}
