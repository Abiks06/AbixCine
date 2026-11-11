import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { getSettings } from "./settings";

/**
 * App updates.
 *
 * Release builds (made by .github/workflows/release.yml) are signed, and the app checks
 * GitHub Releases for a newer signed build: it downloads it in the background (or when you say
 * so), shows what's new, and installs on restart. The signature is checked against the public
 * key baked into the build, so only builds signed with the project's private key ever install.
 *
 * Builds without an updater key (local dev builds) still find out about new releases, but
 * only offer to open the download page.
 */
export const REPO = "Abiks06/AbixCine";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const CHECK_EVERY_MS = 6 * 3600_000;
const FIRST_CHECK_MS = 8000;

export type UpdateStatus = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "installing" | "error";

export interface UpdateState {
  current: string;
  status: UpdateStatus;
  /** True when this build can download and install updates itself. */
  canInstall: boolean;
  update?: { version: string; notes: string; date?: string; url: string };
  progress?: { got: number; total?: number };
  lastChecked?: number;
  error?: string;
  /** Shown once after an update: the version you're now on. */
  whatsNew?: string;
  /** Dismissed for this session (the "Later" button). */
  snoozed?: boolean;
}

export interface Release {
  version: string;
  name: string;
  date: string;
  notes: string;
  url: string;
  prerelease: boolean;
}

let state: UpdateState = { current: "", status: "idle", canInstall: false };
const listeners = new Set<() => void>();
const set = (p: Partial<UpdateState>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};
export const getUpdateState = () => state;
export function useUpdates() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** -1, 0 or 1. Understands 1.2.3 and 1.2.3-beta.1 (a pre-release sorts before its release). */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/i, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

let pending: import("@tauri-apps/plugin-updater").Update | null = null;
let checking: Promise<void> | null = null;

async function latestRelease(): Promise<Release | null> {
  const list = await releaseNotes();
  return list.find((r) => !r.prerelease) ?? null;
}

/** Ask GitHub for a newer version. `silent` checks never show errors. */
export function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  checking ??= (async () => {
    set({ status: "checking", error: undefined });
    try {
      const canInstall = await invoke<boolean>("updater_ready").catch(() => false);
      set({ canInstall });
      if (canInstall) {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check({ timeout: 20_000 });
        if (!u) return set({ status: "none", lastChecked: Date.now(), update: undefined });
        pending = u;
        set({ status: "available", lastChecked: Date.now(), update: { version: u.version, notes: u.body ?? "", date: u.date, url: `${RELEASES_URL}/tag/v${u.version}` } });
        const s = getSettings();
        if (s.autoUpdate && s.skipVersion !== u.version) void downloadUpdate();
      } else {
        const r = await latestRelease();
        if (!r || compareVersions(r.version, state.current) <= 0) return set({ status: "none", lastChecked: Date.now(), update: undefined });
        set({ status: "available", lastChecked: Date.now(), update: { version: r.version, notes: r.notes, date: r.date, url: r.url } });
      }
    } catch (e) {
      set({ status: silent ? "idle" : "error", error: e instanceof Error ? e.message : String(e), lastChecked: Date.now() });
    }
  })().finally(() => (checking = null));
  return checking;
}

let downloading: Promise<void> | null = null;
/** Download the update in the background; install happens on restart (or "Restart now"). */
export function downloadUpdate(): Promise<void> {
  if (!pending) return Promise.resolve();
  downloading ??= (async () => {
    set({ status: "downloading", progress: { got: 0 } });
    try {
      let got = 0;
      let total: number | undefined;
      await pending!.download((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? undefined;
        else if (ev.event === "Progress") got += ev.data.chunkLength;
        set({ progress: { got, total } });
      });
      set({ status: "ready" });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  })().finally(() => (downloading = null));
  return downloading;
}

/** Install and restart. Windows closes the app while the installer runs, then reopens it. */
export async function installUpdate() {
  if (!pending) return;
  if (state.status !== "ready") await downloadUpdate();
  if (state.status !== "ready") return;
  set({ status: "installing" });
  try {
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    set({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export const snoozeUpdate = () => set({ snoozed: true });
export const dismissWhatsNew = () => set({ whatsNew: undefined });

let notesCache: { at: number; list: Release[] } | null = null;
/** Published releases, newest first (the changelog). Cached for an hour. */
export async function releaseNotes(force = false): Promise<Release[]> {
  if (!force && notesCache && Date.now() - notesCache.at < 3600_000) return notesCache.list;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const j: any[] = await res.json();
  const list = j
    .filter((r) => !r.draft)
    .map((r) => ({ version: String(r.tag_name).replace(/^v/i, ""), name: r.name || r.tag_name, date: r.published_at, notes: r.body ?? "", url: r.html_url, prerelease: !!r.prerelease }));
  notesCache = { at: Date.now(), list };
  return list;
}

/** Start the background checks. Call once at boot. */
export async function bootUpdates() {
  if (!isTauri()) return;
  const { getVersion } = await import("@tauri-apps/api/app");
  const current = await getVersion().catch(() => "");
  let last = "";
  try {
    last = localStorage.getItem("abx.lastVersion") ?? "";
    localStorage.setItem("abx.lastVersion", current);
  } catch {
    /* ignore */
  }
  set({ current, whatsNew: last && current && compareVersions(current, last) > 0 ? current : undefined });
  setTimeout(() => void checkForUpdates({ silent: true }), FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates({ silent: true }), CHECK_EVERY_MS);
}

/** Turn release-note Markdown into simple blocks (headings, bullets, paragraphs) without HTML. */
export function noteBlocks(md: string): { kind: "h" | "li" | "p"; text: string }[] {
  return md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(\*\*full changelog\*\*|full changelog)/i.test(l))
    .map((l) => {
      const clean = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      if (/^#{1,6}\s/.test(l)) return { kind: "h" as const, text: clean(l.replace(/^#+\s*/, "")) };
      if (/^[-*+]\s/.test(l)) return { kind: "li" as const, text: clean(l.replace(/^[-*+]\s*/, "")) };
      return { kind: "p" as const, text: clean(l) };
    });
}
