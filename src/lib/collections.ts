import { useSyncExternalStore } from "react";

export interface MediaCollection {
  id: string;
  name: string;
  keys: string[];
  createdAt: number;
  updatedAt: number;
}

const KEY = "abx.collections.v1";
const MAX_COLLECTIONS = 40;
const MAX_NAME_LEN = 48;
const listeners = new Set<() => void>();

function sanitizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LEN);
}

function load(): MediaCollection[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: MediaCollection[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? sanitizeName(item.name) : "";
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      const keys = Array.isArray(item.keys)
        ? [...new Set<string>(item.keys.filter((k: unknown): k is string => typeof k === "string" && k.length > 0))]
        : [];
      const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
      const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt;
      out.push({ id, name, keys, createdAt, updatedAt });
      if (out.length >= MAX_COLLECTIONS) break;
    }
    return out;
  } catch {
    return [];
  }
}

let collections: MediaCollection[] = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(collections));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function getCollections(): MediaCollection[] {
  return collections;
}

export function createCollection(name: string): MediaCollection | null {
  const clean = sanitizeName(name);
  if (!clean) return null;
  if (collections.length >= MAX_COLLECTIONS) return null;
  const dup = collections.find((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (dup) return dup;
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `col-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: MediaCollection = { id, name: clean, keys: [], createdAt: now, updatedAt: now };
  collections = [entry, ...collections];
  save();
  return entry;
}

export function renameCollection(id: string, name: string): boolean {
  const clean = sanitizeName(name);
  if (!clean) return false;
  const idx = collections.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  collections = collections.map((c) => (c.id === id ? { ...c, name: clean, updatedAt: Date.now() } : c));
  save();
  return true;
}

export function deleteCollection(id: string): boolean {
  const before = collections.length;
  collections = collections.filter((c) => c.id !== id);
  if (collections.length === before) return false;
  save();
  return true;
}

export function toggleInCollection(id: string, mediaKey: string): boolean {
  const cleanKey = mediaKey.trim();
  if (!cleanKey) return false;
  let added = false;
  let found = false;
  const now = Date.now();
  collections = collections.map((c) => {
    if (c.id !== id) return c;
    found = true;
    if (c.keys.includes(cleanKey)) {
      added = false;
      return { ...c, keys: c.keys.filter((k) => k !== cleanKey), updatedAt: now };
    }
    added = true;
    return { ...c, keys: [cleanKey, ...c.keys], updatedAt: now };
  });
  if (!found) return false;
  save();
  return added;
}

export function collectionsForKey(mediaKey: string): MediaCollection[] {
  if (!mediaKey) return [];
  return collections.filter((c) => c.keys.includes(mediaKey));
}

export function useCollections(): MediaCollection[] {
  return useSyncExternalStore(subscribe, () => collections);
}

export function resetCollectionsForTest() {
  collections = [];
  save();
}
