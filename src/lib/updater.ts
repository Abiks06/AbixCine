import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * In-app updates. Releases are published to GitHub by the release workflow, signed with the
 * project's updater key; the app reads latest.json from the newest release, verifies the
 * signature, downloads the installer and restarts into the new version.
 */

export type UpdateState =
  | { status: "idle" | "checking" | "current" | "unsupported" }
  | { status: "available"; version: string; notes?: string; date?: string }
  | { status: "downloading"; version: string; progress: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: isTauri() ? "idle" : "unsupported" };
let dismissed: string | null = null;
let pending: import("@tauri-apps/plugin-updater").Update | null = null;
const listeners = new Set<() => void>();
const set = (s: UpdateState) => {
  state = s;
  listeners.forEach((l) => l());
};

export async function appVersion(): Promise<string> {
  if (!isTauri()) return import.meta.env.VITE_APP_VERSION ?? "web";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Ask GitHub whether a newer signed release exists. Quiet checks don't surface errors. */
export async function checkForUpdates(quiet = false) {
  if (!isTauri()) return;
  if (state.status === "checking" || state.status === "downloading") return;
  set({ status: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (!u) {
      pending = null;
      return set({ status: "current" });
    }
    pending = u;
    set({ status: "available", version: u.version, notes: u.body ?? undefined, date: u.date ?? undefined });
  } catch (e: unknown) {
    set(quiet ? { status: "idle" } : { status: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Download, install and restart. On Windows the installer runs in passive mode. */
export async function installUpdate() {
  const u = pending;
  if (!u) return;
  let total = 0;
  let got = 0;
  set({ status: "downloading", version: u.version, progress: 0 });
  try {
    await u.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        set({ status: "downloading", version: u.version, progress: total ? got / total : 0 });
      } else if (ev.event === "Finished") set({ status: "ready", version: u.version });
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e: unknown) {
    set({ status: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

export const dismissUpdate = () => {
  if (state.status === "available") dismissed = state.version;
  listeners.forEach((l) => l());
};
export const isDismissed = (v: string) => dismissed === v;

let started = false;
/** Check shortly after launch, then every six hours while the app stays open. */
export function startUpdateChecks() {
  if (started || !isTauri() || import.meta.env.DEV) return;
  started = true;
  setTimeout(() => checkForUpdates(true), 8000);
  setInterval(() => checkForUpdates(true), 6 * 3600_000);
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
