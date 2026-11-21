import { describe, expect, it } from "vitest";
import { downloadFormatLabel, downloadScore, isDownloadableCandidate, rankDownloadOptions } from "./downloadRank";
import type { StreamCandidate } from "../sources/types";

const makeCand = (overrides: Partial<StreamCandidate> = {}): StreamCandidate => ({
  providerId: "vidlink-direct",
  providerName: "VidLink",
  label: "1080p",
  url: "https://cdn.example/stream.m3u8",
  kind: "hls",
  via: "direct",
  probe: { ok: true, latencyMs: 120, quality: 1080 },
  ...overrides,
});

describe("isDownloadableCandidate", () => {
  it("excludes local files, embeds, dash, magnets, mismatches, and expired links", () => {
    expect(isDownloadableCandidate(makeCand({ providerId: "local", kind: "file" }))).toBe(false);
    expect(isDownloadableCandidate(makeCand({ providerId: "downloads", kind: "file" }))).toBe(false);
    expect(isDownloadableCandidate(makeCand({ kind: "embed", via: "embed" }))).toBe(false);
    expect(isDownloadableCandidate(makeCand({ kind: "dash", url: "https://cdn.example/a.mpd" }))).toBe(false);
    expect(isDownloadableCandidate(makeCand({ kind: "file", url: "magnet:?xt=urn:btih:123" }))).toBe(false);
    expect(isDownloadableCandidate(makeCand({ identity: { status: "mismatch" } }))).toBe(false);
    expect(
      isDownloadableCandidate(
        makeCand({ url: "https://cdn.example/a.m3u8?expires=1600000000" }),
      ),
    ).toBe(false);
    expect(isDownloadableCandidate(makeCand({ probe: { ok: false, latencyMs: 50, error: "404" } }))).toBe(false);
  });

  it("allows verified direct files, direct/sniffed HLS streams, and Jellyfin original downloads", () => {
    expect(isDownloadableCandidate(makeCand({ kind: "file", url: "https://cdn.example/movie.mp4" }))).toBe(true);
    expect(isDownloadableCandidate(makeCand({ kind: "hls", via: "sniffed" }))).toBe(true);
    expect(
      isDownloadableCandidate(
        makeCand({
          providerId: "jellyfin",
          kind: "hls",
          probe: undefined,
          downloadUrl: "http://192.168.1.10:8096/Items/abc/Download?api_key=123",
        }),
      ),
    ).toBe(true);
  });
});

describe("rankDownloadOptions", () => {
  it("implicitly orders original/direct files ahead of direct HLS ahead of sniffed HLS", () => {
    const sniffed = makeCand({
      providerId: "vidfast",
      providerName: "VidFast",
      url: "https://cdn.example/sniffed.m3u8",
      kind: "hls",
      via: "sniffed",
      probe: { ok: true, latencyMs: 90, quality: 1080 },
    });
    const directHls = makeCand({
      providerId: "vixsrc",
      providerName: "VixSrc",
      url: "https://cdn.example/direct.m3u8",
      kind: "hls",
      via: "direct",
      probe: { ok: true, latencyMs: 110, quality: 1080 },
    });
    const directFile = makeCand({
      providerId: "animeheaven",
      providerName: "AnimeHeaven",
      url: "https://cdn.example/ep1.mp4",
      kind: "file",
      via: "direct",
      probe: { ok: true, latencyMs: 160, quality: 1080 },
    });
    const jellyfinOrig = makeCand({
      providerId: "jellyfin",
      providerName: "Jellyfin",
      url: "http://192.168.1.10:8096/Videos/1/master.m3u8",
      downloadUrl: "http://192.168.1.10:8096/Items/1/Download?api_key=k",
      kind: "hls",
      via: "direct",
      probe: { ok: true, latencyMs: 50, quality: 1080 },
    });

    const ranked = rankDownloadOptions([sniffed, directHls, directFile, jellyfinOrig], 1080);
    expect(ranked.map((c) => c.providerId)).toEqual(["jellyfin", "animeheaven", "vixsrc", "vidfast"]);
    expect(downloadScore(jellyfinOrig, 1080)).toBeGreaterThan(downloadScore(directFile, 1080));
  });

  it("weighs resolution fit and deduplicates matching stream URLs", () => {
    const hd = makeCand({ providerId: "a", url: "https://cdn.example/same.mp4", kind: "file", probe: { ok: true, latencyMs: 400, quality: 1080 } });
    const sd = makeCand({ providerId: "b", url: "https://cdn.example/sd.mp4", kind: "file", probe: { ok: true, latencyMs: 100, quality: 480 } });
    const dup = makeCand({ providerId: "c", url: "https://cdn.example/same.mp4", kind: "file", probe: { ok: true, latencyMs: 900, quality: 1080 } });

    const ranked = rankDownloadOptions([sd, dup, hd], 1080);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].providerId).toBe("a");
    expect(ranked[1].providerId).toBe("b");
  });

  it("ranks 1080p HLS strictly ahead of 480p/640p or unknown-quality direct files when targeting 1080p", () => {
    const sd480File = makeCand({
      providerId: "low480",
      url: "https://cdn.example/480.mp4",
      kind: "file",
      via: "direct",
      probe: { ok: true, latencyMs: 60, quality: 480 },
    });
    const sd640File = makeCand({
      providerId: "low640",
      url: "https://cdn.example/640.mp4",
      kind: "file",
      via: "direct",
      probe: { ok: true, latencyMs: 60, quality: 640 },
    });
    const unknownFile = makeCand({
      providerId: "unknown-file",
      url: "https://cdn.example/unknown.mp4",
      kind: "file",
      via: "direct",
      probe: { ok: true, latencyMs: 50 },
    });
    const hdSniffedHls = makeCand({
      providerId: "hd-hls",
      url: "https://cdn.example/1080.m3u8",
      kind: "hls",
      via: "sniffed",
      probe: { ok: true, latencyMs: 420, quality: 1080 },
    });

    const ranked = rankDownloadOptions([sd480File, sd640File, unknownFile, hdSniffedHls], 1080);
    expect(ranked[0].providerId).toBe("hd-hls");
    expect(ranked[ranked.length - 1].providerId).toBe("low480");
  });

  it("formats neutral delivery tags without Best/Worst judgements", () => {
    expect(downloadFormatLabel(makeCand({ downloadUrl: "http://jf/Download" }))).toBe("Original");
    expect(downloadFormatLabel(makeCand({ kind: "file", url: "https://cdn/movie.mkv?t=1" }))).toBe("MKV");
    expect(downloadFormatLabel(makeCand({ kind: "hls" }))).toBe("HLS → MP4");
  });
});
