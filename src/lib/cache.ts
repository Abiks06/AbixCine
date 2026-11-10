/**
 * Tiny stale-while-revalidate cache for catalog requests. Keeps browsing instant
 * when you go back and forth between pages, and survives restarts via localStorage.
 */
const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const PREFIX = "abx.cache.";
/** How long to wait for fresh data before showing the stale copy (the refresh still lands in the cache). */
const STALE_WAIT_MS = 4000;
/** The catalog cache must never crowd out progress, My List or settings in localStorage. */
const MAX_DISK = 300;
const MAX_MEM = 500;
const MAX_AGE_MS = 14 * 24 * 3600_000;

function cacheKeys() {
  const out: { k: string; at: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      let at = 0;
      try {
        at = JSON.parse(localStorage.getItem(k) ?? "{}").at ?? 0;
      } catch {
        /* corrupt: oldest */
      }
      out.push({ k, at });
    }
  } catch {
    /* storage blocked */
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Drop the oldest catalog entries until at most `keep` remain. */
function evict(keep: number) {
  const keys = cacheKeys();
  for (const { k } of keys.slice(0, Math.max(0, keys.length - keep))) localStorage.removeItem(k);
}

function persist(key: string, entry: unknown) {
  const v = JSON.stringify(entry);
  try {
    localStorage.setItem(PREFIX + key, v);
  } catch {
    // Quota: make room by halving the catalog cache, then try once more.
    try {
      evict(Math.floor(MAX_DISK / 2));
      localStorage.setItem(PREFIX + key, v);
    } catch {
      /* memory cache still works */
    }
  }
}

// Boot: forget entries nobody has needed for two weeks, and keep the count bounded.
try {
  const now = Date.now();
  for (const { k, at } of cacheKeys()) if (now - at > MAX_AGE_MS) localStorage.removeItem(k);
  evict(MAX_DISK);
} catch {
  /* ignore */
}

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
        mem.delete(key);
        mem.set(key, entry);
        if (mem.size > MAX_MEM) mem.delete(mem.keys().next().value!);
        persist(key, entry);
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  if (hit) {
    // Stale: fetch fresh so what you see is current, but never leave you staring at a spinner.
    // If the network is slow or down, fall back to the last good copy.
    return Promise.race([
      run(),
      new Promise<T>((resolve) => setTimeout(() => resolve(hit!.value as T), STALE_WAIT_MS)),
    ]).catch(() => hit!.value as T);
  }
  return run();
}
