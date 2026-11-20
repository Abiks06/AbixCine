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

/**
 * Implicit quality & reliability score for ordering downloadable server options
 * from best to worst without presenting explicit judgement badges.
 */
export function downloadScore(c: StreamCandidate, preferredQuality = 1080): number {
  let pts = 0;

  // 1. Source delivery method (original file / direct HTTP beats multi-segment HLS)
  if (c.downloadUrl || c.kind === "file") {
    pts += c.providerId === "jellyfin" ? 130 : 120;
  } else if (c.kind === "hls") {
    pts += c.via === "direct" ? 85 : 65;
  }

  // 2. Resolution fit against the user's preferred quality ceiling
  const q = c.probe?.quality ?? c.quality ?? 720;
  const qRatio = q <= preferredQuality ? q / Math.max(preferredQuality, 1) : 1 - (q - preferredQuality) / (preferredQuality * 4);
  pts += Math.max(0, Math.min(1.05, qRatio)) * 45;

  // 3. Measured server speed + subtitle availability + dual-audio richness
  const latencyMs = c.probe?.latencyMs ?? 1200;
  const speedPts = (1 - Math.min(latencyMs, 8000) / 8000) * 18;
  pts += speedPts;

  const subCount = Math.min(4, c.subtitles?.length ?? 0);
  pts += subCount * 2.5;
  if (c.audio === "dual") pts += 4;
  if (c.score != null && Number.isFinite(c.score)) {
    pts += Math.max(-20, Math.min(20, c.score * 0.15));
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
