import { useSyncExternalStore } from "react";
import { push, registerSync, fetchSync } from "./account";

export type Audio = "sub" | "dub";

export interface Settings {
  tmdbKey: string;
  libraryPaths: string[];
  jellyfin: { url: string; apiKey: string; enabled: boolean };
  preferredQuality: number; // 2160 | 1080 | 720 | 480
  autoplayNext: boolean;
  reduceMotion: boolean;
  /** Default audio for anime. */
  animeAudio: Audio;
  /** Per-title override, so switching one show to dub doesn't change the rest. */
  audioByTitle: Record<string, Audio>;
  /** IDs of disabled source providers (e.g. from availableSources). */
  disabledSources: string[];
  /** Extra servers (all enabled by default; circuit breaker manages health automatically). */
  enabledExtras: string[];
}

/** Settings that follow the account. Library folders and server credentials stay on this device. */
const SYNCED: (keyof Settings)[] = ["preferredQuality", "autoplayNext", "reduceMotion", "animeAudio", "audioByTitle", "disabledSources", "enabledExtras"];

const EXTRA_IDS = ["vidsrccc", "vidsrcto", "2embed", "multiembed", "embedsu", "vidsrcrip", "frembed"];

const DEFAULTS: Settings = {
  tmdbKey: import.meta.env.VITE_TMDB_KEY ?? "",
  libraryPaths: [],
  jellyfin: { url: "", apiKey: "", enabled: false },
  preferredQuality: 1080,
  autoplayNext: true,
  reduceMotion: false,
  animeAudio: "sub",
  audioByTitle: {},
  disabledSources: [],
  enabledExtras: EXTRA_IDS,
};

const KEY = "abx.settings.v1";
const listeners = new Set<() => void>();

function normalizeSourceToggles(
  partial: Partial<Settings>,
  base: Settings,
): Pick<Settings, "disabledSources" | "enabledExtras"> {
  const disabled = new Set(partial.disabledSources ?? base.disabledSources ?? []);
  if (Array.isArray(partial.enabledExtras)) {
    if (partial.disabledSources == null) {
      for (const id of EXTRA_IDS) {
        if (partial.enabledExtras.includes(id)) disabled.delete(id);
        else disabled.add(id);
      }
    } else {
      for (const id of EXTRA_IDS) {
        if (!partial.enabledExtras.includes(id)) disabled.add(id);
      }
    }
  }
  const disabledSources = [...disabled];
  const enabledExtras = EXTRA_IDS.filter((id) => !disabled.has(id));
  return { disabledSources, enabledExtras };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ...DEFAULTS,
        ...parsed,
        ...normalizeSourceToggles(parsed, DEFAULTS),
      };
    }
  } catch {
    /* storage unavailable: fall back to defaults */
  }
  return DEFAULTS;
}

let current = load();

export const getSettings = () => current;

function apply(patch: Partial<Settings>) {
  const toggles =
    patch.disabledSources !== undefined || patch.enabledExtras !== undefined
      ? normalizeSourceToggles(patch, current)
      : {};
  current = { ...current, ...patch, ...toggles };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function updateSettings(patch: Partial<Settings>) {
  apply(patch);
  const synced = Object.fromEntries(Object.entries(patch).filter(([k]) => SYNCED.includes(k as keyof Settings)));
  if (Object.keys(synced).length) push("/settings", "PUT", synced);
}

export function audioFor(mediaKey: string, fallbackKeys?: (string | undefined)[]): Audio {
  if (current.audioByTitle[mediaKey]) return current.audioByTitle[mediaKey];
  if (fallbackKeys) {
    for (const k of fallbackKeys) {
      if (k && current.audioByTitle[k]) return current.audioByTitle[k];
    }
  }
  return current.animeAudio;
}
export function setAudioFor(mediaKey: string, a: Audio, aliasKeys?: (string | undefined)[]) {
  const next: Record<string, Audio> = { ...current.audioByTitle, [mediaKey]: a };
  if (aliasKeys) {
    for (const k of aliasKeys) {
      if (k) next[k] = a;
    }
  }
  updateSettings({ audioByTitle: next });
}

export function toggleSource(id: string, enabled: boolean, extra = false) {
  const disabled = current.disabledSources ?? [];
  const nextDisabled = enabled ? disabled.filter((x) => x !== id) : [...new Set([...disabled, id])];
  if (extra) {
    const list = current.enabledExtras ?? [];
    const nextExtras = enabled ? [...new Set([...list, id])] : list.filter((x) => x !== id);
    updateSettings({ disabledSources: nextDisabled, enabledExtras: nextExtras });
    return;
  }
  updateSettings({ disabledSources: nextDisabled });
}

export function isSourceEnabled(id: string): boolean {
  return !(current.disabledSources ?? []).includes(id) && (!EXTRA_IDS.includes(id) || (current.enabledExtras ?? EXTRA_IDS).includes(id));
}

registerSync({
  pull: () =>
    fetchSync()
      .then((s) => apply(Object.fromEntries(Object.entries(s.settings ?? {}).filter(([k]) => SYNCED.includes(k as keyof Settings)))))
      .catch(() => {}),
});

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
