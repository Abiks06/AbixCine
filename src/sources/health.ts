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
  /** EWMA of probe latency in ms (how fast a stream answers). */
  latency?: number;
  /** EWMA of how long find() takes (a search, not a probe; can be much slower). */
  lookupMs?: number;
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
const BKEY = "abx.badurls.v1";
/** A specific file/stream that failed to play is penalised for a day, without blaming its whole provider. */
const BAD_URL_MS = 24 * 3600_000;
const MAX_BAD = 200;
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
let badUrls: Record<string, number> = read(BKEY, {});

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

export type ProviderState = "healthy" | "degraded" | "down" | "new";

/**
 * One word for how a provider has been doing, for the player's status panel:
 * - down: failed in the last 10 minutes and hasn't worked since;
 * - new: not enough history to say;
 * - degraded: answers, but fails often or slowly;
 * - healthy: everything else.
 */
export function providerStatus(providerId: string): { state: ProviderState; reliability: number; latency?: number } {
  const h = getHealth(providerId);
  const rel = reliability(providerId);
  const latency = h.latency == null ? undefined : Math.round(h.latency);
  if (recentlyFailed(providerId)) return { state: "down", reliability: rel, latency };
  if (h.ok + h.fail < 1) return { state: "new", reliability: rel, latency };
  if (rel < 0.6 || (latency ?? 0) > 1500) return { state: "degraded", reliability: rel, latency };
  return { state: "healthy", reliability: rel, latency };
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
