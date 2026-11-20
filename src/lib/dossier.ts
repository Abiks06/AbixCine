import { useSyncExternalStore } from "react";
import type { Media } from "./types";

/**
 * Lightweight store for the slide-over Quick Screening Dossier drawer,
 * plus an ephemeral key -> Media registry so pressing `I` on any focused
 * media card opens its dossier immediately without re-rendering shelves.
 */
const listeners = new Set<() => void>();
let current: Media | null = null;
const mediaIndex = new Map<string, Media>();
const INDEX_MAX = 300;

const emit = () => listeners.forEach((l) => l());

export function registerMedia(m: Media) {
  if (!m?.key) return;
  if (mediaIndex.has(m.key)) mediaIndex.delete(m.key);
  mediaIndex.set(m.key, m);
  if (mediaIndex.size > INDEX_MAX) {
    const oldest = mediaIndex.keys().next().value;
    if (oldest) mediaIndex.delete(oldest);
  }
}

export function lookupMedia(key: string): Media | undefined {
  return mediaIndex.get(key);
}

export function openDossier(media: Media) {
  registerMedia(media);
  current = media;
  emit();
}

export function closeDossier() {
  if (!current) return;
  current = null;
  emit();
}

export function useDossier(): Media | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
