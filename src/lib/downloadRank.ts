import { isUrlTokenExpired, unwrapProxyUrl } from "../sources/native";
import type { StreamCandidate } from "../sources/types";
import type { DownloadFormat } from "./settings";

/**
 * Determine whether a server candidate can be saved for offline playback.
 * Unsniffed embeds, local/downloaded files, manual torrents,
 * suspect title mismatches, and expired links are excluded.
 */
export function isDownloadableCandidate(c: StreamCandidate): boolean {
  if (c.providerId === "local" || c.providerId === "downloads") return false;
  if (c.kind === "embed") return false;
  if (/^(?:magnet:|asset:|https?:\/\/asset\.localhost)/i.test(c.url)) return false;
  if (c.identity?.status === "mismatch") return false;
  // Require a verified ready candidate (or a candidate with an explicit direct download endpoint)
  if (!c.probe?.ok && !c.downloadUrl) return false;
  const rawUrl = unwrapProxyUrl(c.downloadUrl ?? c.url).url;
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  if (isUrlTokenExpired(c.url)) return false;
  return c.kind === "file" || c.kind === "hls" || c.kind === "dash" || Boolean(c.downloadUrl);
}

/** Format vertical height as a readable resolution badge ("4K", "1080p", etc.). */
export function formatResolution(q?: number): string {
  if (!q || !Number.isFinite(q) || q <= 0) return "";
  return q >= 2160 ? "4K" : `${Math.round(q)}p`;
}

/** Highest verified or declared vertical height for a candidate, if known. */
export function bestKnownQuality(c: StreamCandidate): number | undefined {
  const q = c.probe?.quality ?? c.quality;
  return q != null && Number.isFinite(q) && q > 0 ? q : undefined;
}

/** Check whether a candidate's known resolution meets or exceeds the requested target quality. */
export function candidateMeetsTargetQuality(c: StreamCandidate, preferredQuality = 1080): boolean {
  const q = bestKnownQuality(c);
  return q != null && q >= preferredQuality;
}

/**
 * Resolution-exact server scoring for offline downloads.
 *
 * Verified high resolutions strictly outrank unverified/unknown streams so picking 4K
 * falls back predictably (e.g. 1080p -> 720p) instead of picking an unknown 640p stream.
 * Passing `preferredProviderId` helps lock bulk season downloads to one reliable server.
 */
export function downloadScore(
  c: StreamCandidate,
  preferredQuality = 1080,
  opts?: { preferredProviderId?: string },
): number {
  let pts = 0;
  const target = Math.max(240, preferredQuality || 1080);
  const q = bestKnownQuality(c);
  const isFixedFile = Boolean(c.downloadUrl || c.kind === "file");

  if (q != null && q > 0) {
    if (isFixedFile) {
      if (q === target) {
        // Exact match on a fixed direct file is ideal (zero muxing needed if container matches).
        pts += 200;
      } else if (q > target) {
        // Fixed files cannot pick a lower adaptive bitrate variant; penalize oversized files so
        // an adaptive HLS/DASH stream with a matching variant wins first.
        const ratioOver = (q - target) / target;
        pts += Math.max(125, 185 - ratioOver * 35);
      } else {
        // Verified lower resolution stays well above unknown-resolution guesses.
        pts += 120 + Math.pow(q / target, 0.85) * 68;
      }
    } else {
      // Adaptive HLS / DASH: any stream with max resolution >= target can pick the <= target variant.
      if (q >= target) {
        const tinyOver = Math.min(4, ((q - target) / target) * 2);
        pts += 200 - tinyOver;
      } else {
        pts += 120 + Math.pow(q / target, 0.85) * 68;
      }
    }
  } else {
    // Unknown resolution ranks strictly below verified HD/SD streams.
    pts += isFixedFile ? 72 : 108;
  }

  // Delivery method tie-breaker at equal resolution fit
  if (isFixedFile) {
    if (c.providerId === "jellyfin") pts += 24;
    else if (q == null || q <= target) pts += 18;
    else pts += 4;
  } else if (c.kind === "hls") {
    pts += c.via === "direct" ? 15 : 8;
  } else if (c.kind === "dash") {
    pts += 11;
  }

  // Season consistency bonus: keeps episodes locked onto the same verified server when available.
  if (opts?.preferredProviderId && c.providerId === opts.preferredProviderId) {
    pts += q != null && q >= target ? 24 : 5;
  }

  // Measured latency, subtitle availability & audio richness
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
export function rankDownloadOptions(
  candidates: StreamCandidate[],
  preferredQuality = 1080,
  opts?: { preferredProviderId?: string },
): StreamCandidate[] {
  const ranked = candidates
    .filter(isDownloadableCandidate)
    .map((c) => ({ c, s: downloadScore(c, preferredQuality, opts) }))
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

/** Detect source container extension from candidate URL when known. */
export function sourceContainerExt(c: StreamCandidate): string {
  const raw = unwrapProxyUrl(c.downloadUrl ?? c.url).url.split(/[?#]/)[0].toLowerCase();
  if (raw.endsWith(".mkv")) return "mkv";
  if (raw.endsWith(".webm")) return "webm";
  if (raw.endsWith(".mov")) return "mov";
  if (raw.endsWith(".m4v")) return "m4v";
  if (raw.endsWith(".mp4")) return "mp4";
  return "";
}

/** Container/delivery format label shown beside each server option, reflecting user's target format. */
export function downloadFormatLabel(c: StreamCandidate, targetFormat: DownloadFormat = "mp4"): string {
  const dst = targetFormat.toUpperCase();
  if (c.downloadUrl) {
    const ext = sourceContainerExt(c).toUpperCase();
    if (!ext) return "Original";
    return ext !== dst ? `${ext} → ${dst}` : ext;
  }
  if (c.kind === "hls") return `HLS → ${dst}`;
  if (c.kind === "dash") return `DASH → ${dst}`;
  const srcExt = sourceContainerExt(c).toUpperCase();
  if (srcExt) return srcExt !== dst ? `${srcExt} → ${dst}` : srcExt;
  return `Direct → ${dst}`;
}
