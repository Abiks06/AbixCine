import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { getDetail } from "./catalog";
import { allProgress, reviveFinished } from "./progress";
import { getSettings } from "./settings";
import type { Media, MediaDetail } from "./types";
import { getWatchlistItems } from "./watchlist";

/**
 * New-episode alerts for shows you follow (My List + Continue watching): every few hours AbixCine
 * re-reads each show's details and compares the latest aired episode with what it saw last time.
 * A new one becomes an alert in the bell menu (and a Windows notification if allowed), and a
 * finished show goes back into Continue watching as "Up next".
 *
 * The first time a show is seen it only records a baseline, so adding a 10-season show to My
 * List doesn't produce ten alerts.
 */
export interface Alert {
  id: string;
  key: string;
  title: string;
  poster?: string;
  backdrop?: string;
  season?: number;
  episode: number;
  /** "episode" or a whole new "season" (episode 1 of a season you haven't seen). */
  kind: "episode" | "season";
  at: number;
  read: boolean;
}

interface Seen {
  season?: number;
  episode: number;
}

const KEY_ALERTS = "abx.alerts.v1";
const KEY_SEEN = "abx.alerts.seen.v1";
const CHECK_EVERY_MS = 3 * 3600_000;
const MAX_ALERTS = 60;
const MAX_TITLES = 80;

const read = <T,>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) || "") as T;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

let alerts: Alert[] = read(KEY_ALERTS, []);
const listeners = new Set<() => void>();
const changed = () => {
  write(KEY_ALERTS, alerts);
  listeners.forEach((l) => l());
};

export function useAlerts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => alerts,
  );
}
export const markAllRead = () => {
  if (alerts.some((a) => !a.read)) {
    alerts = alerts.map((a) => ({ ...a, read: true }));
    changed();
  }
};
export const clearAlerts = () => {
  alerts = [];
  changed();
};

/** The newest episode that has actually aired, for TMDB series and AniList anime. */
export function latestAired(d: MediaDetail, now = Date.now()): Seen | null {
  if (d.lastEpisode) {
    const n = d.nextEpisode;
    // TMDB sometimes moves "next" into "last" a little early: only count it once its date has passed.
    if (n?.airDate && Date.parse(n.airDate) <= now) return { season: n.season, episode: n.episode };
    return { season: d.lastEpisode.season, episode: d.lastEpisode.episode };
  }
  if (d.key.startsWith("anilist:")) {
    if (d.nextAiring) return d.nextAiring.episode > 1 ? { episode: d.nextAiring.episode - 1 } : null;
    if (d.episodeCount && /FINISHED|RELEASING/i.test(d.status ?? "")) return { episode: d.episodeCount };
  }
  return null;
}

const later = (a: Seen, b: Seen) => (a.season ?? 0) > (b.season ?? 0) || ((a.season ?? 0) === (b.season ?? 0) && a.episode > b.episode);

/** Compare one show's latest episode with the stored one. Pure, for tests. */
export function diffShow(prev: Seen | undefined, now: Seen | null): { alert: Omit<Alert, "id" | "key" | "title" | "at" | "read"> | null; seen?: Seen } {
  if (!now) return { alert: null, seen: prev };
  if (!prev) return { alert: null, seen: now };
  if (!later(now, prev)) return { alert: null, seen: prev };
  const newSeason = now.season != null && now.season > (prev.season ?? 0);
  return { alert: { season: now.season, episode: now.episode, kind: newSeason ? "season" : "episode" }, seen: now };
}

function followed(): Media[] {
  const out = new Map<string, Media>();
  for (const p of Object.values(allProgress())) if (p.media.kind !== "movie") out.set(p.media.key, p.media);
  for (const w of getWatchlistItems()) if (w.media.kind !== "movie") out.set(w.media.key, w.media);
  return [...out.values()].filter((m) => !m.key.startsWith("demo:")).slice(0, MAX_TITLES);
}

async function notifyDesktop(a: Alert) {
  if (!isTauri() || !getSettings().notifyDesktop) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (!ok) return;
    n.sendNotification({ title: a.title, body: alertText(a) });
  } catch {
    /* notifications unavailable */
  }
}

export function alertText(a: Pick<Alert, "kind" | "season" | "episode">) {
  if (a.kind === "season") return `Season ${a.season} is here. Episode ${a.episode} is out now.`;
  return `New episode: ${a.season != null ? `S${a.season} · ` : ""}E${a.episode} is out.`;
}

let running: Promise<number> | null = null;
/** Check every followed show once. Resolves with the number of new alerts. */
export function checkNewEpisodes(): Promise<number> {
  if (!getSettings().notifyEpisodes) return Promise.resolve(0);
  running ??= (async () => {
    const seen: Record<string, Seen> = read(KEY_SEEN, {});
    let added = 0;
    for (const m of followed()) {
      let d: MediaDetail;
      try {
        d = await getDetail(m.key);
      } catch {
        continue;
      }
      const before = seen[m.key];
      const { alert, seen: next } = diffShow(before, latestAired(d));
      if (next) seen[m.key] = next;
      if (!alert) continue;
      const a: Alert = { ...alert, id: `${m.key}:${alert.season ?? 0}:${alert.episode}`, key: m.key, title: d.title, poster: d.poster, backdrop: d.backdrop, at: Date.now(), read: false };
      if (alerts.some((x) => x.id === a.id)) continue;
      alerts = [a, ...alerts].slice(0, MAX_ALERTS);
      added++;
      // A show you'd finished has more now: back to Continue watching.
      reviveFinished(m.key, alert.kind === "season" ? { season: alert.season, episode: 1 } : { season: alert.season, episode: Math.min(alert.episode, (before?.episode ?? alert.episode - 1) + 1) });
      void notifyDesktop(a);
    }
    write(KEY_SEEN, seen);
    if (added) changed();
    return added;
  })().finally(() => (running = null));
  return running;
}

export function bootAlerts() {
  setTimeout(() => void checkNewEpisodes(), 20_000);
  setInterval(() => void checkNewEpisodes(), CHECK_EVERY_MS);
}
