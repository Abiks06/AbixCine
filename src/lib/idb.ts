/**
 * A tiny async key/value store on IndexedDB, for caches too big for localStorage.
 *
 * localStorage is a single ~5 MB budget shared with everything that matters (progress, My List,
 * settings, sign-in) and every write is synchronous. Large catalog data goes here instead.
 * Where IndexedDB isn't available (tests, locked-down profiles) every call resolves quietly to
 * "nothing stored", and callers keep working from memory.
 */
const DB_NAME = "abx-catalog-v1";
const STORE = "kv";

let opening: Promise<IDBDatabase | null> | null = null;
/** A failed open is retried, but not on every call: a locked profile would be asked constantly. */
let failedAt = 0;
const RETRY_AFTER_MS = 5_000;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!opening && failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another window upgrading the schema: step aside rather than block it.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((db) => {
    // A transient failure (blocked by another tab mid-upgrade, a busy disk) used to disable
    // IndexedDB for the rest of the session: forget it so a later call opens again.
    if (!db) {
      opening = null;
      failedAt = Date.now();
    } else {
      failedAt = 0;
    }
    return db;
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export const idbAvailable = () => typeof indexedDB !== "undefined";

export function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T>("readonly", (s) => s.get(key) as IDBRequest<T>);
}

/** Resolves true once the value is durably stored. */
export async function idbSet(key: string, value: unknown): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export function idbDelete(key: string): Promise<unknown> {
  return run("readwrite", (s) => s.delete(key));
}
