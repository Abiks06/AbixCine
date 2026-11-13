import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpFetch } from "../sources/native";
import {
  checkDebridInstantCache,
  DebridError,
  loadDebridConfig,
  normalizeInfoHash,
  resolveDebridStream,
  saveDebridConfig,
  toMagnetUri,
} from "./debrid";

vi.mock("../sources/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/native")>();
  return {
    ...actual,
    httpFetch: vi.fn(),
  };
});

const mockHttpFetch = vi.mocked(httpFetch);

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
// 20 bytes of 0x01..0x14 encoded in base32
const BASE32_HASH = "AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYU";
const HEX_FROM_BASE32 = "0102030405060708090a0b0c0d0e0f1011121314";

beforeEach(() => {
  mockHttpFetch.mockReset();
  localStorage.removeItem("abx.debrid.v1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("normalizeInfoHash & toMagnetUri", () => {
  it("normalizes 40-char hex, 32-char base32, and magnet URIs", () => {
    expect(normalizeInfoHash(HASH_A.toUpperCase())).toBe(HASH_A);
    expect(normalizeInfoHash(BASE32_HASH)).toBe(HEX_FROM_BASE32);
    expect(normalizeInfoHash(`magnet:?xt=urn:btih:${HASH_B.toUpperCase()}&dn=Movie`)).toBe(HASH_B);
    expect(normalizeInfoHash(`magnet:?xt=urn:btih:${BASE32_HASH}`)).toBe(HEX_FROM_BASE32);
    expect(normalizeInfoHash("not-a-hash")).toBeNull();
  });

  it("constructs magnet URIs with trackers and preserves existing magnet URIs", () => {
    expect(toMagnetUri(HASH_A, ["udp://tracker.example:1337/announce"])).toEqual({
      infoHash: HASH_A,
      magnetUri: `magnet:?xt=urn:btih:${HASH_A}&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce`,
    });
    expect(toMagnetUri(`magnet:?xt=urn:btih:${HASH_B}&dn=Test`)).toEqual({
      infoHash: HASH_B,
      magnetUri: `magnet:?xt=urn:btih:${HASH_B}&dn=Test`,
    });
    expect(toMagnetUri("invalid")).toBeNull();
  });
});

describe("checkDebridInstantCache", () => {
  it("checks Real-Debrid instantAvailability and parses cached file lists", async () => {
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://api.real-debrid.com/rest/1.0/torrents/instantAvailability",
      body: JSON.stringify({
        [HASH_A]: {
          rd: [
            {
              "1": { filename: "Movie.2024.1080p.mkv", filesize: 4_200_000_000 },
              "2": { filename: "Movie.2024.srt", filesize: 42_000 },
            },
          ],
        },
        [HASH_B]: [],
      }),
    });

    const result = await checkDebridInstantCache("realdebrid", "rd-key", [HASH_A.toUpperCase(), HASH_B]);
    expect(mockHttpFetch).toHaveBeenCalledWith(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${HASH_A}/${HASH_B}`,
      expect.objectContaining({ Authorization: "Bearer rd-key" }),
      undefined,
    );
    expect(result[HASH_A].cached).toBe(true);
    expect(result[HASH_A].files).toHaveLength(2);
    expect(result[HASH_B].cached).toBe(false);
  });

  it("checks TorBox checkcached for both list and object response shapes", async () => {
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://api.torbox.app/v1/api/torrents/checkcached",
      body: JSON.stringify({
        success: true,
        data: [
          {
            hash: HASH_A,
            files: [{ id: 0, short_name: "Show.S01E01.mkv", size: 1_500_000_000 }],
          },
        ],
      }),
    });

    const resList = await checkDebridInstantCache("torbox", "tb-key", [HASH_A, HASH_B]);
    expect(resList[HASH_A]).toEqual({
      infoHash: HASH_A,
      cached: true,
      files: [{ id: 0, filename: "Show.S01E01.mkv", sizeBytes: 1_500_000_000 }],
    });
    expect(resList[HASH_B].cached).toBe(false);
  });

  it("checks AllDebrid magnet/instant", async () => {
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://api.alldebrid.com/v4/magnet/instant",
      body: JSON.stringify({
        status: "success",
        data: {
          magnets: [
            { hash: HASH_A, instant: true, files: [{ n: "Film.mp4", s: 900_000_000 }] },
            { hash: HASH_B, instant: false },
          ],
        },
      }),
    });

    const res = await checkDebridInstantCache("alldebrid", "ad-key", [HASH_A, HASH_B]);
    expect(res[HASH_A]).toEqual({
      infoHash: HASH_A,
      cached: true,
      files: [{ id: 0, filename: "Film.mp4", sizeBytes: 900_000_000 }],
    });
    expect(res[HASH_B].cached).toBe(false);
  });

  it("returns empty map when infoHashes has no valid hashes", async () => {
    const res = await checkDebridInstantCache("realdebrid", "rd-key", []);
    expect(res).toEqual({});
    expect(mockHttpFetch).not.toHaveBeenCalled();
  });
});

describe("resolveDebridStream", () => {
  it("resolves a Real-Debrid magnet, mapping 0-based fileIdx to RD file ID and unrestricting link", async () => {
    mockHttpFetch
      .mockResolvedValueOnce({
        status: 201,
        url: "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
        body: JSON.stringify({ id: "TOR123" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.real-debrid.com/rest/1.0/torrents/info/TOR123",
        body: JSON.stringify({
          id: "TOR123",
          status: "waiting_files_selection",
          files: [
            { id: 1, path: "/Season 1/Show.S01E01.mkv", bytes: 1_000_000_000, selected: 0 },
            { id: 2, path: "/Season 1/Show.S01E02.mkv", bytes: 1_200_000_000, selected: 0 },
          ],
        }),
      })
      .mockResolvedValueOnce({
        status: 204,
        url: "https://api.real-debrid.com/rest/1.0/torrents/selectFiles/TOR123",
        body: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.real-debrid.com/rest/1.0/torrents/info/TOR123",
        body: JSON.stringify({
          id: "TOR123",
          status: "downloaded",
          files: [
            { id: 1, path: "/Season 1/Show.S01E01.mkv", bytes: 1_000_000_000, selected: 0 },
            { id: 2, path: "/Season 1/Show.S01E02.mkv", bytes: 1_200_000_000, selected: 1 },
          ],
          links: ["https://real-debrid.com/d/UNRESTRICT_ME"],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.real-debrid.com/rest/1.0/unrestrict/link",
        body: JSON.stringify({
          download: "https://s1.real-debrid.com/d/DIRECT/Show.S01E02.mkv",
          filename: "Show.S01E02.mkv",
          filesize: 1_200_000_000,
        }),
      });

    const out = await resolveDebridStream("realdebrid", "rd-key", HASH_A, 1);
    expect(out).toEqual({
      url: "https://s1.real-debrid.com/d/DIRECT/Show.S01E02.mkv",
      filename: "Show.S01E02.mkv",
      sizeBytes: 1_200_000_000,
    });
    expect(mockHttpFetch).toHaveBeenNthCalledWith(
      3,
      "https://api.real-debrid.com/rest/1.0/torrents/selectFiles/TOR123",
      expect.objectContaining({ Authorization: "Bearer rd-key" }),
      { method: "POST", body: "files=2" },
    );
  });

  it("auto-selects largest non-sample video file on TorBox when fileIdx is omitted", async () => {
    mockHttpFetch
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.torbox.app/v1/api/torrents/createtorrent",
        body: JSON.stringify({ success: true, data: { torrent_id: 77 } }),
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.torbox.app/v1/api/torrents/mylist",
        body: JSON.stringify({
          success: true,
          data: {
            id: 77,
            cached: true,
            download_present: true,
            files: [
              { id: 10, short_name: "sample.mkv", size: 5_000_000_000 },
              { id: 11, short_name: "movie.nfo", size: 2_000 },
              { id: 12, short_name: "Movie.2160p.mkv", size: 3_500_000_000 },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.torbox.app/v1/api/torrents/requestdl",
        body: JSON.stringify({ success: true, data: "https://cdn.torbox.app/dl/Movie.2160p.mkv" }),
      });

    const out = await resolveDebridStream("torbox", "tb-key", HASH_A);
    expect(out).toEqual({
      url: "https://cdn.torbox.app/dl/Movie.2160p.mkv",
      filename: "Movie.2160p.mkv",
      sizeBytes: 3_500_000_000,
    });
    expect(mockHttpFetch).toHaveBeenNthCalledWith(
      3,
      "https://api.torbox.app/v1/api/torrents/requestdl?token=tb-key&torrent_id=77&file_id=12",
      expect.objectContaining({ Authorization: "Bearer tb-key" }),
      undefined,
    );
  });

  it("resolves an AllDebrid stream via upload -> status -> unlock", async () => {
    mockHttpFetch
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.alldebrid.com/v4/magnet/upload",
        body: JSON.stringify({ status: "success", data: { magnets: [{ id: 99, ready: true }] } }),
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.alldebrid.com/v4/magnet/status",
        body: JSON.stringify({
          status: "success",
          data: {
            magnets: {
              id: 99,
              statusCode: 4,
              status: "Ready",
              links: [
                { link: "https://alldebrid.com/f/sub", filename: "subs.srt", size: 10_000 },
                { link: "https://alldebrid.com/f/vid", filename: "Movie.1080p.mp4", size: 2_000_000_000 },
              ],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        url: "https://api.alldebrid.com/v4/link/unlock",
        body: JSON.stringify({
          status: "success",
          data: {
            link: "https://dl.alldebrid.com/Movie.1080p.mp4",
            filename: "Movie.1080p.mp4",
            filesize: 2_000_000_000,
          },
        }),
      });

    const out = await resolveDebridStream("alldebrid", "ad-key", `magnet:?xt=urn:btih:${HASH_A}`);
    expect(out).toEqual({
      url: "https://dl.alldebrid.com/Movie.1080p.mp4",
      filename: "Movie.1080p.mp4",
      sizeBytes: 2_000_000_000,
    });
  });
});

describe("Debrid error handling & AbortSignal", () => {
  it("throws DebridError INVALID_KEY on empty key, HTTP 401, HTTP 403, and provider auth error", async () => {
    await expect(checkDebridInstantCache("realdebrid", "   ", [HASH_A])).rejects.toMatchObject({
      name: "DebridError",
      code: "INVALID_KEY",
    });

    mockHttpFetch.mockResolvedValueOnce({ status: 401, url: "x", body: "{}" });
    await expect(checkDebridInstantCache("realdebrid", "bad", [HASH_A])).rejects.toMatchObject({
      code: "INVALID_KEY",
      status: 401,
    });

    mockHttpFetch.mockResolvedValueOnce({ status: 403, url: "x", body: "{}" });
    await expect(checkDebridInstantCache("torbox", "bad", [HASH_A])).rejects.toMatchObject({
      code: "INVALID_KEY",
      status: 403,
    });

    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "x",
      body: JSON.stringify({ status: "error", error: { code: "AUTH_BAD_APIKEY", message: "Bad key" } }),
    });
    await expect(checkDebridInstantCache("alldebrid", "bad", [HASH_A])).rejects.toMatchObject({
      code: "INVALID_KEY",
    });
  });

  it("throws DebridError RATE_LIMIT on HTTP 429", async () => {
    mockHttpFetch.mockResolvedValueOnce({ status: 429, url: "x", body: "{}" });
    await expect(checkDebridInstantCache("realdebrid", "key", [HASH_A])).rejects.toMatchObject({
      code: "RATE_LIMIT",
      status: 429,
    });
  });

  it("throws DebridError UNCACHED when torrent is not cached", async () => {
    mockHttpFetch
      .mockResolvedValueOnce({ status: 201, url: "x", body: JSON.stringify({ id: "TOR1" }) })
      .mockResolvedValueOnce({
        status: 200,
        url: "x",
        body: JSON.stringify({ id: "TOR1", status: "downloading", files: [] }),
      });
    await expect(resolveDebridStream("realdebrid", "key", HASH_A)).rejects.toMatchObject({
      code: "UNCACHED",
      provider: "realdebrid",
    });

    mockHttpFetch
      .mockResolvedValueOnce({ status: 200, url: "x", body: JSON.stringify({ success: true, data: { torrent_id: 5 } }) })
      .mockResolvedValueOnce({
        status: 200,
        url: "x",
        body: JSON.stringify({ success: true, data: { id: 5, cached: false, download_present: false, files: [] } }),
      });
    await expect(resolveDebridStream("torbox", "key", HASH_A)).rejects.toMatchObject({
      code: "UNCACHED",
      provider: "torbox",
    });

    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "x",
      body: JSON.stringify({ status: "success", data: { magnets: [{ id: 9, ready: false }] } }),
    });
    await expect(resolveDebridStream("alldebrid", "key", HASH_A)).rejects.toMatchObject({
      code: "UNCACHED",
      provider: "alldebrid",
    });
  });

  it("rejects with DebridError TIMEOUT when request exceeds timeout", async () => {
    vi.useFakeTimers();
    mockHttpFetch.mockImplementation(() => new Promise(() => {}));

    const pending = checkDebridInstantCache("realdebrid", "key", [HASH_A]);
    const assertion = expect(pending).rejects.toBeInstanceOf(DebridError);
    const codeCheck = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });

    await vi.advanceTimersByTimeAsync(12_100);
    await assertion;
    await codeCheck;
  });

  it("rejects immediately with AbortError before and during requests", async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(checkDebridInstantCache("realdebrid", "key", [HASH_A], pre.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mockHttpFetch).not.toHaveBeenCalled();

    const mid = new AbortController();
    mockHttpFetch.mockImplementation(() => new Promise(() => {}));
    const pending = resolveDebridStream("torbox", "key", HASH_A, undefined, mid.signal);
    mid.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Debrid config storage", () => {
  it("persists and loads DebridConfig in abx.debrid.v1", () => {
    expect(loadDebridConfig()).toBeNull();
    saveDebridConfig({ provider: "torbox", apiKey: "  tb-123  " });
    expect(loadDebridConfig()).toEqual({ provider: "torbox", apiKey: "tb-123", enabled: true });
    saveDebridConfig(null);
    expect(loadDebridConfig()).toBeNull();
  });
});
