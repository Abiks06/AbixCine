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
  /**
   * Playback engine. auto: the built-in player, switching to mpv for files it can't decode
   * (HEVC, DTS, TrueHD, 10-bit…) or when it fails. mpv: always mpv. builtin: never mpv.
   */
  engine: "auto" | "mpv" | "builtin";
  /** A specific mpv.exe; empty = the bundled copy or one that's installed. */
  mpvPath: string;
  /** Draw mpv inside the AbixCine window, or in mpv's own window. */
  mpvWindow: "embedded" | "separate";
  mpvHwdec: boolean;
  /** Jump over openings/recaps automatically instead of showing a Skip button. */
  autoSkipIntro: boolean;
  /** Alert me when shows in My List / Continue watching get a new episode or season. */
  notifyEpisodes: boolean;
  /** Also show those alerts as Windows notifications. */
  notifyDesktop: boolean;
  /** Download updates in the background, install on next restart. */
  autoUpdate: boolean;
  /** An update the viewer chose to skip. */
  skipVersion: string;
}

/** Settings that follow the account. Library folders and server credentials stay on this device. */
const SYNCED: (keyof Settings)[] = ["preferredQuality", "autoplayNext", "reduceMotion", "animeAudio", "audioByTitle", "autoSkipIntro", "notifyEpisodes"];

const DEFAULTS: Settings = {
  tmdbKey: import.meta.env.VITE_TMDB_KEY ?? "",
  libraryPaths: [],
  jellyfin: { url: "", apiKey: "", enabled: false },
  preferredQuality: 1080,
  autoplayNext: true,
  reduceMotion: false,
  animeAudio: "sub",
  audioByTitle: {},
  engine: "auto",
  mpvPath: "",
  mpvWindow: "embedded",
  mpvHwdec: true,
  autoSkipIntro: false,
  notifyEpisodes: true,
  notifyDesktop: true,
  autoUpdate: true,
  skipVersion: "",
};

const KEY = "abx.settings.v1";
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: fall back to defaults */
  }
  return DEFAULTS;
}

let current = load();

export const getSettings = () => current;

function apply(patch: Partial<Settings>) {
  current = { ...current, ...patch };
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

export function audioFor(mediaKey: string): Audio {
  return current.audioByTitle[mediaKey] ?? current.animeAudio;
}
export function setAudioFor(mediaKey: string, a: Audio) {
  updateSettings({ audioByTitle: { ...current.audioByTitle, [mediaKey]: a } });
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
