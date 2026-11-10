import { describe, expect, it } from "vitest";
import { episodeMatches, parseEpisode, titleMatches } from "../sources/local";
import { parseName } from "../lib/library";
import { isDone } from "../lib/progress";
import type { Media } from "../lib/types";

const media = (title: string, year?: number): Media => ({ key: "x", kind: "movie", title, overview: "", genres: [], year });

describe("parseEpisode", () => {
  it.each([
    ["Show.S01E02.1080p.mkv", { season: 1, episode: 2 }],
    ["Show S01E01E02.mkv", { season: 1, episode: 1, last: 2 }],
    ["Show.S01E01-E03.mkv", { season: 1, episode: 1, last: 3 }],
    ["Show 2x03.mkv", { season: 2, episode: 3 }],
    ["[SubsPlease] Frieren - 02 (1080p) [ABCD].mkv", { episode: 2 }],
    ["Show_-_02_[720p].mkv", { episode: 2 }],
    ["Show Ep 12.mp4", { episode: 12 }],
  ])("%s", (name, want) => expect(parseEpisode(name)).toEqual(want));

  it("reads the season from a Season folder for bare numbers", () => {
    expect(parseEpisode("01.mkv", "D:/TV/Show/Season 2/01.mkv")).toEqual({ season: 2, episode: 1 });
    expect(parseEpisode("01.mkv")).toEqual({ episode: 1 });
  });

  it.each(["Stargate.1994.1080p.mkv", "Mortal Engine 2018.mkv", "Code 8 (2019).mkv", "Movie.1080p.x264.mkv", "1917.mkv"])(
    "does not treat the film %s as an episode",
    (name) => expect(parseEpisode(name).episode).toBeUndefined(),
  );
});

describe("titleMatches", () => {
  it("needs whole words", () => {
    expect(titleMatches("Upgrade (2018).mkv", { media: media("Up") })).toBe(false);
    expect(titleMatches("D:/Backup/Movies/x.mkv", { media: media("Up") })).toBe(false);
    expect(titleMatches("Kitchen Nightmares S01E01", { media: media("It") })).toBe(false);
    expect(titleMatches("Up (2009) 1080p.mkv", { media: media("Up") })).toBe(true);
    expect(titleMatches("Frieren.Beyond.Journeys.End.S01E01.mkv", { media: media("Frieren: Beyond Journey’s End") })).toBe(true);
  });
});

describe("episodeMatches", () => {
  it("matches the right season only", () => {
    expect(episodeMatches({ season: 1, episode: 1 }, { season: 2, episode: 1 })).toBe(false);
    expect(episodeMatches({ season: 2, episode: 1 }, { season: 2, episode: 1 })).toBe(true);
  });
  it("covers multi-episode files", () => {
    expect(episodeMatches({ season: 1, episode: 1, last: 2 }, { season: 1, episode: 2 })).toBe(true);
  });
  it("maps absolute anime numbering", () => {
    expect(episodeMatches({ episode: 26 }, { season: 2, episode: 1, absolute: 26 })).toBe(true);
    expect(episodeMatches({ episode: 1 }, { season: 2, episode: 1, absolute: 26 })).toBe(false);
    expect(episodeMatches({ episode: 3 }, { season: 1, episode: 3 })).toBe(true);
  });
});

describe("parseName", () => {
  it("takes the last year", () => expect(parseName("Blade Runner 2049 (2017).mkv")).toEqual({ title: "Blade Runner 2049", year: 2017 }));
  it("strips NxNN tags", () => expect(parseName("Show 2x03.mkv").title).toBe("Show"));
  it("keeps a title that is a year", () => expect(parseName("1917.mkv").title).toBe("1917"));
});

describe("isDone", () => {
  it("films need 95%", () => {
    expect(isDone(6800, 7200)).toBe(false);
    expect(isDone(6900, 7200)).toBe(true);
  });
  it("episodes are done at the credits", () => expect(isDone(1340, 1440)).toBe(true));
});

describe("scanner stems (no extension)", () => {
  it("keeps the year on a stem", () => expect(parseName("Dune.2021.2160p")).toEqual({ title: "Dune", year: 2021 }));
  it("parses episode stems", () => expect(parseEpisode("Show.S01E02.x264")).toEqual({ season: 1, episode: 2 }));
});
