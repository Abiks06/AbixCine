import { getSettings } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import type { Settings } from "../lib/settings";
import { animeDirectProvider } from "./anime-direct";
import { jellyfinProvider } from "./jellyfin";
import { badUrl, getHealth, lastPick, lookupTimeout, recentlyFailed, recordLookup, recordLookupFailure, recordProbe, reliability } from "./health";
import { kisskhProvider } from "./kisskh";
import { localProvider } from "./local";
import { native, proxyUrl, sniff } from "./native";
import { availableSources, embedProviders } from "./embeds";
import type { SourceProvider, StreamCandidate, VideoSource } from "./types";

/** All known providers. Register new ones here. */
export const PROVIDERS: SourceProvider[] = [localProvider, jellyfinProvider, animeDirectProvider, kisskhProvider, ...embedProviders];

/** Providers with their own entry in Settings → Servers (besides the embed list). */
export const DIRECT_SOURCES = [
  { id: "hianime", name: "HiAnime", note: "Anime · direct stream with sub/dub, subtitles and intro skip" },
  { id: "kisskh", name: "KissKH", note: "Asian dramas and films · subtitled" },
];

export { availableSources, embedProviders };
export type { VideoSource };

export { recordPlayback } from "./health";

const PROVIDER_TIMEOUT = 8000;
const PROBE_TIMEOUT = 6000;
/** Capturing a stream from an embed page: load, start, catch the playlist. Most succeed in 4–10 s. */
const SNIFF_TIMEOUT = 15_000;

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
/** Base priority plus learned success for this kind of title. */
function learnedRank(providerId: string, kind: string, base: number) {
  const w = wins[`${providerId}:${kind}`];
  if (!w) return base;
  const rate = (w.ok + 1) / (w.n + 2);
  const recent = w.last && Date.now() - w.last < 3 * 86400_000 ? 3 : 0;
  return base + rate * 12 - 6 + recent;
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

/** Highest RESOLUTION=WxH in a master playlist, or undefined. */
export function hlsMaxHeight(manifest: string) {
  let best: number | undefined;
  for (const m of manifest.matchAll(/RESOLUTION=\d+x(\d+)/g)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

/**
 * Turn an embed into a direct stream by capturing what its page plays. Success is the proof
 * the title is really there; failure means it isn't (or the player wouldn't start), and the
 * embed stays only as an unverified web-player fallback.
 */
export async function verifyEmbed(c: StreamCandidate): Promise<StreamCandidate> {
  const t0 = performance.now();
  const page = c.pageUrl ?? c.url;
  const got = await sniff(page, SNIFF_TIMEOUT).catch(() => null);
  const latencyMs = Math.round(performance.now() - t0);
  // Nothing captured: the server may not have it, or its player wouldn't start. We can't tell which.
  if (!got) return { ...c, probe: { ok: false, latencyMs, error: "no stream" } };
  const direct: StreamCandidate = {
    ...c,
    url: proxyUrl(got.url, got.headers),
    kind: got.kind === "mp4" ? "file" : "hls",
    via: "sniffed",
    pageUrl: page,
    subtitles: got.subtitles.map((u, i) => ({ lang: "und", label: got.subtitles.length > 1 ? `Track ${i + 1}` : "Subtitles", url: proxyUrl(u, got.headers) })),
  };
  // The playlist was already fetched and checked in Rust (warming the connection and leaving it
  // cached for the player); files get a quick header check. The player's watchdog is the final test.
  const check = got.verified != null ? { ok: got.verified, quality: got.quality ?? undefined, error: got.verified ? undefined : "refused" } : await quickCheck(direct);
  const total = Math.round(performance.now() - t0);
  if (!check.ok) return { ...c, pageUrl: page, probe: { ok: false, latencyMs: total, error: check.error ?? "won't play" } };
  return { ...direct, quality: check.quality ?? direct.quality, probe: { ok: true, latencyMs, quality: check.quality ?? direct.quality } };
}

const QUICK_CHECK_MS = 5000;

/**
 * Cheap reachability check used during the race: an HLS stream must answer with a real playlist,
 * a file with real video bytes. One small request each, so several servers can be checked at
 * once without competing for bandwidth. Deeper problems are caught by the player's watchdog,
 * which switches server at the same spot and records the failure.
 */
export async function quickCheck(c: StreamCandidate): Promise<{ ok: boolean; quality?: number; error?: string }> {
  if (c.kind === "embed") return { ok: true };
  if (c.kind === "file") return playCheck(c);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), QUICK_CHECK_MS);
  try {
    const res = await fetchRetry(c.url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    if (!text.includes("#EXTM3U")) return { ok: false, error: "not a playlist" };
    if (!text.includes("#EXT-X-STREAM-INF") && !text.includes("#EXTINF")) return { ok: false, error: "empty playlist" };
    return { ok: true, quality: hlsMaxHeight(text) };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : (e?.message ?? "failed") };
  } finally {
    clearTimeout(timer);
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
  await new Promise((r) => setTimeout(r, 1200));
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
 * for files, the first bytes must be an MP4/WebM/TS header.
 */
export async function playCheck(c: StreamCandidate): Promise<{ ok: boolean; quality?: number; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PLAY_CHECK_MS);
  try {
    if (c.kind === "file") {
      const { status, bytes } = await readHead(c.url, ctl.signal);
      const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
      return looksLikeMedia(bytes) || webm ? { ok: true } : { ok: false, error: status >= 400 ? `HTTP ${status}` : "not a video file" };
    }
    if (c.kind !== "hls") return { ok: true };
    const res = await fetchRetry(c.url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let text = await res.text();
    if (!text.includes("#EXTM3U")) return { ok: false, error: "not a playlist" };
    const quality = hlsMaxHeight(text);
    let base = res.url || c.url;
    if (text.includes("#EXT-X-STREAM-INF")) {
      const variant = firstUri(text);
      if (!variant) return { ok: false, error: "empty playlist" };
      const vu = new URL(variant, base).toString();
      const vr = await fetchRetry(vu, { signal: ctl.signal });
      if (!vr.ok) return { ok: false, error: `variant HTTP ${vr.status}` };
      text = await vr.text();
      base = vr.url || vu;
    }
    const seg = firstUri(text);
    if (!seg) return { ok: false, error: "no segments" };
    const encrypted = /#EXT-X-KEY:METHOD=(AES-128|SAMPLE-AES)/.test(text);
    const { status, bytes } = await readHead(new URL(seg, base).toString(), ctl.signal);
    if (status >= 400) return { ok: false, error: `segment HTTP ${status}` };
    if (looksLikeMedia(bytes) || (encrypted && bytes.length > 1024)) return { ok: true, quality };
    return { ok: false, error: "segments aren't video" };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : (e?.message ?? "failed") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a direct candidate really plays and how fast it answers. Local files are trusted
 * after a header read; streams get the full playlist → segment check.
 */
async function probe(c: StreamCandidate): Promise<StreamCandidate> {
  if (c.kind === "embed") return native ? verifyEmbed(c) : { ...c, probe: { ok: true, latencyMs: 0 } };
  const t0 = performance.now();
  if (c.providerId === "local") {
    const ctl = new AbortController();
    try {
      const res = await withTimeout(fetch(c.url, { signal: ctl.signal, headers: { Range: "bytes=0-1" } }), PROBE_TIMEOUT, ctl);
      ctl.abort();
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return { ...c, probe: { ok: true, latencyMs: Math.round(performance.now() - t0), quality: c.quality } };
    } catch (e: any) {
      return { ...c, probe: { ok: false, latencyMs: Math.round(performance.now() - t0), error: e?.message ?? "failed" } };
    }
  }
  const check = await quickCheck(c);
  const ms = Math.round(performance.now() - t0);
  const latencyMs = c.probe?.ok ? Math.min(c.probe.latencyMs + ms, ms * 2) : ms;
  return check.ok
    ? { ...c, quality: check.quality ?? c.quality, probe: { ok: true, latencyMs, quality: check.quality ?? c.quality } }
    : { ...c, probe: { ok: false, latencyMs, error: check.error } };
}

/**
 * Score a candidate. In order of weight:
 *  - verified at all (an unverified server never beats one that proved it has the title);
 *  - plays in AbixCine's own player (direct/captured) rather than as a web page;
 *  - closeness to the preferred quality;
 *  - track record, last pick for this show, speed, provider priority;
 *  - this exact file failed to play in the last day (e.g. a codec the player can't decode).
 */
export function score(c: StreamCandidate, preferred: number, priority: number, req: PlaybackRequest): StreamCandidate {
  if (!c.probe) return { ...c, score: -500 + priority, why: [] };
  if (!c.probe.ok) return { ...c, score: -1000 + priority, why: [] };
  const q = c.probe.quality ?? c.quality ?? 720;
  const qScore = q <= preferred ? q / preferred : 1 - (q - preferred) / (preferred * 4);
  const avg = getHealth(c.providerId).latency;
  const ms = avg == null ? c.probe.latencyMs : c.probe.latencyMs * 0.6 + avg * 0.4;
  const latency = Math.min(ms, 12000) / 12000;
  const rel = reliability(c.providerId);
  const pick = lastPick(req);
  const memory = pick ? (pick.providerId === c.providerId ? 8 : 0) : 0;
  const shaky = recentlyFailed(c.providerId) ? 12 : 0;
  const own = c.via === "direct" || c.via === "sniffed" || c.providerId === "local" || c.providerId === "jellyfin" ? 25 : 0;
  // An anime request with a player that can't honour sub/dub only wins when nothing else answers.
  const audioMiss = req.audio && c.audio === "unknown" ? 18 : 0;
  // This exact URL failed to play (not just this provider): a codec issue, a dead link.
  const broken = badUrl(c.url) ? 40 : 0;
  const why: string[] = [];
  if (own && c.via !== "direct") why.push("ad-free");
  if (c.via === "direct") why.push("direct stream");
  if (req.audio && (c.audio === req.audio || c.audio === "dual")) why.push(req.audio === "dub" ? "English dub" : "subtitled");
  if (memory) why.push("played this show before");
  if (rel > 0.8 && getHealth(c.providerId).ok > 3) why.push("reliable");
  if (shaky) why.push("failed recently");
  if (broken) why.push("wouldn't play last time");
  return { ...c, why, score: own + qScore * 40 - latency * 20 + (rel - 0.5) * 20 + memory - shaky - audioMiss - broken + priority * 0.5 };
}

const sortByScore = (a: StreamCandidate, b: StreamCandidate) => b.score! - a.score!;

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

/** After the first verified stream appears, give the others this long to beat it. */
const GRACE_MS = 900;

/**
 * Finished races, kept briefly so the title page's check and the player share one round of
 * lookups and captures instead of doing the work twice.
 */
const RESULT_TTL = 120_000;
const results = new Map<string, { at: number; ranked: StreamCandidate[]; events: ResolveEvent[]; budget: number }>();
const resultKey = (req: PlaybackRequest, s: Settings) =>
  `${reqKey(req)}|${JSON.stringify([s.libraryPaths, s.jellyfin.enabled && s.jellyfin.url, s.disabledSources, s.preferredQuality])}`;

/** Forget cached races (after a source is toggled or a playback failure was recorded). */
export const clearResolveCache = () => results.clear();

/**
 * Ask every enabled provider in parallel. Direct candidates are probed as they arrive; embed
 * candidates are verified (captured) in priority order, a few at a time, until `verifyBudget`
 * of them have proved they have the title. `onEvent` streams per-provider status for the UI.
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
  // Reuse a recent race that found something (the title page's check feeds the player);
  // its unchecked servers are verified on demand from the server list.
  if (hit && Date.now() - hit.at < RESULT_TTL && (hit.budget >= budget || hit.ranked.some((c) => c.probe?.ok))) {
    // Re-score so anything that failed since (or was played since) moves accordingly.
    const again = hit.ranked.map((c) => score(c, s.preferredQuality, prio[c.providerId] ?? 0, req)).sort(sortByScore);
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
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      resolve(ranked);
    };
    const upsert = (c: StreamCandidate) => {
      if (opts.signal?.aborted) return;
      if (c.probe && record && !probed.has(c.providerId)) {
        probed.add(c.providerId);
        recordProbe(c);
      }
      const scored = score(c, s.preferredQuality, prio[c.providerId] ?? 0, req);
      const id = c.pageUrl ?? c.url;
      ranked = [...ranked.filter((x) => (x.pageUrl ?? x.url) !== id), scored].sort(sortByScore);
      opts.onUpdate?.(ranked);
      if (opts.early && !settled && !graceTimer && c.probe?.ok) graceTimer = setTimeout(finish, GRACE_MS);
    };

    // Embed verification queue: highest priority first, a few at a time, until the budget is met.
    const queue: StreamCandidate[] = [];
    let verified = 0;
    let attempts = 0;
    let running = 0;
    let lookupsDone = false;
    const MAX_PARALLEL = 3;
    const kind = req.media.kind;
    const rank = (c: StreamCandidate) => learnedRank(c.providerId, kind, prio[c.providerId] ?? 0);
    const pump = () => {
      while (running < MAX_PARALLEL && queue.length && verified < budget && attempts < budget + 4) {
        queue.sort((a, b) => rank(b) - rank(a));
        const c = queue.shift()!;
        running++;
        attempts++;
        probe(c)
          .then((r) => {
            if (r.probe?.ok) verified++;
            if (record) recordWin(r.providerId, kind, !!r.probe?.ok);
            upsert(r);
          })
          .finally(() => {
            running--;
            pump();
            maybeDone();
          });
      }
    };
    const maybeDone = () => {
      if (!lookupsDone || running) return;
      if (queue.length && verified < budget && attempts < budget + 4) return;
      // Whatever wasn't checked stays listed as standby (probe undefined).
      for (const c of queue.splice(0)) upsert(c);
      if (!opts.signal?.aborted && ranked.some((c) => c.probe?.ok)) {
        results.set(ck, { at: Date.now(), ranked, events: Object.values(finalEvents), budget });
      }
      finish();
    };
    opts.signal?.addEventListener("abort", () => {
      queue.length = 0;
      finish();
    });

    const runs = enabled.map(async (p) => {
      emit({ providerId: p.id, status: "searching" });
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let found: StreamCandidate[];
      const t0 = performance.now();
      try {
        found = await withTimeout(p.find(req, s, ctl.signal), lookupTimeout(p.id, p.timeoutMs ?? PROVIDER_TIMEOUT), ctl);
        if (record) recordLookup(p.id, performance.now() - t0);
      } catch (e: any) {
        const timeout = e?.message === "timeout";
        if (!opts.signal?.aborted && record) recordLookupFailure(p.id);
        emit({ providerId: p.id, status: timeout ? "timeout" : "error", error: e?.message });
        return;
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const fresh = found.filter((c) => !seen.has(c.url) && (seen.add(c.url), true));
      emit({ providerId: p.id, status: "done", count: fresh.length });
      const embeds = fresh.filter((c) => c.kind === "embed");
      await Promise.all(fresh.filter((c) => c.kind !== "embed").map((c) => probe(c).then(upsert)));
      if (embeds.length) {
        queue.push(...embeds);
        pump();
      }
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
  return {
    providerId: "manual",
    providerName: "Direct link",
    label: url.split("/").pop()?.split("?")[0] || url,
    url,
    kind: /\.m3u8(\?|$)/i.test(url) ? "hls" : "file",
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
  if (!c.probe) return "not checked yet";
  if (!c.probe.ok) return c.probe.error === "no stream" || c.probe.error === "not found" ? "no stream found" : c.probe.error === "timeout" ? "timed out" : "found, won't play";
  const q = c.probe.quality ?? c.quality;
  const ms = c.probe.latencyMs;
  return [q ? `${q}p` : null, ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`].filter(Boolean).join(" · ");
}
