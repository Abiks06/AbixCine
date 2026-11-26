import { describe, expect, it, vi } from "vitest";
import {
  __getBatchSnapshotForTest,
  __seedBatchQueueForTest,
  cancelBatchDownloads,
  getBatchForSeason,
  selectMissingEpisodes,
} from "./batchDownload";
import {
  computeSeasonDownloadProgress,
  findDownloadedEpisode,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  formatQualityTag,
  groupDownloadedTitles,
  hasDownloadedEpisode,
  normalizePathKey,
  type DownloadedEntry,
  type DownloadJob,
} from "./downloads";
import { normalizeDownloadQualityPolicy } from "./settings";
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

  it("re-selects episodes whose previous download failed", () => {
    const failedJob: DownloadJob = {
      id: "job_fail",
      root: "C:/Downloads",
      mediaKey: "tmdb:tv:100",
      canonicalKey: "tmdb:tv:100",
      title: "Andor",
      mediaKind: "tv",
      isFilm: false,
      season: 1,
      episode: 2,
      providerId: "vixsrc",
      providerName: "VixSrc",
      url: "https://cdn/fail.m3u8",
      kind: "hls",
      status: "failed",
      bytesDownloaded: 0,
      speedBps: 0,
      percent: 0,
      error: "HTTP 403",
      createdAt: 1000,
      updatedAt: 1000,
    };
    const missing = selectMissingEpisodes(episodes, {
      canonicalKey: "tmdb:tv:100",
      season: 1,
      items: [],
      jobs: [failedJob],
    });
    expect(missing.map((e) => e.number)).toEqual([1, 2, 3]);
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

  it("formats speed, remaining ETA, and quality verification cleanly", () => {
    expect(fmtSpeed(0)).toBe("");
    expect(fmtSpeed(512 * 1024)).toBe("512 KB/s");
    expect(fmtSpeed(12.4 * 1024 * 1024)).toBe("12.4 MB/s");
    expect(fmtEta(42)).toBe("42s");
    expect(fmtEta(74)).toBe("1m 14s");
    expect(fmtEta(3840)).toBe("1h 4m");
    expect(formatDownloadQuality({ resolvedQuality: 1080, qualityVerified: true, preferredQuality: 1080 })).toMatchObject({
      label: "1080p",
      verified: true,
    });
    expect(formatDownloadQuality({ quality: 720, qualityVerified: false })).toMatchObject({
      label: "~720p",
      verified: false,
    });
    expect(formatDownloadQuality({ preferredQuality: 1080 })).toMatchObject({
      label: "Up to 1080p",
      verified: false,
    });
    expect(formatQualityTag(2160, true)).toBe("4K ✓");
    expect(formatQualityTag(1080, false)).toBe("1080p");
    expect(formatQualityTag(undefined)).toBeNull();
  });

  it("computes season download progress across saved, downloading, paused, and unaired episodes", () => {
    const eps: Episode[] = [
      { season: 1, number: 1, title: "E1", airDate: "2022-09-21" },
      { season: 1, number: 2, title: "E2", airDate: "2022-09-21" },
      { season: 1, number: 3, title: "E3", airDate: "2022-09-21" },
      { season: 1, number: 4, title: "Future", airDate: "2099-01-01" },
    ];
    const saved = mkEntry({ episode: 1, quality: 1080, qualityVerified: true });
    expect(findDownloadedEpisode("tmdb:tv:100", 1, 1, undefined, [saved])?.quality).toBe(1080);

    const activeJob: DownloadJob = {
      id: "j2",
      root: "C:/Downloads",
      mediaKey: "tmdb:tv:100",
      canonicalKey: "tmdb:tv:100",
      title: "Andor",
      mediaKind: "tv",
      isFilm: false,
      season: 1,
      episode: 2,
      resolvedQuality: 1080,
      qualityVerified: true,
      providerId: "vixsrc",
      providerName: "VixSrc",
      url: "https://cdn/2.m3u8",
      kind: "hls",
      status: "downloading",
      bytesDownloaded: 50_000_000,
      speedBps: 4_000_000,
      percent: 60,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const prog = computeSeasonDownloadProgress(eps, {
      canonicalKey: "tmdb:tv:100",
      season: 1,
      items: [saved],
      jobs: [
        activeJob,
        {
          ...activeJob,
          id: "j3",
          episode: 3,
          status: "awaitingQuality",
          percent: 0,
        },
      ],
    });
    expect(prog.total).toBe(3);
    expect(prog.completed).toBe(1);
    expect(prog.active).toBe(1);
    expect(prog.awaitingQuality).toBe(1);
    expect(normalizeDownloadQualityPolicy(undefined)).toBe("ask");
    expect(normalizeDownloadQualityPolicy("STRICT")).toBe("strict");
    expect(normalizeDownloadQualityPolicy("best")).toBe("best");
    expect(selectMissingEpisodes(eps, {
      canonicalKey: "tmdb:tv:100",
      season: 1,
      items: [saved],
      jobs: [activeJob, { ...activeJob, id: "j3", episode: 3, status: "awaitingQuality", percent: 0 }],
    })).toEqual([]);
    expect(Math.round(prog.completedPercent)).toBe(33);
    expect(Math.round(prog.percent)).toBe(53);
    expect(prog.speedBps).toBe(4_000_000);
    expect(prog.downloadedQualities).toEqual(["1080p ✓"]);
    expect(prog.downloadingQualities).toEqual(["1080p ✓"]);

    const fullProg = computeSeasonDownloadProgress(eps, {
      canonicalKey: "tmdb:tv:100",
      season: 1,
      items: [
        mkEntry({ id: "1", episode: 1, quality: 1080, qualityVerified: true }),
        mkEntry({ id: "2", episode: 2, quality: 1080, qualityVerified: true }),
        mkEntry({ id: "3", episode: 3, quality: 2160, qualityVerified: false }),
      ],
      jobs: [],
    });
    expect(fullProg.completed).toBe(3);
    expect(fullProg.percent).toBe(100);
    expect(fullProg.downloadedQualities).toEqual(["1080p ✓", "4K"]);
  });

  it("normalizes Windows verbatim and slash paths consistently and guards scoped batch cancel", () => {
    expect(normalizePathKey("\\\\?\\C:\\Users\\Demo\\AbixCine Downloads\\")).toBe(
      "c:\\users\\demo\\abixcine downloads",
    );
    expect(normalizePathKey("C:/Users/Demo/AbixCine Downloads")).toBe(
      "c:\\users\\demo\\abixcine downloads",
    );
    expect(normalizePathKey("/mnt/media/Abix/")).toBe("/mnt/media/Abix");
    expect(cancelBatchDownloads({ silent: true })).toBe(false);
  });

  it("cancels only the targeted season when multiple seasons are queued", () => {
    const show = {
      key: "tmdb:tv:100",
      canonicalKey: "tmdb:tv:100",
      kind: "tv" as const,
      title: "Andor",
      overview: "",
      genres: [],
      cast: [],
      crew: [],
      related: [],
    };
    __seedBatchQueueForTest([
      {
        detail: show,
        season: 1,
        episodes: [
          { season: 1, number: 1, title: "S1E1" },
          { season: 1, number: 2, title: "S1E2" },
        ],
      },
      {
        detail: show,
        season: 2,
        episodes: [{ season: 2, number: 1, title: "S2E1" }],
      },
    ]);

    const initial = __getBatchSnapshotForTest();
    expect(initial.total).toBe(3);
    expect(getBatchForSeason(initial, "tmdb:tv:100", 1)?.total).toBe(2);
    expect(getBatchForSeason(initial, "tmdb:tv:100", 2)?.total).toBe(1);

    // Cancelling Season 1 clears only Season 1 and preserves Season 2
    expect(cancelBatchDownloads({ silent: true, canonicalKey: "tmdb:tv:100", season: 1 })).toBe(true);
    const afterS1 = __getBatchSnapshotForTest();
    expect(getBatchForSeason(afterS1, "tmdb:tv:100", 1)).toBeUndefined();
    expect(getBatchForSeason(afterS1, "tmdb:tv:100", 2)?.total).toBe(1);
    expect(afterS1.total).toBe(1);

    // Cancelling Season 2 clears remaining queue completely
    expect(cancelBatchDownloads({ silent: true, canonicalKey: "tmdb:tv:100", season: 2 })).toBe(true);
    const afterAll = __getBatchSnapshotForTest();
    expect(afterAll.active).toBe(false);
    expect(afterAll.total).toBe(0);
  });

  it("does not drop a newly queued season immediately after unscoped cancellation", () => {
    const show = {
      key: "tmdb:tv:200",
      canonicalKey: "tmdb:tv:200",
      kind: "tv" as const,
      title: "Severance",
      overview: "",
      genres: [],
      cast: [],
      crew: [],
      related: [],
    };
    __seedBatchQueueForTest([
      { detail: show, season: 1, episodes: [{ season: 1, number: 1, title: "S1E1" }] },
    ]);
    expect(cancelBatchDownloads({ silent: true })).toBe(true);

    __seedBatchQueueForTest([
      { detail: show, season: 2, episodes: [{ season: 2, number: 1, title: "S2E1" }] },
    ]);
    const snap = __getBatchSnapshotForTest();
    expect(snap.active).toBe(true);
    expect(snap.total).toBe(1);
    expect(getBatchForSeason(snap, "tmdb:tv:200", 2)?.total).toBe(1);
    cancelBatchDownloads({ silent: true });
  });
});
