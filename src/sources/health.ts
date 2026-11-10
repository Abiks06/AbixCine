import type { PlaybackRequest } from "../lib/types";
import type { StreamCandidate } from "./types";

/**
 * What AbixCine remembers about sources between sessions, so the picker gets smarter:
 * - per provider: how often it answered and played, and how fast (exponentially weighted);
 * - per title: which provider last played it without trouble.
 * Kept in localStorage; a few hundred bytes per provider and a line per title.
 */

export interface ProviderHealth {
  /** Successful lookups / plays and failures, decayed so old history fades. */
  ok: number;
  fail: number;
  /** EWMA of probe latency in ms. */
  latency?: number;
  lastOk?: number;
  lastFail?: number;
}

interface TitlePick {
  providerId: string;
  url: string;
  at: number;
}

const HKEY = "abx.health.v1";
const PKEY = "abx.picks.v1";
const DECAY = 0.92; // each new event shrinks old counts a little
const ALPHA = 0.3; // EWMA weight for a new latency sample
const MAX_PICKS = 400;

function read<T>(k: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "") ?? fallback;
  } catch {
    return fallback;
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full or blocked: the picker just forgets */
  }
}

let health: Record<string, ProviderHealth> = read(HKEY, {});
let picks: Record<string, TitlePick> = read(PKEY, {});

export const getHealth = (providerId: string): ProviderHealth => health[providerId] ?? { ok: 0, fail: 0 };

function bump(providerId: string, ok: boolean, latencyMs?: number) {
  const h = { ...getHealth(providerId) };
  h.ok = h.ok * DECAY + (ok ? 1 : 0);
  h.fail = h.fail * DECAY + (ok ? 0 : 1);
  if (ok) h.lastOk = Date.now();
  else h.lastFail = Date.now();
  if (ok && latencyMs != null) h.latency = h.latency == null ? latencyMs : h.latency * (1 - ALPHA) + latencyMs * ALPHA;
  health = { ...health, [providerId]: h };
  write(HKEY, health);
}

/** A probe answered (or didn't). */
export const recordProbe = (c: StreamCandidate) => c.providerId !== "manual" && bump(c.providerId, !!c.probe?.ok, c.probe?.latencyMs);
/** A provider lookup threw or timed out. */
export const recordLookupFailure = (providerId: string) => bump(providerId, false);

/** Playback outcome: the strongest signal, so it counts double. */
export function recordPlayback(req: PlaybackRequest, c: StreamCandidate, ok: boolean) {
  if (c.providerId === "manual") return;
  bump(c.providerId, ok);
  bump(c.providerId, ok);
  const k = titleKey(req);
  if (ok) {
    const pick = { providerId: c.providerId, url: c.url, at: Date.now() };
    picks = { ...picks, [k]: pick, [exactKey(req)]: pick };
    const keys = Object.keys(picks);
    if (keys.length > MAX_PICKS) {
      keys.sort((a, b) => picks[a].at - picks[b].at);
      for (const old of keys.slice(0, keys.length - MAX_PICKS)) delete picks[old];
    }
  } else {
    picks = { ...picks };
    for (const key of [k, exactKey(req)]) if (picks[key]?.url === c.url) delete picks[key];
  }
  write(PKEY, picks);
}

/** The show (not the episode) plus audio track: the provider that had E3 probably has E4. */
const titleKey = (r: PlaybackRequest) => `${r.media.key}${r.audio ? `:${r.audio}` : ""}`;
const exactKey = (r: PlaybackRequest) => `${titleKey(r)}:${r.season ?? ""}:${r.episode ?? ""}`;

export function lastPick(req: PlaybackRequest): TitlePick | undefined {
  return picks[exactKey(req)] ?? picks[titleKey(req)];
}

/** 0..1, Laplace-smoothed so a new provider starts at 0.5 instead of 0 or 1. */
export function reliability(providerId: string) {
  const h = getHealth(providerId);
  return (h.ok + 1) / (h.ok + h.fail + 2);
}

/** Failed in the last 10 minutes? Then it's probably still down. */
export function recentlyFailed(providerId: string) {
  const h = getHealth(providerId);
  return !!h.lastFail && Date.now() - h.lastFail < 10 * 60_000 && (!h.lastOk || h.lastOk < h.lastFail);
}

/** How long to wait for a provider: generous for new ones, tighter for ones we know are quick. */
export function lookupTimeout(providerId: string, base: number) {
  const l = getHealth(providerId).latency;
  if (l == null) return base;
  return Math.round(Math.max(2500, Math.min(base, l * 6 + 1500)));
}

export function resetHealth() {
  health = {};
  picks = {};
  write(HKEY, health);
  write(PKEY, picks);
}

export const healthSnapshot = () => ({ ...health });
