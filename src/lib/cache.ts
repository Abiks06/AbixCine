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

function readEntry(key: string) {
  let hit = mem.get(key);
  if (!hit) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "at" in parsed && typeof parsed.at === "number" && Number.isFinite(parsed.at) && "value" in parsed) {
          hit = { at: parsed.at, value: parsed.value };
          mem.set(key, hit);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return hit;
}

function writeEntry<T>(key: string, value: T, at = Date.now()): void {
  const entry = { at, value };
  mem.delete(key);
  mem.set(key, entry);
  if (mem.size > MAX_MEM) {
    const oldest = mem.keys().next();
    if (!oldest.done) mem.delete(oldest.value);
  }
  persist(key, entry);
}

export function peekCache<T>(key: string, ttlMs: number): T | undefined {
  const now = Date.now();
  const hit = readEntry(key);
  return hit && now - hit.at < ttlMs ? (hit.value as T) : undefined;
}

export function seedCache<T>(key: string, value: T, at = Date.now()): void {
  writeEntry(key, value, at);
}

export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = readEntry(key);
  const fresh = hit && now - hit.at < ttlMs;
  if (fresh) return hit.value as T;

  const run = () => {
    if (inflight.has(key)) return inflight.get(key) as Promise<T>;
    const p = fetcher()
      .then((value) => {
        writeEntry(key, value);
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  if (hit) {
    // Stale: fetch fresh so what you see is current, but never leave you staring at a spinner.
    // If the network is slow or down, fall back to the last good copy without leaking an unhandled rejection.
    const staleValue = hit.value as T;
    const bg = run();
    bg.catch(() => {});
    let timer = 0;
    return Promise.race([
      bg,
      new Promise<T>((resolve) => {
        timer = window.setTimeout(() => resolve(staleValue), STALE_WAIT_MS);
      }),
    ])
      .catch(() => staleValue)
      .finally(() => clearTimeout(timer));
  }
  return run();
}
