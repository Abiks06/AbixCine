import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleTrack } from "../sources/types";
import { getDetail, getSeasonEpisodes } from "./catalog";
import { __setDownloadsStateForTest, prioritizeDownloadSubtitles } from "./downloads";

describe("download subtitle prioritization and offline catalog fallback", () => {
  afterEach(() => {
    __setDownloadsStateForTest({ root: null, jobs: [], items: [] });
    vi.restoreAllMocks();
  });

  it("ranks preferred and secondary subtitles ahead of trailing tracks and merges stream headers", () => {
    const others = ["ar", "bg", "cs", "da", "de", "el", "es", "fi", "fr", "hi", "hu", "id", "it", "ko"];
    const tracks: SubtitleTrack[] = [
      ...others.slice(0, 7).map((lang, idx) => ({
        lang,
        label: `Track ${idx}`,
        url: `https://sub.example/${lang}.vtt`,
        format: "vtt" as const,
      })),
      {
        lang: "en",
        label: "English Signs (Forced)",
        url: "https://sub.example/en-forced.ass",
        format: "ass",
        isForced: true,
      },
      {
        lang: "ja",
        label: "Japanese",
        url: "https://sub.example/ja.srt",
        format: "srt",
      },
      ...others.slice(7).map((lang, idx) => ({
        lang,
        label: `Track ${idx + 7}`,
        url: `https://sub.example/${lang}.vtt`,
        format: "vtt" as const,
      })),
      {
        lang: "en",
        label: "English Full",
        url: "https://sub.example/en-full.ass",
        format: "ass",
      },
      {
        lang: "en",
        label: "English SDH",
        url: "https://sub.example/en-sdh.srt",
        format: "srt",
        isHearingImpaired: true,
      },
    ];

    const prioritized = prioritizeDownloadSubtitles(
      tracks,
      { lang: "en", secondaryLang: "ja", preferHearingImpaired: "avoid" },
      { referer: "https://player.example/", ua: "TestUA" },
    );

    expect(prioritized).toHaveLength(8);
    expect(prioritized[0].url).toBe("https://sub.example/en-full.ass");
    expect(prioritized[0].headers).toEqual({ referer: "https://player.example/", ua: "TestUA" });
    expect(prioritized[1].url).toBe("https://sub.example/en-sdh.srt");
    expect(prioritized[2].url).toBe("https://sub.example/en-forced.ass");
    expect(prioritized[3].url).toBe("https://sub.example/ja.srt");
  });

  it("returns downloaded detail and season episodes immediately when navigator.onLine is false", async () => {
    __setDownloadsStateForTest({
      root: "C:/Downloads",
      items: [
        {
          id: "dl_anime_1",
          mediaKey: "anilist:154587",
          canonicalKey: "anilist:154587",
          title: "Frieren: Beyond Journey's End",
          mediaKind: "anime",
          isFilm: false,
          year: 2023,
          season: 1,
          episode: 1,
          episodeTitle: "The Journey's End",
          audio: "sub",
          quality: 1080,
          providerId: "hianime",
          providerName: "HiAnime",
          filePath: "C:/Downloads/Anime/Frieren (2023)/Season 01/Frieren - S01E01 [Sub] [1080p].mp4",
          fileSize: 420_000_000,
          subtitlePaths: [
            "C:/Downloads/Anime/Frieren (2023)/Season 01/Frieren - S01E01 [Sub] [1080p].en.ass",
          ],
          downloadedAt: 1_700_000_000_000,
          mediaSnapshot: {
            key: "anilist:154587",
            canonicalKey: "anilist:154587",
            kind: "anime",
            title: "Frieren: Beyond Journey's End",
            genres: ["Adventure", "Fantasy"],
            year: 2023,
            seasons: [{ number: 1, name: "Season 1", episodeCount: 28, status: "aired" }],
          },
        },
      ],
    });

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const detail = await getDetail("anilist:154587");
    expect(detail.title).toBe("Frieren: Beyond Journey's End");
    expect(detail.seasons?.[0]?.episodeCount).toBe(28);

    const eps = await getSeasonEpisodes(detail, 1);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({
      season: 1,
      number: 1,
      title: "The Journey's End",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
