/**
 * Tiny stale-while-revalidate cache for catalog requests. Keeps browsing instant
 * when you go back and forth between pages, and survives restarts via localStorage.
 */
const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const PREFIX = "abx.cache.";
/** How long to wait for fresh data before showing the stale copy (the refresh still lands in the cache). */
const STALE_WAIT_MS = 1500;
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

/** Drop the oldest catalog entries until at most `keep` remain. Returns how many were removed. */
function evict(keep: number) {
  const keys = cacheKeys();
  const drop = keys.slice(0, Math.max(0, keys.length - keep));
  for (const { k } of drop) localStorage.removeItem(k);
  return drop.length;
}

/**
 * Make room in storage by throwing away catalog entries, oldest first. Halves what is actually
 * there each time (a fixed "keep 150" removed nothing when fewer than 150 entries held all the
 * space). Progress, My List, settings and sign-in call this before giving up on a save: their
 * data matters, the catalog can always be fetched again.
 */
export function freeCatalogCache(all = false): boolean {
  try {
    const n = cacheKeys().length;
    if (!n) return false;
    return evict(all ? 0 : Math.floor(n / 2)) > 0;
  } catch {
    return false;
  }
}

function persist(key: string, entry: unknown) {
  const v = JSON.stringify(entry);
  // A single huge answer isn't worth evicting everything else for.
  if (v.length > 400_000) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      localStorage.setItem(PREFIX + key, v);
      return;
    } catch {
      // Quota: halve the catalog cache and try again, until it fits or there is nothing left to drop.
      if (!freeCatalogCache()) return; // memory cache still works
    }
  }
}

let writesSinceTrim = 0;

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
  } else {
    // Recently read means recently used: move it to the young end so eviction is LRU, not FIFO.
    mem.delete(key);
    mem.set(key, hit);
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
  // Keep the on-disk count bounded during a long session, not only at boot.
  if (++writesSinceTrim >= 40) {
    writesSinceTrim = 0;
    try {
      evict(MAX_DISK);
    } catch {
      /* ignore */
    }
  }
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
        timer = setTimeout(() => resolve(staleValue), STALE_WAIT_MS) as unknown as number;
      }),
    ])
      .catch(() => staleValue)
      .finally(() => clearTimeout(timer));
  }
  return run();
}
