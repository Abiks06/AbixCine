import { describe, expect, it } from "vitest";
import { diffShow, latestAired, alertText } from "../lib/alerts";
import { parseAniSkip } from "../lib/aniskip";
import { mergeRemote, type WatchRecord } from "../lib/history";
import type { Media, MediaDetail } from "../lib/types";
import { compareVersions, noteBlocks } from "../lib/updater";
import { engineFor, mpvTarget, skippableChapters } from "../player/mpv";
import { builtinCanPlay, hlsUrl, mediaInfo, providerIds } from "../sources/jellyfin";
import { idTags, idVerdict, needsMpvByName } from "../sources/local";
import type { StreamCandidate } from "../sources/types";

describe("ID tags and verdicts", () => {
  it("reads Jellyfin/Plex style tags", () => {
    expect(idTags("Dune (2021) {tmdb-438631} [imdbid-tt1160419]")).toEqual({ tmdb: 438631, imdb: "tt1160419" });
    expect(idTags("Frieren [anilist-154587] {tvdb-424536}")).toEqual({ anilist: 154587, tvdb: 424536 });
    expect(idTags("Plain Name 2021.mkv")).toEqual({});
  });

  it("an agreeing id matches, a disagreeing one doesn't, none is unknown", () => {
    expect(idVerdict({ tmdb: 1 }, { tmdb: 1, imdb: "tt9" })).toBe("match");
    expect(idVerdict({ tmdb: 2 }, { tmdb: 1 })).toBe("mismatch");
    expect(idVerdict({ imdb: "TT5" }, { imdb: "tt5" })).toBe("match");
    expect(idVerdict({ tvdb: 3 }, { tmdb: 1 })).toBe("unknown");
    expect(idVerdict({ tmdb: 1 }, undefined)).toBe("unknown");
  });

  it("doesn't compare a TMDB movie id with a TMDB show id", () => {
    expect(idVerdict({ tmdb: 1, tmdbKind: "movie" }, { tmdb: 2, tmdbKind: "tv" })).toBe("unknown");
  });

  it("spots files the built-in player can't handle", () => {
    expect(needsMpvByName("D:/TV/Show/Show.S01E01.1080p.x265.10bit.mkv")).toBe(true);
    expect(needsMpvByName("D:/Films/Movie.2019.2160p.REMUX.HDR.DTS-HD.mkv")).toBe(true);
    expect(needsMpvByName("D:/Films/Old.avi")).toBe(true);
    expect(needsMpvByName("D:/Films/Movie.2019.1080p.WEB.x264.AAC.mp4")).toBe(false);
  });
});

describe("Jellyfin", () => {
  const item = (video: any, audio: any, container = "mkv") => ({
    MediaSources: [{ Container: container, MediaStreams: [{ Type: "Video", ...video }, { Type: "Audio", IsDefault: true, ...audio }] }],
  });

  it("plays web-safe files directly and leaves the rest to mpv or HLS", () => {
    expect(builtinCanPlay(mediaInfo(item({ Codec: "h264", BitDepth: 8 }, { Codec: "aac", Channels: 2 }, "mp4")))).toBe(true);
    expect(builtinCanPlay(mediaInfo(item({ Codec: "hevc", BitDepth: 10, VideoRangeType: "HDR10" }, { Codec: "truehd", Channels: 8 })))).toBe(false);
    expect(builtinCanPlay(mediaInfo(item({ Codec: "h264", BitDepth: 10 }, { Codec: "aac" }, "mp4")))).toBe(false);
  });

  it("asks for surround and stream copy, not stereo at a low bitrate", () => {
    const u = new URL(hlsUrl("http://jf:8096/", "k", "abc", { video: { height: 2160 } }));
    expect(u.pathname).toBe("/Videos/abc/master.m3u8");
    expect(u.searchParams.get("MaxAudioChannels")).toBe("6");
    expect(u.searchParams.get("AllowVideoStreamCopy")).toBe("true");
    expect(u.searchParams.get("MaxHeight")).toBe("2160");
    expect(Number(u.searchParams.get("MaxStreamingBitrate"))).toBeGreaterThanOrEqual(100_000_000);
  });

  it("reads provider ids case-insensitively", () => {
    expect(providerIds({ Tmdb: "603", Imdb: "tt0133093", AniList: "x" }, "movie")).toMatchObject({ tmdb: 603, tmdbKind: "movie", imdb: "tt0133093", anilist: undefined });
  });
});

describe("player engine", () => {
  const mpv = { path: "mpv.exe", version: "mpv 0.39", bundled: true };
  const c = (p: Partial<StreamCandidate>) => ({ providerId: "x", providerName: "X", label: "", url: "http://a/b.m3u8", kind: "hls", ...p }) as StreamCandidate;

  it("uses mpv only when it's installed and wanted", () => {
    expect(engineFor(c({ needsMpv: true }), { engine: "auto" }, mpv)).toBe("mpv");
    expect(engineFor(c({}), { engine: "auto" }, mpv)).toBe("html");
    expect(engineFor(c({ needsMpv: true }), { engine: "auto" }, null)).toBe("html");
    expect(engineFor(c({}), { engine: "mpv" }, mpv)).toBe("mpv");
    expect(engineFor(c({ needsMpv: true }), { engine: "builtin" }, mpv)).toBe("html");
  });

  it("gives mpv the original file when there is one", () => {
    expect(mpvTarget(c({ nativeUrl: "http://a/direct.mkv" }))).toBe("http://a/direct.mkv");
    expect(mpvTarget(c({}))).toBe("http://a/b.m3u8");
  });

  it("finds intro and credits chapters", () => {
    const ch = [
      { title: "Prologue", time: 0 },
      { title: "Opening", time: 60 },
      { title: "Part A", time: 150 },
      { title: "Ending", time: 1300 },
      { title: "Preview", time: 1390 },
    ];
    expect(skippableChapters(ch, 1420)).toEqual([
      { start: 60, end: 150, type: "op" },
      { start: 1300, end: 1390, type: "ed" },
    ]);
  });
});

describe("AniSkip", () => {
  it("keeps one opening and one ending, sorted", () => {
    const j = {
      found: true,
      results: [
        { skipType: "ed", interval: { startTime: 1300, endTime: 1390 } },
        { skipType: "mixed-op", interval: { startTime: 20, endTime: 110 } },
        { skipType: "op", interval: { startTime: 25, endTime: 115 } },
        { skipType: "recap", interval: { startTime: 0, endTime: 2 } },
      ],
    };
    expect(parseAniSkip(j)).toEqual([
      { start: 20, end: 110, type: "op" },
      { start: 1300, end: 1390, type: "ed" },
    ]);
    expect(parseAniSkip({ found: false })).toEqual([]);
  });
});

describe("history sync", () => {
  const media: Media = { key: "k", kind: "tv", title: "Show", overview: "", genres: [] };
  const rec = (ep: string, at: number, extra: Partial<WatchRecord> = {}): WatchRecord => ({ key: "k", ep, media, position: 10, duration: 100, watched: false, at, ...extra });

  it("keeps the newest copy of each episode and pushes ours when it's newer", () => {
    const local = { k: { s1e1: rec("s1e1", 200, { position: 50 }), s1e2: rec("s1e2", 100) } };
    const { merged, pushBack } = mergeRemote(local, [rec("s1e1", 150), rec("s1e2", 300, { watched: true })]);
    expect(merged.k.s1e1.position).toBe(50);
    expect(merged.k.s1e2.watched).toBe(true);
    expect(pushBack.map((r) => r.ep)).toEqual(["s1e1"]);
  });

  it("drops rows removed on another device, keeps new local ones", () => {
    const local = { k: { s1e1: rec("s1e1", 100, { synced: true }), s1e3: rec("s1e3", 100) } };
    const { merged, pushBack } = mergeRemote(local, []);
    expect(merged.k.s1e1).toBeUndefined();
    expect(merged.k.s1e3).toBeDefined();
    expect(pushBack.map((r) => r.ep)).toEqual(["s1e3"]);
  });
});

describe("new-episode alerts", () => {
  const detail = (p: Partial<MediaDetail>) => ({ key: "tmdb:tv:1", kind: "tv", title: "Show", overview: "", genres: [], ...p }) as MediaDetail;

  it("reads the latest aired episode", () => {
    const now = Date.parse("2026-11-11");
    expect(latestAired(detail({ lastEpisode: { season: 2, episode: 4 } as any }), now)).toEqual({ season: 2, episode: 4 });
    expect(latestAired(detail({ lastEpisode: { season: 2, episode: 4 } as any, nextEpisode: { season: 2, episode: 5, airDate: "2026-11-10" } as any }), now)).toEqual({ season: 2, episode: 5 });
    expect(latestAired(detail({ lastEpisode: { season: 2, episode: 4 } as any, nextEpisode: { season: 2, episode: 5, airDate: "2026-11-20" } as any }), now)).toEqual({ season: 2, episode: 4 });
    expect(latestAired(detail({ key: "anilist:5", nextAiring: { episode: 8 } as any }), now)).toEqual({ episode: 7 });
  });

  it("only records a baseline the first time, then alerts on newer episodes", () => {
    expect(diffShow(undefined, { season: 3, episode: 10 })).toEqual({ alert: null, seen: { season: 3, episode: 10 } });
    expect(diffShow({ season: 3, episode: 10 }, { season: 3, episode: 10 }).alert).toBeNull();
    expect(diffShow({ season: 3, episode: 10 }, { season: 3, episode: 11 }).alert).toEqual({ season: 3, episode: 11, kind: "episode" });
    expect(diffShow({ season: 3, episode: 10 }, { season: 4, episode: 1 }).alert).toEqual({ season: 4, episode: 1, kind: "season" });
    expect(alertText({ kind: "season", season: 4, episode: 1 })).toContain("Season 4");
  });
});

describe("updates", () => {
  it("orders versions, with pre-releases before their release", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0-beta.10", "0.3.0-beta.2")).toBe(1);
  });

  it("turns release notes into plain blocks", () => {
    const md = "### Playback\n- **mpv** engine `new`\n- See [docs](http://x)\n\nThanks!\n**Full Changelog**: http://x";
    expect(noteBlocks(md)).toEqual([
      { kind: "h", text: "Playback" },
      { kind: "li", text: "mpv engine new" },
      { kind: "li", text: "See docs" },
      { kind: "p", text: "Thanks!" },
    ]);
  });
});
