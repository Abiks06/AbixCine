/**
 * Tiny stale-while-revalidate cache for catalog requests. Keeps browsing instant
 * when you go back and forth between pages, and survives restarts via localStorage.
 */
const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const PREFIX = "abx.cache.";

export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  let hit = mem.get(key);
  if (!hit) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw) {
        hit = JSON.parse(raw);
        mem.set(key, hit!);
      }
    } catch {
      /* ignore */
    }
  }
  const fresh = hit && now - hit.at < ttlMs;
  if (fresh) return hit!.value as T;

  const run = () => {
    if (inflight.has(key)) return inflight.get(key) as Promise<T>;
    const p = fetcher()
      .then((value) => {
        const entry = { at: Date.now(), value };
        mem.set(key, entry);
        try {
          localStorage.setItem(PREFIX + key, JSON.stringify(entry));
        } catch {
          /* quota: memory cache still works */
        }
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  if (hit) {
    // Stale: serve immediately, refresh in background.
    run().catch(() => {});
    return hit.value as T;
  }
  return run();
}
