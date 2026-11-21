import { isTauri } from "@tauri-apps/api/core";
import { findDownloadedEntries, refreshDownloads } from "../lib/downloads";
import type { PlaybackRequest } from "../lib/types";
import { isFilm } from "../lib/types";
import {
  audioOf,
  buildLocalStreamCandidate,
  episodeMatches,
  parseEpisode,
  relativeToLibrary,
  scanLibrary,
  titleMatches,
  type LibFile,
} from "./local";
import type { SourceProvider } from "./types";

/**
 * Downloaded offline server provider.
 * Looks up exact matches from `.abixcine/index.json` first (instant O(1), preserves anime/TMDB IDs
 * and bundled sidecar subtitles), then falls back to scanning `s.downloadsPath` for any files
 * copied or renamed manually inside the dedicated Downloads folder.
 */
export const downloadsProvider: SourceProvider = {
  id: "downloads",
  name: "Downloaded",
  category: "local",
  priority: 65,
  isEnabled: (s) => isTauri() && Boolean(s.downloadsPath),
  async find(req: PlaybackRequest, s, signal) {
    if (signal?.aborted || !s.downloadsPath) return [];

    // Reconcile against disk so files deleted externally in File Explorer are dropped before playback.
    await refreshDownloads({ minIntervalMs: 1200 }).catch(() => null);
    if (signal?.aborted) return [];

    const exact = findDownloadedEntries(req);
    const seenPaths = new Set<string>();
    const results = await Promise.all(
      exact.map(async (entry) => {
        seenPaths.add(entry.filePath.toLowerCase());
        const fileName = entry.filePath.split(/[\\/]/).pop() ?? entry.title;
        const fakeFile: LibFile = {
          path: entry.filePath,
          name: fileName.replace(/\.(mkv|mp4|m4v|webm|mov|ts|m3u8|avi)$/i, ""),
          size: entry.fileSize,
          subs: entry.subtitlePaths,
        };
        const audio =
          entry.audio === "sub" || entry.audio === "dub" || entry.audio === "dual"
            ? entry.audio
            : undefined;
        return buildLocalStreamCandidate(fakeFile, {
          providerId: "downloads",
          providerName: "Downloaded",
          quality: entry.quality,
          audio,
          signal,
        });
      }),
    );

    if (signal?.aborted) return results;

    // Also inspect downloadsPath via scanLibrary in case files were added/organized there manually.
    const root = s.downloadsPath;
    const files = await scanLibrary([root]).catch(() => [] as LibFile[]);
    if (signal?.aborted) return results;

    for (const f of files) {
      if (seenPaths.has(f.path.toLowerCase())) continue;
      const hay = relativeToLibrary(f.path, [root]).split(/[\\/]/).slice(-3).join(" ");
      if (!titleMatches(hay, req)) continue;
      const ep = parseEpisode(f.name, f.path);
      if (req.episode != null && !isFilm(req.media)) {
        if (!episodeMatches(ep, req)) continue;
      } else {
        if (ep.episode != null) continue;
      }
      const audio = req.audio ? audioOf(hay) : undefined;
      if (req.audio && audio && audio !== "dual" && audio !== req.audio) continue;

      seenPaths.add(f.path.toLowerCase());
      results.push(
        await buildLocalStreamCandidate(f, {
          providerId: "downloads",
          providerName: "Downloaded",
          audio,
          signal,
        }),
      );
    }

    return results;
  },
};
