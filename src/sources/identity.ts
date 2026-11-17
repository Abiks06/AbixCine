import { hasTmdb, tmdbSeason } from "../lib/tmdb";
import { isFilm, type MediaDetail, type PlaybackRequest } from "../lib/types";
import type { StreamCandidate, StreamIdentity } from "./types";

/**
 * "Is this stream really the title?" Some servers answer a request with a different film: a
 * TMDB-id host that has nothing for a new release serves whatever file it has under that id, a
 * catalog search lands on a same-named older title. Such a stream plays fine, so every check that
 * only asks "does it play" passes it. Its length usually gives it away: a stream far shorter or
 * longer than the catalog runtime is probably another title, or a trailer.
 *
 * Only a strong disagreement counts (minutes, not seconds): runtimes are rounded, streams carry
 * credits, studio logos and the odd prepended ad, and extended cuts exist. Unknown runtime or an
 * unmeasurable stream (a live playlist, a progressive file) is "unknown", never a mismatch.
 */

export interface RuntimeExpectation {
  seconds: number;
  /** An episode (tighter absolute tolerance) rather than a film. */
  episode: boolean;
}

const isFilmRequest = (req: PlaybackRequest) =>
  isFilm(req.media) || Boolean((req as { isAnimeMovie?: boolean }).isAnimeMovie) || Boolean((req.media as { isAnimeMovie?: boolean }).isAnimeMovie);

const tmdbTvKey = (m: MediaDetail) => [m.canonicalKey, m.key].find((k) => !!k && /^tmdb:tv:\d+$/.test(k));

/** Minutes → seconds when the catalog gave a real runtime. */
const minutes = (n?: number) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n * 60 : undefined);

/**
 * Can the runtime be known for this request at all? Decided without any network, so a session
 * for a title without a runtime behaves exactly as before.
 */
export function identityApplies(req: PlaybackRequest): boolean {
  const m = req.media as MediaDetail;
  if (isFilmRequest(req)) return minutes(m.runtime) != null;
  if (req.episode == null) return false;
  // Anime entries carry a per-episode runtime (AniList's duration, TMDB's episode_run_time).
  if (m.kind === "anime" && minutes(m.runtime) != null) return true;
  return !!tmdbTvKey(m) && hasTmdb();
}

/** What the request should run: the film's runtime, or this episode's (TMDB season data, cached). */
export async function expectedRuntime(req: PlaybackRequest): Promise<RuntimeExpectation | null> {
  const m = req.media as MediaDetail;
  if (isFilmRequest(req)) {
    const s = minutes(m.runtime);
    return s ? { seconds: s, episode: false } : null;
  }
  if (req.episode == null) return null;
  if (m.kind === "anime") {
    const s = minutes(m.runtime);
    if (s) return { seconds: s, episode: true };
  }
  const key = tmdbTvKey(m);
  if (!key || !hasTmdb()) return null;
  try {
    const eps = await tmdbSeason(key, req.season ?? 1);
    const s = minutes(eps.find((e) => e.number === req.episode)?.runtime);
    // No per-episode runtime: the show-wide average is too loose to judge a single episode.
    return s ? { seconds: s, episode: true } : null;
  } catch {
    return null;
  }
}

/** Sum of an HLS media playlist's segments, seconds. Null for a live or unfinished playlist. */
export function hlsPlaylistDuration(text: string): number | null {
  if (!text.replace(/^﻿/, "").trimStart().startsWith("#EXTM3U")) return null;
  if (!/#EXT-X-ENDLIST\b/.test(text) && !/#EXT-X-PLAYLIST-TYPE:\s*VOD\b/i.test(text)) return null;
  let total = 0;
  let n = 0;
  for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) {
    const d = Number(m[1]);
    if (Number.isFinite(d) && d > 0) {
      total += d;
      n++;
    }
  }
  return n ? total : null;
}

/** A DASH manifest's `mediaPresentationDuration`, seconds. Null for a live manifest. */
export function dashManifestDuration(text: string): number | null {
  if (/\btype\s*=\s*["']dynamic["']/i.test(text)) return null;
  const m = text.match(
    /mediaPresentationDuration\s*=\s*["']P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?["']/i,
  );
  if (!m) return null;
  const [d, h, min, s] = m.slice(1).map((v) => (v ? Number(v) : 0));
  const total = d * 86400 + h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

const MEASURE_MS = 6000;
const MAX_PLAYLIST_CHARS = 4_000_000;

async function fetchText(url: string, signal: AbortSignal): Promise<{ text: string; url: string } | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  const text = await res.text();
  return text.length > MAX_PLAYLIST_CHARS ? null : { text, url: res.url || url };
}

/**
 * How long a stream runs, read from its playlist (HLS: master → first variant, summing segment
 * lengths; DASH: the manifest's duration). Null when it can't be told. Through the local proxy
 * these playlists are usually already cached from the stream's own check.
 */
export async function measureStreamDuration(c: StreamCandidate, signal?: AbortSignal): Promise<number | null> {
  if (c.kind !== "hls" && c.kind !== "dash") return null;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), MEASURE_MS);
  try {
    let got = await fetchText(c.url, ctl.signal);
    if (!got) return null;
    if (c.kind === "dash" || /<MPD[\s>]/i.test(got.text.slice(0, 4096))) return dashManifestDuration(got.text);
    if (got.text.includes("#EXT-X-STREAM-INF")) {
      const lines = got.text.split(/\r?\n/).map((l) => l.trim());
      const at = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
      const variant = lines.slice(at + 1).find((l) => l && !l.startsWith("#"));
      if (!variant) return null;
      got = await fetchText(new URL(variant, got.url).toString(), ctl.signal);
      if (!got) return null;
    }
    return hlsPlaylistDuration(got.text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Compare a stream's length with what the catalog says. Shorter is judged more tightly than
 * longer: streams gain minutes (credits, logos, a prepended ad, an extended cut) far more often
 * than they lose them, while a trailer or a different film is usually off by a lot.
 */
export function judgeRuntime(durationSec: number, expected: RuntimeExpectation): StreamIdentity {
  const expectedSec = expected.seconds;
  if (!(durationSec > 0) || !(expectedSec > 0)) return { status: "unknown", ...(expectedSec > 0 ? { expectedSec } : {}) };
  const diff = durationSec - expectedSec;
  const shortTol = expected.episode ? Math.max(10 * 60, expectedSec * 0.35) : Math.max(20 * 60, expectedSec * 0.2);
  const longTol = expected.episode ? Math.max(15 * 60, expectedSec * 0.5) : Math.max(30 * 60, expectedSec * 0.35);
  const durationRounded = Math.round(durationSec);
  if (diff < -shortTol) return { status: "mismatch", durationSec: durationRounded, expectedSec, off: "short" };
  if (diff > longTol) return { status: "mismatch", durationSec: durationRounded, expectedSec, off: "long" };
  return { status: "match", durationSec: durationRounded, expectedSec };
}

/** Measure a ready stream and judge it against the expected runtime. Null when nothing is expected. */
export async function checkStreamIdentity(
  c: StreamCandidate,
  expected: RuntimeExpectation | null,
  signal?: AbortSignal,
): Promise<StreamIdentity | null> {
  if (!expected) return null;
  const d = await measureStreamDuration(c, signal).catch(() => null);
  if (d == null) return { status: "unknown", expectedSec: expected.seconds };
  return judgeRuntime(d, expected);
}

/** "2 h 31 min", "48 min". */
export function fmtRuntime(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}
