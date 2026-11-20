import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setDownloadsStateForTest,
  findDownloadedEntries,
  findOfflineDetail,
  findOfflineSeasonEpisodes,
} from "../lib/downloads";
import { getSettings } from "../lib/settings";
import { downloadsProvider } from "./downloads";
import { SourceSession } from "./session";
import type { SourceProvider, StreamCandidate } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string) => (cmd === "scan_library" ? { files: [], errors: [] } : [])),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

describe("downloads offline store & local server provider", () => {
  afterEach(() => {
    __setDownloadsStateForTest({ root: null, jobs: [], items: [] });
    vi.restoreAllMocks();
  });

  it("matches downloaded entries and builds offline MediaDetail + Season episodes", async () => {
    __setDownloadsStateForTest({
      root: "C:/Downloads",
      items: [
        {
          id: "dl_1",
          mediaKey: "tmdb:tv:95396",
          canonicalKey: "tmdb:tv:95396",
          title: "Severance",
          mediaKind: "tv",
          isFilm: false,
          year: 2022,
          season: 1,
          episode: 2,
          episodeTitle: "Half Loop",
          quality: 1080,
          providerId: "vidlink-direct",
          providerName: "VidLink",
          filePath: "C:/Downloads/Series/Severance (2022)/Season 01/Severance - S01E02 [1080p].mp4",
          fileSize: 550_000_000,
          subtitlePaths: ["C:/Downloads/Series/Severance (2022)/Season 01/Severance - S01E02 [1080p].en.vtt"],
          downloadedAt: 1_700_000_000_000,
          mediaSnapshot: {
            key: "tmdb:tv:95396",
            canonicalKey: "tmdb:tv:95396",
            kind: "tv",
            title: "Severance",
            overview: "Mark leads a team whose memories have been surgically divided.",
            genres: ["Drama", "Sci-Fi"],
            year: 2022,
            seasons: [{ number: 1, name: "Season 1", episodeCount: 9, status: "aired" }],
          },
        },
      ],
    });

    const matches = findDownloadedEntries({
      media: { key: "tmdb:tv:95396", kind: "tv", title: "Severance", overview: "", genres: [] },
      season: 1,
      episode: 2,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].filePath).toContain("S01E02");

    const offline = findOfflineDetail("tmdb:tv:95396");
    expect(offline?.title).toBe("Severance");
    expect(offline?.seasons?.[0]?.episodeCount).toBe(9);

    const eps = findOfflineSeasonEpisodes("tmdb:tv:95396", 1);
    expect(eps).toEqual([
      {
        season: 1,
        number: 2,
        title: "Half Loop",
        overview: "Saved offline (VidLink)",
        sourceKey: "tmdb:tv:95396",
        courEpisode: 2,
      },
    ]);

    const cands = await downloadsProvider.find(
      {
        media: { key: "tmdb:tv:95396", kind: "tv", title: "Severance", overview: "", genres: [] },
        season: 1,
        episode: 2,
      },
      { ...getSettings(), downloadsPath: "C:/Downloads" },
      new AbortController().signal,
    );
    expect(cands).toHaveLength(1);
    expect(cands[0].providerId).toBe("downloads");
    expect(cands[0].localPath).toContain("S01E02");
    expect(cands[0].subtitles?.[0]?.source).toBe("sidecar");
  });

  it("resolves downloadsProvider first in SourceSession and fast-paths offline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const navSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const remoteFind = vi.fn(async (): Promise<StreamCandidate[]> => []);

    const localCand: StreamCandidate = {
      providerId: "downloads",
      providerName: "Downloaded",
      label: "Dune.Part.Two.mp4",
      url: "asset://localhost/Dune.mp4",
      kind: "file",
      via: "direct",
      localPath: "C:/Downloads/Movies/Dune (2024)/Dune (2024).mp4",
      quality: 1080,
    };

    const mockDownloads: SourceProvider = {
      id: "downloads",
      name: "Downloaded",
      category: "local",
      priority: downloadsProvider.priority,
      isEnabled: () => true,
      find: async () => [localCand],
    };
    const mockRemote: SourceProvider = {
      id: "vidlink-direct",
      name: "VidLink",
      category: "external",
      priority: 25,
      isEnabled: () => true,
      find: remoteFind,
    };

    const session = new SourceSession(
      { media: { key: "tmdb:movie:693134", kind: "movie", title: "Dune: Part Two", overview: "", genres: [] } },
      {
        providers: [mockDownloads, mockRemote],
        settings: getSettings(),
        probe: async (c) => ({ ...c, probe: { ok: true, latencyMs: 2, quality: 1080 } }),
        capture: async (c) => c,
        confirm: async () => ({ ok: true }),
      },
    );

    session.start(1);
    await vi.advanceTimersByTimeAsync(50);

    expect(remoteFind).not.toHaveBeenCalled();
    expect(session.getSnapshot().pick?.providerId).toBe("downloads");
    expect(session.getSnapshot().lanes.find((l) => l.providerId === "vidlink-direct")?.status).toBe("empty");

    navSpy.mockRestore();
    vi.useRealTimers();
  });
});
