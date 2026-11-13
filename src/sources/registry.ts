import { getSettings } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import type { Settings } from "../lib/settings";
import { animeDirectProvider } from "./anime-direct";
import { jellyfinProvider } from "./jellyfin";
import {
  badUrl,
  getHealth,
  isCircuitOpen,
  isStaleStreamUrl,
  lastPick,
  lookupTimeout,
  recentlyFailed,
  recordLookup,
  recordLookupFailure,
  recordProbe,
  reliability,
  serverHealthScore,
} from "./health";
import { kisskhProvider } from "./kisskh";
import { localProvider } from "./local";
import { isUrlTokenExpired, native, normalizeHeaders, proxyUrl, sniff } from "./native";
import { availableSources, embedProviders } from "./embeds";
import { inferSniffedSubtitles, type HedgedProbeOptions, type ManifestValidation, type SourceProvider, type StreamCandidate, type VideoSource } from "./types";

/** All known providers. Register new ones here. */
export const PROVIDERS: SourceProvider[] = [localProvider, jellyfinProvider, animeDirectProvider, kisskhProvider, ...embedProviders];

/** Providers with their own entry in Settings → Servers (besides the embed list). */
export const DIRECT_SOURCES = [
  { id: "hianime", name: "HiAnime", note: "Anime · direct stream with sub/dub, subtitles and intro skip" },
  { id: "kisskh", name: "KissKH", note: "Asian dramas and films · subtitled" },
];

export { availableSources, embedProviders };
export type { VideoSource, ManifestValidation, HedgedProbeOptions };

export { recordPlayback, isCircuitOpen, serverHealthScore, isStaleStreamUrl } from "./health";

const PROVIDER_TIMEOUT = 8000;
const PROBE_TIMEOUT = 6000;
/** Capturing a stream from an embed page: load, start, catch the playlist. Most succeed in 4–10 s. */
const SNIFF_TIMEOUT = 10_000;
/** If initial concurrent probes haven't yielded a winner after this delay, launch hedged backup probes. */
const HEDGE_DELAY_MS = 2500;

/**
 * Which servers have worked lately, per kind of title (movie / tv / anime). Servers are tried
 * in this learned order, so the ones that keep delivering are checked first and the race ends sooner.
 */
const WINS_KEY = "abx.serverWins.v1";
type Wins = Record<string, { ok: number; n: number; last?: number }>;
let wins: Wins = (() => {
  try {
    return JSON.parse(localStorage.getItem(WINS_KEY) ?? "{}");
  } catch {
    return {};
  }
})();
export function recordWin(providerId: string, kind: string, ok: boolean) {
  const k = `${providerId}:${kind}`;
  const w = wins[k] ?? { ok: 0, n: 0 };
  // Decay old history so a server that recovers (or breaks) moves quickly.
  wins = { ...wins, [k]: { ok: w.ok * 0.85 + (ok ? 1 : 0), n: w.n * 0.85 + 1, last: ok ? Date.now() : w.last } };
  try {
    localStorage.setItem(WINS_KEY, JSON.stringify(wins));
  } catch {
    /* ignore */
  }
}
/** Base priority plus learned success and health circuit-breaker state for this kind of title. */
function learnedRank(providerId: string, kind: string, base: number) {
  const healthBase = serverHealthScore(providerId, base);
  const w = wins[`${providerId}:${kind}`];
  if (!w) return healthBase;
  const rate = (w.ok + 1) / (w.n + 2);
  const recent = w.last && Date.now() - w.last < 3 * 86400_000 && !recentlyFailed(providerId) && !isCircuitOpen(providerId) ? 3 : 0;
  return healthBase + rate * 12 - 6 + recent;
}

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

function linkSignal(parent?: AbortSignal): { ctl: AbortController; cleanup: () => void } {
  const ctl = new AbortController();
  if (!parent) return { ctl, cleanup: () => {} };
  if (parent.aborted) {
    ctl.abort();
    return { ctl, cleanup: () => {} };
  }
  const onAbort = () => ctl.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return { ctl, cleanup: () => parent.removeEventListener("abort", onAbort) };
}

/** Highest RESOLUTION=WxH in a master playlist, or undefined. */
export function hlsMaxHeight(manifest: string) {
  let best: number | undefined;
  for (const m of manifest.matchAll(/RESOLUTION=\d+x(\d+)/g)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

const HTML_OR_CAPTCHA_RX =
  /(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|cf-browser-verification|challenge-platform|cf-chl-opt|turnstile|g-recaptcha|hcaptcha|attention required!\s*\|\s*cloudflare|access denied|403 forbidden|token expired|stream expired)/i;
const BAD_SEGMENT_RX = /(?:^|[\/_.-])(?:404|error|expired|denied|captcha|blank)\.(?:ts|m4s|mp4)(?:\?|$)/i;

/**
 * Validate that an HTTP response body is a genuine, playable HLS (.m3u8) or DASH (.mpd)
 * manifest with valid variant playlists or media segments—never an HTML error page,
 * Cloudflare/captcha challenge, or expired token URL.
 */
export function validateManifest(text: string, url?: string, contentType?: string): ManifestValidation {
  if (url && isUrlTokenExpired(url)) {
    return { ok: false, error: "token expired" };
  }
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return { ok: false, error: "empty playlist" };
  }
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || HTML_OR_CAPTCHA_RX.test(trimmed.slice(0, 2048))) {
    return { ok: false, error: "HTML or captcha response" };
  }
  if (/^\s*\{[\s\S]*"(?:error|message|status)"\s*:/i.test(trimmed.slice(0, 512))) {
    return { ok: false, error: "API error response" };
  }

  // DASH (.mpd) manifest validation
  const isDash = ct.includes("dash+xml") || (url && /\.mpd(\?|$)/i.test(url)) || /^<\?xml[\s\S]*<MPD[\s>]|^<MPD[\s>]/i.test(trimmed);
  if (isDash) {
    if (!/<MPD[\s>]/i.test(trimmed) || !/<\/MPD>/i.test(trimmed)) {
      return { ok: false, error: "invalid DASH manifest" };
    }
    if (!/<Period[\s>]/i.test(trimmed) || !/<AdaptationSet[\s>]/i.test(trimmed) || !/<Representation[\s>]/i.test(trimmed)) {
      return { ok: false, error: "empty DASH manifest" };
    }
    if (!/<(?:SegmentTemplate|SegmentList|SegmentBase|BaseURL)[\s>]/i.test(trimmed)) {
      return { ok: false, error: "no DASH segments" };
    }
    let quality: number | undefined;
    for (const m of trimmed.matchAll(/\bheight="(\d+)"/gi)) {
      quality = Math.max(quality ?? 0, Number(m[1]));
    }
    return { ok: true, kind: "dash", quality, segmentCount: 1 };
  }

  // HLS (.m3u8) manifest validation
  if (!trimmed.startsWith("#EXTM3U")) {
    return { ok: false, error: "not a playlist" };
  }
  if (/^#EXT-X-ERROR:/m.test(trimmed)) {
    return { ok: false, error: "manifest error tag" };
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let variantCount = 0;
  let segmentCount = 0;
  let expectVariantUri = false;
  let expectSegmentUri = false;

  for (const line of lines) {
    if (line.startsWith("#")) {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        expectVariantUri = true;
      } else if (line.startsWith("#EXTINF:")) {
        const dur = Number(line.slice(8).split(",")[0].trim());
        if (Number.isFinite(dur) && dur > 0) {
          expectSegmentUri = true;
        }
      }
      continue;
    }
    if (/^(?:javascript:|data:text\/html|<)/i.test(line) || /\.html?(\?|$)/i.test(line)) {
      return { ok: false, error: "invalid URI in playlist" };
    }
    let resolvedUri = line;
    if (url) {
      try {
        resolvedUri = new URL(line, url).toString();
      } catch {
        /* keep raw line */
      }
    }
    if (isUrlTokenExpired(resolvedUri)) {
      return { ok: false, error: "token expired" };
    }
    if (expectVariantUri) {
      variantCount++;
      expectVariantUri = false;
    } else if (expectSegmentUri) {
      if (BAD_SEGMENT_RX.test(line)) {
        return { ok: false, error: "error segment in playlist" };
      }
      segmentCount++;
      expectSegmentUri = false;
    }
  }

  if (variantCount === 0 && segmentCount === 0) {
    return { ok: false, error: "empty playlist" };
  }

  return {
    ok: true,
    kind: "hls",
    quality: hlsMaxHeight(trimmed),
    hasVariants: variantCount > 0,
    segmentCount,
  };
}

/**
 * Turn an embed into a direct stream by capturing what its page plays. Success is the proof
 * the title is really there.
 */
export async function verifyEmbed(c: StreamCandidate, signal?: AbortSignal): Promise<StreamCandidate> {
  const t0 = performance.now();
  const page = c.pageUrl ?? c.url;
  if (signal?.aborted) {
    return { ...c, pageUrl: page, probe: { ok: false, latencyMs: 0, error: "AbortError" } };
  }
  const got = await sniff(page, SNIFF_TIMEOUT, signal).catch(() => null);
  const latencyMs = Math.round(performance.now() - t0);
  if (!got) {
    return {
      ...c,
      pageUrl: page,
      probe: { ok: false, latencyMs, error: signal?.aborted ? "AbortError" : "no stream" },
    };
  }
  if (isUrlTokenExpired(got.url)) {
    return {
      ...c,
      pageUrl: page,
      probe: { ok: false, latencyMs, error: "token expired" },
    };
  }
  const headers = normalizeHeaders({ ...c.headers, ...got.headers }, page);
  const direct: StreamCandidate = {
    ...c,
    url: proxyUrl(got.url, headers, page),
    kind: got.kind === "mp4" ? "file" : got.kind === "dash" ? "dash" : "hls",
    via: "sniffed",
    pageUrl: page,
    headers,
    subtitles: inferSniffedSubtitles(got.subtitles, (u) => proxyUrl(u, headers, page)),
  };
  // The playlist was already fetched and checked in Rust (warming the connection and leaving it
  // cached for the player); files get a quick header check. The player's watchdog is the final test.
  const check =
    got.verified != null
      ? { ok: got.verified, quality: got.quality ?? undefined, error: got.verified ? undefined : "refused" }
      : await quickCheck(direct, signal);
  const total = Math.round(performance.now() - t0);
  if (!check.ok) return { ...c, pageUrl: page, probe: { ok: false, latencyMs: total, error: check.error ?? "won't play" } };
  return { ...direct, quality: check.quality ?? direct.quality, probe: { ok: true, latencyMs, quality: check.quality ?? direct.quality } };
}

const QUICK_CHECK_MS = 5000;

/**
 * Reachability and manifest readiness check used during the race: an HLS/DASH stream must
 * answer with a valid, non-expired manifest containing real variants or segments, and a
 * progressive file must answer with real video header bytes.
 */
export async function quickCheck(c: StreamCandidate, signal?: AbortSignal): Promise<{ ok: boolean; quality?: number; error?: string }> {
  if (c.kind === "embed") return { ok: true };
  if (isUrlTokenExpired(c.url)) return { ok: false, error: "token expired" };
  if (c.kind === "file") return playCheck(c, signal);
  const { ctl, cleanup } = linkSignal(signal);
  const timer = setTimeout(() => ctl.abort(), QUICK_CHECK_MS);
  try {
    const res = await fetchRetry(c.url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    const validation = validateManifest(text, res.url || c.url, res.headers?.get?.("content-type") ?? undefined);
    if (!validation.ok) return { ok: false, error: validation.error ?? "not a playlist" };
    return { ok: true, quality: validation.quality };
  } catch (e: unknown) {
    if (signal?.aborted) return { ok: false, error: "AbortError" };
    if (e instanceof Error && e.name === "AbortError") return { ok: false, error: "timeout" };
    return { ok: false, error: e instanceof Error ? e.message : "failed" };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

/** Real video bytes? MPEG-TS sync, an MP4 / fragmented-MP4 box, an ID3-tagged TS, or ADTS audio. */
export function looksLikeMedia(b: Uint8Array) {
  if (b.length < 8) return false;
  if (b[0] === 0x47 && (b.length < 377 || (b[188] === 0x47 && b[376] === 0x47))) return true;
  const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (["ftyp", "moof", "styp", "sidx", "moov", "mdat", "emsg", "free", "prft"].includes(box)) return true;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // ID3
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return true; // ADTS AAC
  return false;
}

const PLAY_CHECK_MS = 9000;

/** Fetch with one retry on a host's temporary refusals (busy, rate limited), after a short pause. */
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (![429, 500, 502, 503, 504].includes(res.status)) return res;
  res.body?.cancel().catch(() => {});
  const signal = init.signal;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 1200);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return fetch(url, init);
}

async function readHead(url: string, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await fetchRetry(url, { signal, headers: { Range: "bytes=0-65535" } });
  if (!res.ok && res.status !== 206) return { status: res.status, bytes: new Uint8Array() };
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()).slice(0, 65536) };
  // Some hosts ignore Range: stop after 64 KB instead of downloading the whole segment.
  const parts: Uint8Array[] = [];
  let n = 0;
  while (n < 65536) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(value);
    n += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return { status: res.status, bytes: out };
}

const firstUri = (playlist: string) => playlist.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));

/**
 * Prove a stream plays: for HLS, master playlist → a variant → its first segment, and that
 * segment's bytes must be video (or, for AES-encrypted streams, a real non-empty segment);
 * for DASH, valid MPD structure; for files, the first bytes must be an MP4/WebM/TS header.
 */
export async function playCheck(c: StreamCandidate, signal?: AbortSignal): Promise<{ ok: boolean; quality?: number; error?: string }> {
  if (isUrlTokenExpired(c.url)) return { ok: false, error: "token expired" };
  const { ctl, cleanup } = linkSignal(signal);
  const timer = setTimeout(() => ctl.abort(), PLAY_CHECK_MS);
  try {
    if (c.kind === "file") {
      const { status, bytes } = await readHead(c.url, ctl.signal);
      const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
      return looksLikeMedia(bytes) || webm ? { ok: true } : { ok: false, error: status >= 400 ? `HTTP ${status}` : "not a video file" };
    }
    if (c.kind !== "hls" && c.kind !== "dash") return { ok: true };
    const res = await fetchRetry(c.url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let text = await res.text();
    const validation = validateManifest(text, res.url || c.url, res.headers?.get?.("content-type") ?? undefined);
    if (!validation.ok) return { ok: false, error: validation.error ?? "not a playlist" };
    if (validation.kind === "dash") return { ok: true, quality: validation.quality };
    const quality = validation.quality;
    let base = res.url || c.url;
    if (text.includes("#EXT-X-STREAM-INF")) {
      const variant = firstUri(text);
      if (!variant) return { ok: false, error: "empty playlist" };
      const vu = new URL(variant, base).toString();
      const vr = await fetchRetry(vu, { signal: ctl.signal });
      if (!vr.ok) return { ok: false, error: `variant HTTP ${vr.status}` };
      text = await vr.text();
      const varValidation = validateManifest(text, vr.url || vu, vr.headers?.get?.("content-type") ?? undefined);
      if (!varValidation.ok) return { ok: false, error: varValidation.error ?? "invalid variant playlist" };
      base = vr.url || vu;
    }
    const seg = firstUri(text);
    if (!seg) return { ok: false, error: "no segments" };
    const encrypted = /#EXT-X-KEY:METHOD=(AES-128|SAMPLE-AES)/.test(text);
    const { status, bytes } = await readHead(new URL(seg, base).toString(), ctl.signal);
    if (status >= 400) return { ok: false, error: `segment HTTP ${status}` };
    if (looksLikeMedia(bytes) || (encrypted && bytes.length > 1024)) return { ok: true, quality };
    return { ok: false, error: "segments aren't video" };
  } catch (e: unknown) {
    if (signal?.aborted) return { ok: false, error: "AbortError" };
    if (e instanceof Error && e.name === "AbortError") return { ok: false, error: "timeout" };
    return { ok: false, error: e instanceof Error ? e.message : "failed" };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

/**
 * Check a direct candidate really plays and how fast it answers. Local files are trusted
 * after a header read; streams get the manifest readiness check.
 */
async function probe(c: StreamCandidate, signal?: AbortSignal): Promise<StreamCandidate> {
  if (c.kind === "embed") return native ? verifyEmbed(c, signal) : { ...c, probe: { ok: true, latencyMs: 0 } };
  const t0 = performance.now();
  if (c.providerId === "local") {
    const { ctl, cleanup } = linkSignal(signal);
    try {
      const res = await withTimeout(fetch(c.url, { signal: ctl.signal, headers: { Range: "bytes=0-1" } }), PROBE_TIMEOUT, ctl);
      ctl.abort();
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return { ...c, probe: { ok: true, latencyMs: Math.round(performance.now() - t0), quality: c.quality } };
    } catch (e: unknown) {
      return { ...c, probe: { ok: false, latencyMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : "failed" } };
    } finally {
      cleanup();
    }
  }
  const check = await quickCheck(c, signal);
  const ms = Math.round(performance.now() - t0);
  const latencyMs = c.probe?.ok ? Math.min(c.probe.latencyMs + ms, ms * 2) : ms;
  return check.ok
    ? { ...c, quality: check.quality ?? c.quality, probe: { ok: true, latencyMs, quality: check.quality ?? c.quality } }
    : { ...c, probe: { ok: false, latencyMs, error: check.error } };
}

/**
 * Hedged concurrent candidate prober: probes top candidates in bounded parallel batches,
 * staggers backup probes if the initial batch is slow, and immediately aborts losing
 * requests via AbortController once `maxWinners` valid streams resolve.
 */
export async function probeHedged(candidates: StreamCandidate[], opts: HedgedProbeOptions = {}): Promise<StreamCandidate[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const hedgeDelayMs = opts.hedgeDelayMs ?? HEDGE_DELAY_MS;
  const maxWinners = Math.max(1, opts.maxWinners ?? 1);
  if (!candidates.length || opts.signal?.aborted) return candidates;

  const queue = [...candidates];
  const resultsById = new Map<string, StreamCandidate>();
  for (const c of candidates) resultsById.set(c.pageUrl ?? c.url, c);

  const inFlight = new Set<AbortController>();
  let winners = 0;
  let running = 0;
  let limit = concurrency;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelInFlight = () => {
    clearTimeout(hedgeTimer);
    for (const ctl of inFlight) ctl.abort();
    inFlight.clear();
  };

  return new Promise<StreamCandidate[]>((resolve) => {
    const onAbort = () => {
      queue.length = 0;
      cancelInFlight();
      finishIfDone();
    };

    const finishIfDone = () => {
      if (running === 0 && (queue.length === 0 || winners >= maxWinners || opts.signal?.aborted)) {
        clearTimeout(hedgeTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(candidates.map((c) => resultsById.get(c.pageUrl ?? c.url) ?? c));
      }
    };

    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (winners === 0 && queue.length > 0 && running >= limit && limit < concurrency + 2) {
        hedgeTimer = setTimeout(() => {
          if (winners === 0 && queue.length > 0 && !opts.signal?.aborted) {
            limit = concurrency + 2;
            pump();
          }
        }, hedgeDelayMs);
      }
    };

    const pump = () => {
      while (running < limit && queue.length > 0 && winners < maxWinners && !opts.signal?.aborted) {
        const cand = queue.shift()!;
        const id = cand.pageUrl ?? cand.url;
        const { ctl, cleanup } = linkSignal(opts.signal);
        inFlight.add(ctl);
        running++;
        probe(cand, ctl.signal)
          .then((probed) => {
            // If pre-empted because another candidate already won, keep as standby rather than failed.
            if (ctl.signal.aborted && (winners >= maxWinners || opts.signal?.aborted) && !probed.probe?.ok) {
              return;
            }
            resultsById.set(id, probed);
            opts.onCandidate?.(probed);
            if (probed.probe?.ok) {
              winners++;
              if (winners >= maxWinners) {
                cancelInFlight();
              }
            }
          })
          .finally(() => {
            inFlight.delete(ctl);
            cleanup();
            running--;
            if (winners < maxWinners && !opts.signal?.aborted) {
              pump();
              scheduleHedge();
            }
            finishIfDone();
          });
      }
      scheduleHedge();
      finishIfDone();
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    pump();
  });
}

/**
 * Score a candidate. In order of weight:
 *  - verified at all (an unverified server never beats one that proved it has the title);
 *  - plays in AbixCine's own player (direct/captured) rather than as a web page;
 *  - closeness to the preferred quality;
 *  - track record, circuit-breaker state, last pick for this show, speed, provider priority;
 *  - this exact file failed to play in the last day or has an expired token.
 */
export function score(c: StreamCandidate, preferred: number, priority: number, req: PlaybackRequest): StreamCandidate {
  if (!c.probe) return { ...c, score: -500 + priority, why: [] };
  if (!c.probe.ok) return { ...c, score: -1000 + priority, why: [] };
  const q = c.probe.quality ?? c.quality ?? 720;
  const qScore = q <= preferred ? q / preferred : 1 - (q - preferred) / (preferred * 4);
  const avg = getHealth(c.providerId).latency;
  const ms = avg == null ? c.probe.latencyMs : c.probe.latencyMs * 0.6 + avg * 0.4;
  const startupMs = ms + (c.lookupMs ?? getHealth(c.providerId).lookupMs ?? 0);
  const latency = Math.min(startupMs, 12000) / 12000;
  const rel = reliability(c.providerId);
  const circuitOpen = isCircuitOpen(c.providerId);
  const shaky = recentlyFailed(c.providerId) ? 12 : 0;
  const tripped = circuitOpen ? 25 : 0;
  const pick = lastPick(req);
  const memory = pick && pick.providerId === c.providerId && !shaky && !circuitOpen ? 8 : 0;
  const own = c.via === "direct" || c.via === "sniffed" || c.providerId === "local" || c.providerId === "jellyfin" ? 25 : 0;
  const provider = PROVIDERS.find((p) => p.id === c.providerId);
  const originalLanguage = "originalLanguage" in req.media && typeof req.media.originalLanguage === "string"
    ? req.media.originalLanguage.toLowerCase().split(/[-_]/)[0]
    : undefined;
  const frenchOnly = (provider?.isFrench || /· french/i.test(c.label)) && originalLanguage && !["fr", "fra", "fre"].includes(originalLanguage);
  const languageMiss = frenchOnly ? 28 : 0;
  // An anime request with a player that can't honour sub/dub only wins when nothing else answers.
  const audioMiss = req.audio && c.audio === "unknown" ? 18 : 0;
  // This exact URL failed to play or has an expired token.
  const broken = badUrl(c.url) || isUrlTokenExpired(c.url) ? 40 : 0;
  const why: string[] = [];
  if (own && c.via !== "direct") why.push("ad-free");
  if (c.via === "direct") why.push("direct stream");
  if (req.audio && (c.audio === req.audio || c.audio === "dual")) why.push(req.audio === "dub" ? "English dub" : "subtitled");
  if (memory) why.push("played this show before");
  if (languageMiss) why.push("French source for non-French title");
  if (rel > 0.8 && getHealth(c.providerId).ok > 3) why.push("reliable");
  if (shaky || circuitOpen) why.push("failed recently");
  if (broken) why.push("wouldn't play last time");
  return {
    ...c,
    why,
    score: own + qScore * 40 - latency * 20 + (rel - 0.5) * 20 + memory - shaky - tripped - languageMiss - audioMiss - broken + priority * 0.5,
  };
}

const sortByScore = (a: StreamCandidate, b: StreamCandidate) => b.score! - a.score!;

/** Only ignore probe failures caused by our own AbortController cancellation. */
function isAbortedProbe(c: StreamCandidate, signal?: AbortSignal) {
  return !!signal?.aborted || /^AbortError$/i.test(c.probe?.error ?? "");
}

export function initialCandidateIndex(candidates: StreamCandidate[], preferred?: string) {
  const selected = preferred
    ? candidates.findIndex((c) => c.url === preferred || c.pageUrl === preferred || c.providerId === preferred)
    : -1;
  return selected >= 0 ? selected : Math.max(0, candidates.findIndex((c) => c.probe?.ok !== false));
}

export interface ResolveOptions {
  /** Called with the full ranked list each time a probe lands (including after the promise resolved). */
  onUpdate?: (ranked: StreamCandidate[]) => void;
  /** Resolve as soon as a verified stream exists; the rest keep checking as backups. */
  early?: boolean;
  /**
   * How many embed servers to verify before leaving the rest unchecked ("standby"). Each check
   * loads a page off-screen, so the title page asks for one, the player for a few backups.
   */
  verifyBudget?: number;
  signal?: AbortSignal;
  /** Learn from this race (health stats). Off for previews, so a title visit + Play doesn't count twice. */
  record?: boolean;
}

/** Briefly let near-simultaneous results compete before starting the first verified stream. */
const GRACE_MS = 250;

/**
 * Finished races, kept briefly so the title page's check and the player share one round of
 * lookups and captures instead of doing the work twice.
 */
const RESULT_TTL = 30_000;
const results = new Map<string, { at: number; ranked: StreamCandidate[]; events: ResolveEvent[]; budget: number }>();
const resultKey = (req: PlaybackRequest, s: Settings) =>
  `${reqKey(req)}|${JSON.stringify([s.libraryPaths, s.jellyfin.enabled && s.jellyfin.url, s.disabledSources, s.enabledExtras, s.preferredQuality])}`;

/** Forget cached races after a source is toggled or playback resolves against a captured URL. */
export const clearResolveCache = () => results.clear();

/**
 * Ask every enabled provider in parallel. Direct candidates are probed as they arrive; embed
 * candidates are verified (captured) in priority order with hedged concurrency and AbortController
 * cancellation until `verifyBudget` of them have proved they have the title.
 */
export function resolveSources(req: PlaybackRequest, onEvent?: (e: ResolveEvent) => void, opts: ResolveOptions = {}): Promise<StreamCandidate[]> {
  const s = getSettings();
  const enabled = PROVIDERS.filter((p) => p.isEnabled(s));
  const prio = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.priority]));
  const budget = opts.verifyBudget ?? 3;
  const seen = new Set<string>();
  const record = opts.record !== false;
  /** Probes count once per provider per race, so a provider returning 3 files doesn't get 3 votes. */
  const probed = new Set<string>();
  let ranked: StreamCandidate[] = [];
  let settled = false;
  const ck = resultKey(req, s);

  const hit = results.get(ck);
  // Reuse a recent race only if its verified winners are still fresh (not marked bad or expired).
  const hasUncheckedEmbeds = hit?.ranked.some((c) => c.kind === "embed" && !c.probe);
  const hitHasFreshWinner = hit?.ranked.some((c) => c.probe?.ok && !isStaleStreamUrl(c.url, hit.at) && !isCircuitOpen(c.providerId));
  if (hit && Date.now() - hit.at < RESULT_TTL && hitHasFreshWinner && (hit.budget >= budget || !hasUncheckedEmbeds)) {
    const again = hit.ranked
      .map((c) => (c.probe?.ok && isStaleStreamUrl(c.url, hit.at) ? { ...c, probe: { ok: false, latencyMs: c.probe.latencyMs, error: "token expired" } } : c))
      .map((c) => score(c, s.preferredQuality, prio[c.providerId] ?? 0, req))
      .sort(sortByScore);
    hit.events.forEach((e) => onEvent?.(e));
    opts.onUpdate?.(again);
    return Promise.resolve(again);
  }
  const finalEvents: Record<string, ResolveEvent> = {};
  const emit = (e: ResolveEvent) => {
    finalEvents[e.providerId] = e;
    onEvent?.(e);
  };

  return new Promise((resolve) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const activeProbes = new Set<AbortController>();

    const abortActiveProbes = () => {
      clearTimeout(hedgeTimer);
      for (const ctl of activeProbes) ctl.abort();
      activeProbes.clear();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      resolve(ranked);
    };
    const upsert = (c: StreamCandidate) => {
      if (opts.signal?.aborted) return;
      if (c.probe && !isAbortedProbe(c, opts.signal) && record && !probed.has(c.providerId)) {
        probed.add(c.providerId);
        recordProbe(c);
      }
      const scored = score(c, s.preferredQuality, prio[c.providerId] ?? 0, req);
      const id = c.pageUrl ?? c.url;
      ranked = [...ranked.filter((x) => (x.pageUrl ?? x.url) !== id), scored].sort(sortByScore);
      opts.onUpdate?.(ranked);
      if (opts.early && !settled && !graceTimer && c.probe?.ok) graceTimer = setTimeout(finish, GRACE_MS);
    };

    // Embed verification queue: highest health/learned priority first, hedged concurrency, until budget is met.
    const queue: StreamCandidate[] = [];
    let verified = 0;
    let running = 0;
    let lookupsDone = false;
    let maxParallel = 3;
    const kind = req.media.kind;
    const previousPick = lastPick(req)?.providerId;
    const rank = (c: StreamCandidate) =>
      learnedRank(c.providerId, kind, prio[c.providerId] ?? 0) +
      (c.providerId === previousPick && !isCircuitOpen(c.providerId) && !recentlyFailed(c.providerId) ? 20 : 0);

    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (verified === 0 && queue.length > 0 && running >= maxParallel && maxParallel < 5) {
        hedgeTimer = setTimeout(() => {
          if (verified === 0 && queue.length > 0 && !opts.signal?.aborted) {
            maxParallel = 5;
            pump();
          }
        }, HEDGE_DELAY_MS);
      }
    };

    const pump = () => {
      while (running < maxParallel && queue.length && verified < budget && !opts.signal?.aborted) {
        queue.sort((a, b) => rank(b) - rank(a));
        const c = queue.shift()!;
        const { ctl: probeCtl, cleanup } = linkSignal(opts.signal);
        activeProbes.add(probeCtl);
        running++;
        probe(c, probeCtl.signal)
          .catch((e: unknown): StreamCandidate => ({
            ...c,
            probe: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : "probe failed" },
          }))
          .then((r) => {
            // Pre-empted because budget was already met by a faster server: keep as standby.
            if (probeCtl.signal.aborted && (verified >= budget || opts.signal?.aborted) && !r.probe?.ok) {
              if (!opts.signal?.aborted) upsert(c);
              return;
            }
            if (r.probe?.ok) {
              verified++;
              if (verified >= budget) {
                for (const other of activeProbes) {
                  if (other !== probeCtl) other.abort();
                }
              }
            }
            if (record && r.probe && !isAbortedProbe(r, opts.signal)) {
              recordWin(r.providerId, kind, !!r.probe.ok);
            }
            upsert(r);
          })
          .finally(() => {
            activeProbes.delete(probeCtl);
            cleanup();
            running--;
            pump();
            scheduleHedge();
            maybeDone();
          });
      }
      scheduleHedge();
    };
    const onAbort = () => {
      queue.length = 0;
      abortActiveProbes();
      finish();
    };
    const maybeDone = () => {
      if (!lookupsDone || running) return;
      if (queue.length && verified < budget) return;
      clearTimeout(hedgeTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Whatever wasn't checked stays listed as standby (probe undefined).
      for (const c of queue.splice(0)) upsert(c);
      if (!opts.signal?.aborted && ranked.some((c) => c.probe?.ok)) {
        results.set(ck, { at: Date.now(), ranked, events: Object.values(finalEvents), budget });
      }
      finish();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const runs = enabled.map(async (p) => {
      emit({ providerId: p.id, status: "searching" });
      const { ctl, cleanup } = linkSignal(opts.signal);
      let found: StreamCandidate[];
      const t0 = performance.now();
      try {
        found = await withTimeout(p.find(req, s, ctl.signal), lookupTimeout(p.id, p.timeoutMs ?? PROVIDER_TIMEOUT), ctl);
        if (record) recordLookup(p.id, performance.now() - t0);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : undefined;
        const timeout = msg === "timeout";
        const elapsed = Math.round(performance.now() - t0);
        if (!opts.signal?.aborted && record) recordLookupFailure(p.id, elapsed);
        emit({ providerId: p.id, status: timeout ? "timeout" : "error", error: msg });
        return;
      } finally {
        cleanup();
      }
      const lookupMs = Math.round(performance.now() - t0);
      const fresh = found
        .filter((c) => !seen.has(c.url) && (seen.add(c.url), true))
        .map((c) => ({ ...c, lookupMs }));
      emit({ providerId: p.id, status: "done", count: fresh.length });
      const embeds = fresh.filter((c) => c.kind === "embed");
      if (embeds.length) {
        queue.push(...embeds);
        pump();
      }
      await Promise.all(
        fresh
          .filter((c) => c.kind !== "embed")
          .map(async (c) => {
            const { ctl: directCtl, cleanup: directCleanup } = linkSignal(opts.signal);
            activeProbes.add(directCtl);
            try {
              const r = await probe(c, directCtl.signal).catch((e: unknown): StreamCandidate => ({
                ...c,
                probe: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : "probe failed" },
              }));
              if (record && r.probe && !isAbortedProbe(r, opts.signal)) {
                recordWin(r.providerId, kind, !!r.probe.ok);
              }
              upsert(r);
            } finally {
              activeProbes.delete(directCtl);
              directCleanup();
            }
          }),
      );
    });
    Promise.all(runs).then(() => {
      lookupsDone = true;
      pump();
      maybeDone();
    });
  });
}

/** A stream URL the user pasted (their own server, a public-domain file, etc.). */
export function manualCandidate(url: string): StreamCandidate {
  const kind = /\.m3u8(\?|$)/i.test(url) ? "hls" : /\.mpd(\?|$)/i.test(url) ? "dash" : "file";
  return {
    providerId: "manual",
    providerName: "Direct link",
    label: url.split("/").pop()?.split("?")[0] || url,
    url,
    kind,
    via: "direct",
  };
}

/** 0–100 for display: how good a pick this is. */
export function displayScore(c: StreamCandidate) {
  if (!c.probe?.ok || c.score == null) return 0;
  return Math.max(1, Math.min(99, Math.round((c.score / 90) * 100)));
}

/** "1080p · 2.1 s" style line for a candidate. */
export function candLine(c: StreamCandidate) {
  if (!c.probe) return "not verified";
  if (!c.probe.ok) {
    if (c.probe.error === "no stream" || c.probe.error === "not found") return "no stream found";
    if (c.probe.error === "timeout") return "timed out";
    return c.probe.error?.slice(0, 72) ?? "couldn't verify";
  }
  const q = c.probe.quality ?? c.quality;
  const ms = c.probe.latencyMs;
  return [q ? `${q}p` : null, ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`].filter(Boolean).join(" · ");
}
