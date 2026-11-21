import { isUrlTokenExpired, unwrapProxyUrl } from "../sources/native";
import type { StreamCandidate } from "../sources/types";

/**
 * Determine whether a server candidate can be saved for offline playback.
 * Web embeds (not yet sniffed), local/downloaded files, manual torrents,
 * suspect title mismatches, and expired links are excluded.
 */
export function isDownloadableCandidate(c: StreamCandidate): boolean {
  if (c.providerId === "local" || c.providerId === "downloads") return false;
  if (c.kind === "embed" || c.kind === "dash") return false;
  if (/^(?:magnet:|asset:|https?:\/\/asset\.localhost)/i.test(c.url)) return false;
  if (c.identity?.status === "mismatch") return false;
  // Require a verified ready candidate (or a candidate with an explicit direct download endpoint)
  if (!c.probe?.ok && !c.downloadUrl) return false;
  const rawUrl = unwrapProxyUrl(c.downloadUrl ?? c.url).url;
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  if (isUrlTokenExpired(c.url)) return false;
  return c.kind === "file" || c.kind === "hls" || Boolean(c.downloadUrl);
}

/** Check whether a candidate's known resolution meets or exceeds the requested target quality. */
export function candidateMeetsTargetQuality(c: StreamCandidate, preferredQuality = 1080): boolean {
  const q = c.probe?.quality ?? c.quality;
  return q != null && q >= preferredQuality;
}

/**
 * Quality-first server scoring for offline downloads.
 * Resolution fit against the target quality always dominates so a low-res 480p/640p direct file
 * never outranks a verified 1080p HLS stream; delivery method breaks ties at equal resolution.
 */
export function downloadScore(c: StreamCandidate, preferredQuality = 1080): number {
  let pts = 0;

  // 1. Resolution fit against the requested target quality (primary signal)
  const q = c.probe?.quality ?? c.quality;
  if (q != null && q > 0) {
    if (q >= preferredQuality) {
      // Meets or exceeds target; slight preference for exact match over oversized 4K when targeting 1080p
      const overPenalty = Math.min(22, ((q - preferredQuality) / Math.max(preferredQuality, 1)) * 16);
      pts += 180 - overPenalty;
    } else {
      // Steep drop for below-target streams so 480p/640p never beats 1080p/720p
      pts += Math.pow(q / Math.max(preferredQuality, 1), 1.8) * 160;
    }
  } else {
    // Unknown resolution: cautious mid score — below verified HD, above known 480p/640p
    pts += c.kind === "hls" ? 94 : 68;
  }

  // 2. Source delivery method (tie-breaker at equal resolution: Original > Direct file > Direct HLS > Sniffed HLS)
  if (c.downloadUrl || c.kind === "file") {
    pts += c.providerId === "jellyfin" ? 28 : 20;
  } else if (c.kind === "hls") {
    pts += c.via === "direct" ? 12 : 4;
  }

  // 3. Measured server speed + subtitle availability + dual-audio richness
  const latencyMs = c.probe?.latencyMs ?? 1200;
  const speedPts = (1 - Math.min(latencyMs, 8000) / 8000) * 14;
  pts += speedPts;

  const subCount = Math.min(4, c.subtitles?.length ?? 0);
  pts += subCount * 1.5;
  if (c.audio === "dual") pts += 3;
  if (c.score != null && Number.isFinite(c.score)) {
    pts += Math.max(-12, Math.min(12, c.score * 0.1));
  }

  return pts;
}

/** Deduplicate identical target streams and rank downloadable servers best-to-worst implicitly. */
export function rankDownloadOptions(candidates: StreamCandidate[], preferredQuality = 1080): StreamCandidate[] {
  const ranked = candidates
    .filter(isDownloadableCandidate)
    .map((c) => ({ c, s: downloadScore(c, preferredQuality) }))
    .sort((a, b) => b.s - a.s);

  const seen = new Set<string>();
  const out: StreamCandidate[] = [];
  for (const { c } of ranked) {
    const raw = unwrapProxyUrl(c.downloadUrl ?? c.url).url.toLowerCase();
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(c);
  }
  return out;
}

/** Neutral container/delivery format label shown beside each server option. */
export function downloadFormatLabel(c: StreamCandidate): string {
  if (c.downloadUrl) return "Original";
  if (c.kind === "hls") return "HLS → MP4";
  const raw = unwrapProxyUrl(c.url).url.split(/[?#]/)[0].toLowerCase();
  if (raw.endsWith(".mkv")) return "MKV";
  if (raw.endsWith(".webm")) return "WebM";
  if (raw.endsWith(".mp4") || raw.endsWith(".m4v")) return "MP4";
  return "Direct";
}
