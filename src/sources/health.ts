import type { PlaybackRequest } from "../lib/types";
import { isUrlTokenExpired } from "./native";
import type { StreamCandidate } from "./types";

/**
 * What AbixCine remembers about sources between sessions, so the picker gets smarter:
 * - per provider: how often it answered and played, how fast (exponentially weighted),
 *   consecutive failure streak, and circuit-breaker cooldown;
 * - per title: which provider last played it without trouble.
 * Kept in localStorage; a few hundred bytes per provider and a line per title.
 */

export interface ProviderHealth {
  /** Successful lookups / plays and failures, decayed so old history fades. */
  ok: number;
  fail: number;
  /** EWMA of probe latency in ms (how fast a stream answers). */
  latency?: number;
  /** Alias for `latency` (EWMA of probe latency in ms). */
  latencyMs?: number;
  /** EWMA of how long find() takes (a search, not a probe; can be much slower). */
  lookupMs?: number;
  lastOk?: number;
  lastFail?: number;
  /** Consecutive failures/timeouts without an intervening success. */
  streak?: number;
  /** Epoch ms until which the circuit breaker deprioritizes this provider. */
  circuitUntil?: number;
}

export interface TitlePick {
  providerId: string;
  url: string;
  at: number;
}

const HKEY = "abx.health.v1";
const PKEY = "abx.picks.v1";
const BKEY = "abx.badurls.v1";
/** A specific file/stream that failed to play is penalised for a day, without blaming its whole provider. */
const BAD_URL_MS = 24 * 3600_000;
/** Cached stream URLs expire quickly because CDN tokens rotate; never replay stale URLs blindly. */
export const STREAM_URL_TTL_MS = 2 * 3600_000;
/** Provider-level affinity for a title expires after 7 days. */
const PICK_TTL_MS = 7 * 24 * 3600_000;
const MAX_BAD = 200;
const DECAY = 0.92; // each new event shrinks old counts a little
const ALPHA = 0.3; // EWMA weight for a new latency sample
const MAX_PICKS = 400;

/** Consecutive failures required to trip the circuit breaker. */
export const CIRCUIT_STREAK_THRESHOLD = 3;
const CIRCUIT_BASE_MS = 2 * 60_000;
const CIRCUIT_MAX_MS = 30 * 60_000;

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
let badUrls: Record<string, number> = read(BKEY, {});

export const getHealth = (providerId: string): ProviderHealth => {
  const raw = health[providerId];
  if (!raw) return { ok: 0, fail: 0 };
  const lat = raw.latencyMs ?? raw.latency;
  return lat != null ? { ...raw, latency: lat, latencyMs: lat } : raw;
};

function bump(providerId: string, ok: boolean, latencyMs?: number) {
  const h = { ...getHealth(providerId) };
  const now = Date.now();
  h.ok = h.ok * DECAY + (ok ? 1 : 0);
  h.fail = h.fail * DECAY + (ok ? 0 : 1);
  const prevLat = h.latencyMs ?? h.latency;
  if (ok) {
    h.lastOk = now;
    h.streak = 0;
    delete h.circuitUntil;
    if (latencyMs != null) {
      const nextLat = prevLat == null ? latencyMs : prevLat * (1 - ALPHA) + latencyMs * ALPHA;
      h.latency = nextLat;
      h.latencyMs = nextLat;
    }
  } else {
    h.lastFail = now;
    h.streak = (h.streak ?? 0) + 1;
    if (latencyMs != null && latencyMs > 0) {
      const penalty = Math.max(latencyMs, 4000);
      const nextLat = prevLat == null ? penalty : prevLat * (1 - ALPHA * 0.5) + penalty * (ALPHA * 0.5);
      h.latency = nextLat;
      h.latencyMs = nextLat;
    }
    if (h.streak >= CIRCUIT_STREAK_THRESHOLD) {
      const exp = Math.min(4, h.streak - CIRCUIT_STREAK_THRESHOLD);
      const cooldown = Math.min(CIRCUIT_MAX_MS, CIRCUIT_BASE_MS * Math.pow(2, exp));
      h.circuitUntil = now + cooldown;
    }
  }
  health = { ...health, [providerId]: h };
  write(HKEY, health);
}

/** Is the circuit breaker currently open (tripped) for this provider? */
export function isCircuitOpen(providerId: string): boolean {
  const h = getHealth(providerId);
  return !!h.circuitUntil && Date.now() < h.circuitUntil;
}

/** Remaining cooldown in ms while a provider's circuit breaker is open (0 when closed). */
export function circuitRemainingMs(providerId: string): number {
  const h = getHealth(providerId);
  return h.circuitUntil ? Math.max(0, h.circuitUntil - Date.now()) : 0;
}

/** A probe answered (or didn't). */
export function recordProbe(c: StreamCandidate) {
  if (c.providerId === "manual") return;
  const ok = !!c.probe?.ok;
  bump(c.providerId, ok, c.probe?.latencyMs);
  if (!ok) {
    let changed = false;
    const next = { ...picks };
    for (const [k, pick] of Object.entries(next)) {
      if (pick.url === c.url || (pick.providerId === c.providerId && isCircuitOpen(c.providerId))) {
        delete next[k];
        changed = true;
      }
    }
    if (changed) {
      picks = next;
      write(PKEY, picks);
    }
  }
}

/** A provider lookup threw or timed out. */
export const recordLookupFailure = (providerId: string, elapsedMs?: number) => bump(providerId, false, elapsedMs);

/** How long a successful lookup took, so its timeout is based on searches, not on stream probes. */
export function recordLookup(providerId: string, ms: number) {
  const h = { ...getHealth(providerId) };
  h.lookupMs = h.lookupMs == null ? ms : h.lookupMs * (1 - ALPHA) + ms * ALPHA;
  health = { ...health, [providerId]: h };
  write(HKEY, health);
}

/** This exact URL failed to play recently (a file the player can't decode, a dead link). */
export function badUrl(url: string) {
  const at = badUrls[url];
  return !!at && Date.now() - at < BAD_URL_MS;
}

/**
 * True when a cached stream URL is known bad, has an expired token, or is older than
 * STREAM_URL_TTL_MS and must be re-validated/refreshed before playback.
 */
export function isStaleStreamUrl(url: string, savedAt?: number): boolean {
  if (!url) return true;
  if (badUrl(url) || isUrlTokenExpired(url)) return true;
  if (savedAt != null && Date.now() - savedAt > STREAM_URL_TTL_MS) return true;
  return false;
}

/** Playback outcome: the strongest signal, so it counts double. */
export function recordPlayback(req: PlaybackRequest, c: StreamCandidate, ok: boolean) {
  if (c.providerId === "manual") return;
  bump(c.providerId, ok, c.probe?.latencyMs);
  bump(c.providerId, ok, c.probe?.latencyMs);
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
    for (const key of [k, exactKey(req)]) {
      if (picks[key]?.url === c.url || picks[key]?.providerId === c.providerId) delete picks[key];
    }
    const now = Date.now();
    badUrls = Object.fromEntries(
      Object.entries({ ...badUrls, [c.url]: now })
        .filter(([, at]) => now - at < BAD_URL_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_BAD),
    );
    write(BKEY, badUrls);
  }
  if (ok && badUrls[c.url]) {
    const { [c.url]: _, ...rest } = badUrls;
    badUrls = rest;
    write(BKEY, badUrls);
  }
  write(PKEY, picks);
}

/** The show (not the episode) plus audio track: the provider that had E3 probably has E4. */
const titleKey = (r: PlaybackRequest) => `${r.media.key}${r.audio ? `:${r.audio}` : ""}`;
const exactKey = (r: PlaybackRequest) => `${titleKey(r)}:${r.season ?? ""}:${r.episode ?? ""}`;

export function lastPick(req: PlaybackRequest): TitlePick | undefined {
  const now = Date.now();
  for (const key of [exactKey(req), titleKey(req)]) {
    const pick = picks[key];
    if (!pick) continue;
    if (now - pick.at > PICK_TTL_MS || badUrl(pick.url) || isCircuitOpen(pick.providerId)) continue;
    return pick;
  }
  return undefined;
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

/**
 * Composite server health score combining base priority, Laplace reliability,
 * EWMA latency, recent failure penalty, and circuit-breaker state.
 */
export function serverHealthScore(providerId: string, basePriority = 0): number {
  const h = getHealth(providerId);
  const rel = (reliability(providerId) - 0.5) * 16;
  const lat = h.latencyMs ?? h.latency;
  const hasTiming = lat != null || h.lookupMs != null;
  const rtt = (lat ?? 1500) + (h.lookupMs ?? 0);
  const speed = hasTiming ? Math.max(-8, 12 - rtt / 400) : 0;
  const recentFail = recentlyFailed(providerId) ? -12 : 0;
  const circuitPenalty = isCircuitOpen(providerId) ? -45 : 0;
  return basePriority + rel + speed + recentFail + circuitPenalty;
}

/**
 * How long to wait for a provider's search: generous for new ones and right after a failure
 * (so a slow-but-healthy provider can recover), tighter for ones we know are quick.
 */
export function lookupTimeout(providerId: string, base: number) {
  const h = getHealth(providerId);
  if (h.lookupMs == null || recentlyFailed(providerId)) return base;
  return Math.round(Math.max(2500, Math.min(base, h.lookupMs * 3 + 1500)));
}

export function resetHealth() {
  health = {};
  picks = {};
  badUrls = {};
  write(HKEY, health);
  write(PKEY, picks);
  write(BKEY, badUrls);
}

export const healthSnapshot = () => ({ ...health });
