import { getSettings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import { jellyfinProvider } from "./jellyfin";
import { badUrl, getHealth, lastPick, lookupTimeout, recentlyFailed, recordLookup, recordLookupFailure, recordProbe, reliability } from "./health";
import { localProvider } from "./local";
import { mockProviders } from "./mock";
import type { SourceProvider, StreamCandidate } from "./types";

/** All known providers. Register new ones here. */
export const PROVIDERS: SourceProvider[] = [localProvider, jellyfinProvider, ...mockProviders];

export { recordPlayback } from "./health";

const PROVIDER_TIMEOUT = 8000;
const PROBE_TIMEOUT = 5000;

export interface ResolveEvent {
  providerId: string;
  status: "searching" | "done" | "error" | "timeout";
  count?: number;
  error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, ctl: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ctl.abort();
      reject(new Error("timeout"));
    }, ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/** Highest RESOLUTION=WxH in a master playlist, or undefined. */
export function hlsMaxHeight(manifest: string) {
  let best: number | undefined;
  for (const m of manifest.matchAll(/RESOLUTION=\d+x(\d+)/g)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

/**
 * Check a candidate is reachable and how fast it answers. For HLS we read the
 * manifest (also gives the real top resolution); for files we request the first byte.
 */
async function probe(c: StreamCandidate): Promise<StreamCandidate> {
  const ctl = new AbortController();
  const t0 = performance.now();
  try {
    const res = await withTimeout(
      fetch(c.url, { signal: ctl.signal, headers: c.kind === "file" ? { Range: "bytes=0-1" } : {} }),
      PROBE_TIMEOUT,
      ctl,
    );
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    let quality = c.quality;
    // The body read gets its own deadline: a server that sends headers then stalls mustn't hang the race.
    if (c.kind === "hls") quality = hlsMaxHeight(await withTimeout(res.text(), PROBE_TIMEOUT, ctl)) ?? quality;
    else ctl.abort(); // don't download the file
    return { ...c, quality, probe: { ok: true, latencyMs: Math.round(performance.now() - t0), quality } };
  } catch (e: unknown) {
    return { ...c, probe: { ok: false, latencyMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : "failed" } };
  }
}

/**
 * Score a candidate. In order of weight:
 *  - reachable at all (an unreachable 4K never beats a reachable 720p);
 *  - closeness to the preferred quality (overshoot is mildly penalised);
 *  - track record: how often this provider answered and played before;
 *  - memory: it played this title (or this exact episode) last time;
 *  - speed: this probe's latency blended with the provider's average;
 *  - provider priority (local files beat a server stream at the same quality);
 *  - this exact file failed to play in the last day (e.g. a codec the player can't decode).
 */
export function score(c: StreamCandidate, preferred: number, priority: number, req: PlaybackRequest): StreamCandidate {
  if (!c.probe?.ok) return { ...c, score: -1000 + priority, why: [] };
  const q = c.probe.quality ?? c.quality ?? 720;
  const qScore = q <= preferred ? q / preferred : 1 - (q - preferred) / (preferred * 4);
  const avg = getHealth(c.providerId).latency;
  const ms = avg == null ? c.probe.latencyMs : c.probe.latencyMs * 0.6 + avg * 0.4;
  const latency = Math.min(ms, 3000) / 3000;
  const rel = reliability(c.providerId);
  const pick = lastPick(req);
  const memory = pick ? (pick.url === c.url ? 12 : pick.providerId === c.providerId ? 6 : 0) : 0;
  const shaky = recentlyFailed(c.providerId) ? 12 : 0;
  const broken = badUrl(c.url) ? 40 : 0;
  const why: string[] = [];
  if (memory) why.push(pick!.url === c.url ? "played last time" : "had this show before");
  if (rel > 0.8 && getHealth(c.providerId).ok > 3) why.push("reliable");
  if (shaky) why.push("failed recently");
  if (broken) why.push("wouldn't play last time");
  return { ...c, why, score: qScore * 60 - latency * 25 + (rel - 0.5) * 30 + memory - shaky - broken + priority * 0.5 };
}

const sortByScore = (a: StreamCandidate, b: StreamCandidate) => b.score! - a.score!;

export interface ResolveOptions {
  /** Called with the full ranked list each time a probe lands (including after the promise resolved). */
  onUpdate?: (ranked: StreamCandidate[]) => void;
  /**
   * Resolve as soon as there is a confident pick instead of waiting for every source:
   * good quality, quick, from a provider that hasn't been failing. Slower sources keep
   * racing in the background and arrive through onUpdate as backup servers.
   */
  early?: boolean;
  signal?: AbortSignal;
  /** Learn from this race (health stats). Off for previews, so a title visit + Play doesn't count twice. */
  record?: boolean;
}

/** After a confident pick appears, give the others this long to beat it. */
const GRACE_MS = 350;
/** Longer grace when a better pick may still be coming (last time's source, or the 4K you asked for). */
const PATIENT_GRACE_MS = 1200;
/** If anything playable exists by now, go with the best so far. */
const SOFT_DEADLINE_MS = 2500;

/**
 * Ask every enabled provider in parallel, probe what each returns as soon as it returns
 * it, and rank everything. `onEvent` streams per-provider status so the UI can show the race.
 */
export function resolveSources(req: PlaybackRequest, onEvent?: (e: ResolveEvent) => void, opts: ResolveOptions = {}): Promise<StreamCandidate[]> {
  const s = getSettings();
  const enabled = PROVIDERS.filter((p) => p.isEnabled(s));
  const prio = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.priority]));
  const seen = new Set<string>();
  const record = opts.record !== false;
  const pick = lastPick(req);
  const pending = new Set(enabled.map((p) => p.id));
  /** Probes count once per provider per race, so a provider returning 3 files doesn't get 3 votes. */
  const probed = new Set<string>();
  let raw: StreamCandidate[] = [];
  let ranked: StreamCandidate[] = [];
  let settled = false;

  return new Promise((resolve) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(softTimer);
      resolve(ranked);
    };
    const confident = (c: StreamCandidate) =>
      !!c.probe?.ok &&
      (c.probe.quality ?? c.quality ?? 720) >= Math.min(s.preferredQuality, 1080) &&
      c.probe.latencyMs < 800 &&
      !recentlyFailed(c.providerId) &&
      !badUrl(c.url) &&
      reliability(c.providerId) >= 0.45;
    const graceFor = (c: StreamCandidate) => {
      const q = c.probe?.quality ?? c.quality ?? 720;
      const waitingForPick = !!pick && pick.url !== c.url && pending.has(pick.providerId);
      return waitingForPick || q < s.preferredQuality ? PATIENT_GRACE_MS : GRACE_MS;
    };
    const add = (c: StreamCandidate) => {
      if (opts.signal?.aborted) return;
      if (record && !probed.has(c.providerId)) {
        probed.add(c.providerId);
        recordProbe(c);
      }
      raw = [...raw, c];
      // Re-score everyone: health may have changed since earlier candidates arrived.
      ranked = raw.map((x) => score(x, s.preferredQuality, prio[x.providerId] ?? 0, req)).sort(sortByScore);
      opts.onUpdate?.(ranked);
      if (opts.early && !settled && !graceTimer && confident(c)) graceTimer = setTimeout(finish, graceFor(c));
    };
    const softTimer = setTimeout(() => opts.early && ranked.some((c) => c.probe?.ok) && finish(), SOFT_DEADLINE_MS);

    const runs = enabled.map(async (p) => {
      onEvent?.({ providerId: p.id, status: "searching" });
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let found: StreamCandidate[];
      const t0 = performance.now();
      try {
        found = await withTimeout(p.find(req, s, ctl.signal), lookupTimeout(p.id, PROVIDER_TIMEOUT), ctl);
        if (record) recordLookup(p.id, performance.now() - t0);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!opts.signal?.aborted && record) recordLookupFailure(p.id);
        onEvent?.({ providerId: p.id, status: msg === "timeout" ? "timeout" : "error", error: msg });
        return;
      } finally {
        pending.delete(p.id);
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const fresh = found.filter((c) => !seen.has(c.url) && (seen.add(c.url), true));
      onEvent?.({ providerId: p.id, status: "done", count: fresh.length });
      await Promise.all(fresh.map((c) => probe(c).then(add)));
    });
    Promise.all(runs).then(finish);
  });
}

/** A stream URL the user pasted (their own server, a public-domain file, etc.). */
export function manualCandidate(url: string): StreamCandidate {
  return {
    providerId: "manual",
    providerName: "Direct link",
    label: url.split("/").pop()?.split("?")[0] || url,
    url,
    kind: /\.m3u8(\?|$)/i.test(url) ? "hls" : "file",
  };
}

/** 0–100 for display: how good a pick this is (quality fit, speed, provider priority). */
export function displayScore(c: StreamCandidate) {
  if (!c.probe?.ok || c.score == null) return 0;
  return Math.max(1, Math.min(99, Math.round((c.score / 80) * 100)));
}

/** "2160p · 2 ms · 98" style line for a candidate. */
export function candLine(c: StreamCandidate) {
  if (c.probe && !c.probe.ok) return c.probe.error === "timeout" ? "timed out" : "offline";
  const q = c.probe?.quality ?? c.quality;
  return [q ? `${q}p` : null, c.probe ? `${c.probe.latencyMs} ms` : null, c.score != null ? String(displayScore(c)) : null].filter(Boolean).join(" · ");
}
