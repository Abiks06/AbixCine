import { describe, expect, it, vi } from "vitest";
import { selectMissingEpisodes } from "./batchDownload";
import { fmtEta, fmtSpeed, groupDownloadedTitles, hasDownloadedEpisode, type DownloadedEntry, type DownloadJob } from "./downloads";
import type { Episode } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://local/${encodeURIComponent(p)}`,
}));

const mkEntry = (overrides: Partial<DownloadedEntry> = {}): DownloadedEntry => ({
  id: "dl_1",
  mediaKey: "tmdb:tv:100",
  canonicalKey: "tmdb:tv:100",
  title: "Andor",
  mediaKind: "tv",
  isFilm: false,
  year: 2022,
  season: 1,
  episode: 1,
  episodeTitle: "Kassa",
  quality: 1080,
  providerId: "vixsrc",
  providerName: "VixSrc",
  filePath: "C:/Downloads/Series/Andor (2022)/Season 01/Andor - S01E01.mp4",
  fileSize: 500_000_000,
  subtitlePaths: [],
  downloadedAt: 1000,
  ...overrides,
});

describe("selectMissingEpisodes", () => {
  const episodes: Episode[] = [
    { season: 1, number: 1, title: "Kassa", airDate: "2022-09-21" },
    { season: 1, number: 2, title: "That Would Be Me", airDate: "2022-09-21" },
    { season: 1, number: 3, title: "Reckoning", airDate: "2022-09-21" },
    { season: 1, number: 4, title: "Unaired Future", airDate: "2099-01-01" },
  ];

  it("skips saved, queued/paused, and unaired episodes while honoring anime audio", () => {
    const items: DownloadedEntry[] = [
      mkEntry({ id: "saved_1", episode: 1, audio: "sub" }),
    ];
    const jobs: DownloadJob[] = [
      {
        id: "job_2",
        root: "C:/Downloads",
        mediaKey: "tmdb:tv:100",
        canonicalKey: "tmdb:tv:100",
        title: "Andor",
        mediaKind: "tv",
        isFilm: false,
        season: 1,
        episode: 2,
        audio: "sub",
        providerId: "vixsrc",
        providerName: "VixSrc",
        url: "https://cdn/ep2.m3u8",
        kind: "hls",
        status: "paused",
        bytesDownloaded: 100,
        speedBps: 0,
        percent: 10,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    const subMissing = selectMissingEpisodes(episodes, {
      canonicalKey: "tmdb:tv:100",
      season: 1,
      audio: "sub",
      items,
      jobs,
    });
    expect(subMissing.map((e) => e.number)).toEqual([3]);

    // Switching to Dub sees E1 & E2 missing because saved/queued copies are Sub-only.
    const dubMissing = selectMissingEpisodes(episodes, {
      canonicalKey: "tmdb:tv:100",
      season: 1,
      audio: "dub",
      items,
      jobs,
    });
    expect(dubMissing.map((e) => e.number)).toEqual([1, 2, 3]);
  });
});

describe("groupDownloadedTitles & formatting helpers", () => {
  it("groups episodes by canonicalKey, sorts S/E ascending, sums size, and prefers local art", () => {
    const groups = groupDownloadedTitles([
      mkEntry({
        id: "e3",
        episode: 3,
        fileSize: 300,
        downloadedAt: 2000,
        posterPath: "C:/Downloads/.abixcine/art/andor_poster.jpg",
      }),
      mkEntry({ id: "e1", episode: 1, fileSize: 200, downloadedAt: 1000, quality: 720 }),
      mkEntry({
        id: "m1",
        mediaKey: "tmdb:movie:693134",
        canonicalKey: "tmdb:movie:693134",
        title: "Dune: Part Two",
        mediaKind: "movie",
        isFilm: true,
        season: undefined,
        episode: undefined,
        fileSize: 1500,
        downloadedAt: 5000,
      }),
    ]);

    expect(groups.map((g) => g.canonicalKey)).toEqual(["tmdb:movie:693134", "tmdb:tv:100"]);
    const show = groups[1];
    expect(show.entries.map((e) => e.episode)).toEqual([1, 3]);
    expect(show.totalSize).toBe(500);
    expect(show.bestQuality).toBe(1080);
    expect(show.media.poster).toContain("asset://local/");
    expect(hasDownloadedEpisode("tmdb:tv:100", 1, 3, undefined, show.entries)).toBe(true);
    expect(hasDownloadedEpisode("tmdb:tv:100", 1, 2, undefined, show.entries)).toBe(false);
  });

  it("formats speed and remaining ETA cleanly", () => {
    expect(fmtSpeed(0)).toBe("");
    expect(fmtSpeed(512 * 1024)).toBe("512 KB/s");
    expect(fmtSpeed(12.4 * 1024 * 1024)).toBe("12.4 MB/s");
    expect(fmtEta(42)).toBe("42s");
    expect(fmtEta(74)).toBe("1m 14s");
    expect(fmtEta(3840)).toBe("1h 4m");
  });
});
