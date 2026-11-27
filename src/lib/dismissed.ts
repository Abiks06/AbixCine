import { useSyncExternalStore } from "react";
import type { Media } from "./types";

const DISMISSED_KEY = "abx.dismissed.v1";
const SEEDS_KEY = "abx.tasteSeeds.v1";
const MAX_DISMISSED = 200;

interface DismissRecord {
  key: string;
  genres: string[];
  at: number;
}

const listeners = new Set<() => void>();
const seedListeners = new Set<() => void>();

function loadDismissed(): DismissRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => typeof r?.key === "string") : [];
  } catch {
    return [];
  }
}

function loadTasteSeeds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEDS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((g) => typeof g === "string") : [];
  } catch {
    return [];
  }
}

let dismissedList: DismissRecord[] = loadDismissed();
let dismissedSet = new Set(dismissedList.map((r) => r.key));
let tasteSeeds: string[] = loadTasteSeeds();

function saveDismissed() {
  dismissedSet = new Set(dismissedList.map((r) => r.key));
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissedList.slice(0, MAX_DISMISSED)));
  } catch {
    /* ignore */
  }
  listeners.forEach((cb) => cb());
}

function saveSeeds() {
  try {
    localStorage.setItem(SEEDS_KEY, JSON.stringify(tasteSeeds));
  } catch {
    /* ignore */
  }
  seedListeners.forEach((cb) => cb());
}

/** Persist a recommendation dismissal with its genres so taste softens away from unwanted picks. */
export function dismissRecommendation(media: Pick<Media, "key" | "genres">) {
  const next = [{ key: media.key, genres: media.genres.slice(0, 3), at: Date.now() }, ...dismissedList.filter((r) => r.key !== media.key)].slice(0, MAX_DISMISSED);
  dismissedList = next;
  saveDismissed();
}

export function undismissRecommendation(key: string) {
  dismissedList = dismissedList.filter((r) => r.key !== key);
  saveDismissed();
}

export function clearDismissed() {
  dismissedList = [];
  saveDismissed();
}

export function useDismissed(): { keys: ReadonlySet<string>; records: readonly DismissRecord[] } {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => dismissedList,
  );
  return { keys: dismissedSet, records: dismissedList };
}

export function toggleTasteSeed(genre: string) {
  tasteSeeds = tasteSeeds.includes(genre) ? tasteSeeds.filter((g) => g !== genre) : [...tasteSeeds, genre].slice(0, 5);
  saveSeeds();
}

export function clearTasteSeeds() {
  tasteSeeds = [];
  saveSeeds();
}

export function useTasteSeeds(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      seedListeners.add(cb);
      return () => seedListeners.delete(cb);
    },
    () => tasteSeeds,
  );
}
