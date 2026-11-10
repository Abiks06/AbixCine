import { getSettings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import { jellyfinProvider } from "./jellyfin";
import { localProvider } from "./local";
import type { SourceProvider, StreamCandidate } from "./types";

/** All known providers. Register new ones here. */
export const PROVIDERS: SourceProvider[] = [localProvider, jellyfinProvider];

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
function hlsMaxHeight(manifest: string) {
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
    if (c.kind === "hls") quality = hlsMaxHeight(await res.text()) ?? quality;
    else ctl.abort(); // don't download the file
    return { ...c, quality, probe: { ok: true, latencyMs: Math.round(performance.now() - t0), quality } };
  } catch (e: any) {
    return { ...c, probe: { ok: false, latencyMs: Math.round(performance.now() - t0), error: e?.message ?? "failed" } };
  }
}

/**
 * Score: reachable first, then closeness to preferred quality, then response time,
 * then provider priority. Tuned so a 1080p local file beats a 1080p server stream,
 * and a reachable 720p beats an unreachable 4K.
 */
function score(c: StreamCandidate, preferred: number, priority: number) {
  if (!c.probe?.ok) return -1000 + priority;
  const q = c.probe.quality ?? c.quality ?? 720;
  const qScore = q <= preferred ? q / preferred : 1 - (q - preferred) / (preferred * 4); // overshoot is mildly penalised
  const latency = Math.min(c.probe.latencyMs, 3000) / 3000;
  return qScore * 60 - latency * 25 + priority * 0.5;
}

/**
 * Ask every enabled provider in parallel, probe what they return, and rank it.
 * `onEvent` streams per-provider status so the UI can show progress.
 */
export async function resolveSources(req: PlaybackRequest, onEvent?: (e: ResolveEvent) => void): Promise<StreamCandidate[]> {
  const s = getSettings();
  const enabled = PROVIDERS.filter((p) => p.isEnabled(s));
  const results = await Promise.all(
    enabled.map(async (p) => {
      onEvent?.({ providerId: p.id, status: "searching" });
      const ctl = new AbortController();
      try {
        const found = await withTimeout(p.find(req, s, ctl.signal), PROVIDER_TIMEOUT, ctl);
        onEvent?.({ providerId: p.id, status: "done", count: found.length });
        return found;
      } catch (e: any) {
        const timeout = e?.message === "timeout";
        onEvent?.({ providerId: p.id, status: timeout ? "timeout" : "error", error: e?.message });
        return [];
      }
    }),
  );
  const probed = await Promise.all(results.flat().map(probe));
  const prio = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.priority]));
  return probed
    .map((c) => ({ ...c, score: score(c, s.preferredQuality, prio[c.providerId] ?? 0) }))
    .sort((a, b) => b.score! - a.score!);
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
  return Math.max(1, Math.min(99, Math.round((c.score / 75) * 100)));
}

/** "2160p · 2 ms · 98" style line for a candidate. */
export function candLine(c: StreamCandidate) {
  if (c.probe && !c.probe.ok) return c.probe.error === "timeout" ? "timed out" : "offline";
  const q = c.probe?.quality ?? c.quality;
  return [q ? `${q}p` : null, c.probe ? `${c.probe.latencyMs} ms` : null, c.score != null ? String(displayScore(c)) : null].filter(Boolean).join(" · ");
}
