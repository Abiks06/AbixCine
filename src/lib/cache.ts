import { idbScan, idbWriteMany } from "./idb";

/**
 * Tiny stale-while-revalidate cache for catalog requests. Keeps browsing instant when you go back
 * and forth between pages, and survives restarts on disk.
 *
 * Reads always come from memory. The disk copy lives in IndexedDB, written in batches off the main
 * path, so a large catalog answer never blocks a frame (localStorage writes are synchronous) and
 * never competes with progress, My List, settings or sign-in for localStorage's ~5 MB. At boot the
 * disk copy is loaded into memory once; `cached()` waits briefly for that before deciding it has
 * nothing. Entries an older build left in localStorage are moved over on the first boot.
 */
const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const LEGACY_PREFIX = "abx.cache.";
const IDB_PREFIX = "cache:";
/** How long to wait for fresh data before showing the stale copy (the refresh still lands in the cache). */
const STALE_WAIT_MS = 1500;
/** Longest `cached()` waits for the disk copy to load at boot before going to the network. */
const HYDRATE_WAIT_MS = 400;
const MAX_DISK = 600;
const MAX_MEM = 600;
const MAX_AGE_MS = 14 * 24 * 3600_000;
const MAX_ENTRY_CHARS = 1_500_000;
const FLUSH_DELAY_MS = 600;

type Entry = { at: number; value: unknown };

/** What is on disk: key -> stored-at, so eviction never has to read the store back. */
const diskIndex = new Map<string, number>();
const pendingPuts = new Map<string, Entry>();
const pendingDeletes = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const isEntry = (x: unknown): x is Entry =>
  !!x && typeof x === "object" && "at" in x && typeof (x as Entry).at === "number" && Number.isFinite((x as Entry).at) && "value" in x;

function legacyKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LEGACY_PREFIX)) out.push(k);
    }
  } catch {
    /* storage blocked */
  }
  return out;
}

/** Remember an entry in memory, keeping the newest MAX_MEM (least recently used goes first). */
function remember(key: string, entry: Entry) {
  mem.delete(key);
  mem.set(key, entry);
  while (mem.size > MAX_MEM) {
    const oldest = mem.keys().next();
    if (oldest.done) break;
    mem.delete(oldest.value);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function flush() {
  flushTimer = null;
  // Keep the disk bounded: drop the oldest entries beyond MAX_DISK.
  if (diskIndex.size > MAX_DISK) {
    const byAge = [...diskIndex].sort((a, b) => a[1] - b[1]);
    for (const [k] of byAge.slice(0, diskIndex.size - MAX_DISK)) {
      diskIndex.delete(k);
      pendingPuts.delete(k);
      pendingDeletes.add(k);
    }
  }
  const puts = [...pendingPuts].map(([k, v]) => [IDB_PREFIX + k, v] as [string, unknown]);
  const deletes = [...pendingDeletes].map((k) => IDB_PREFIX + k);
  pendingPuts.clear();
  pendingDeletes.clear();
  void idbWriteMany(puts, deletes);
}

if (typeof window !== "undefined") {
  // Closing the app: write what is waiting (the transaction completes after the page goes).
  window.addEventListener("pagehide", () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flush();
    }
  });
}

/** Load the disk copy into memory once, and move entries an older build kept in localStorage. */
const hydrated: Promise<void> = (async () => {
  const now = Date.now();
  try {
    const rows = await idbScan<Entry>(IDB_PREFIX);
    const stale: string[] = [];
    const live: [string, Entry][] = [];
    for (const [k, e] of rows) {
      const key = k.slice(IDB_PREFIX.length);
      if (!isEntry(e) || now - e.at > MAX_AGE_MS) stale.push(k);
      else live.push([key, e]);
    }
    live.sort((a, b) => a[1].at - b[1].at);
    for (const [key, e] of live) {
      diskIndex.set(key, e.at);
      // Something fetched during the boot is newer than the disk copy: keep it.
      if (!mem.has(key)) remember(key, e);
    }
    if (stale.length) void idbWriteMany([], stale);
  } catch {
    /* no IndexedDB: memory only */
  }

  // One-time move out of localStorage.
  const legacy = legacyKeys();
  if (legacy.length) {
    for (const lk of legacy) {
      try {
        const e: unknown = JSON.parse(localStorage.getItem(lk) ?? "null");
        const key = lk.slice(LEGACY_PREFIX.length);
        if (isEntry(e) && now - e.at <= MAX_AGE_MS && !diskIndex.has(key)) {
          if (!mem.has(key)) remember(key, e);
          diskIndex.set(key, e.at);
          pendingPuts.set(key, e);
        }
      } catch {
        /* corrupt: drop */
      }
    }
    flush();
    for (const lk of legacy) {
      try {
        localStorage.removeItem(lk);
      } catch {
        /* ignore */
      }
    }
  }
})();

let ready = false;
void hydrated.then(() => {
  ready = true;
});

/** Resolves once the disk copy is in memory, or after a short wait (whichever is first). */
export function cacheReady(): Promise<void> {
  if (ready) return Promise.resolve();
  return Promise.race([hydrated, new Promise<void>((r) => setTimeout(r, HYDRATE_WAIT_MS))]);
}

/**
 * Free localStorage by dropping catalog entries an older build left there. The catalog now lives
 * in IndexedDB, so normally there is nothing to drop and this returns false.
 */
export function freeCatalogCache(_all = false): boolean {
  const keys = legacyKeys();
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  return keys.length > 0;
}

function readEntry(key: string): Entry | undefined {
  const hit = mem.get(key);
  // Recently read means recently used: move it to the young end so eviction is LRU, not FIFO.
  if (hit) remember(key, hit);
  return hit;
}

function writeEntry<T>(key: string, value: T, at = Date.now()): void {
  const entry = { at, value };
  remember(key, entry);
  // A single huge answer isn't worth the disk churn; it still lives in memory for the session.
  try {
    if (JSON.stringify(value).length > MAX_ENTRY_CHARS) return;
  } catch {
    return; // not serialisable: memory only
  }
  diskIndex.set(key, at);
  pendingDeletes.delete(key);
  pendingPuts.set(key, entry);
  scheduleFlush();
}

export function peekCache<T>(key: string, ttlMs: number): T | undefined {
  const hit = readEntry(key);
  return hit && Date.now() - hit.at < ttlMs ? (hit.value as T) : undefined;
}

export function seedCache<T>(key: string, value: T, at = Date.now()): void {
  writeEntry(key, value, at);
}

export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  if (!ready && !mem.has(key)) await cacheReady();
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
