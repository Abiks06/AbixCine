import { describe, expect, it } from "vitest";
import { getTrackingState } from "./airing";
import { fmtAirBadge, fmtCountdown, fmtEpCode } from "./format";
import type { ProgressEntry } from "./progress";
import type { Media } from "./types";

const BASE_MS = Date.UTC(2026, 10, 20, 12, 0, 0);

const ongoingShow: Media = {
  key: "tmdb:tv:95396",
  kind: "tv",
  title: "Severance",
  overview: "",
  genres: ["Sci-Fi", "Thriller"],
  status: "Returning Series",
};

const ongoingAnime: Media = {
  key: "anilist:170942",
  kind: "anime",
  format: "TV",
  title: "Solo Leveling",
  overview: "",
  genres: ["Action"],
  status: "RELEASING",
};

describe("airing countdown formatting and dateOnly handling", () => {
  it("formats compact episode codes and sub-day / multi-day countdowns cleanly", () => {
    expect(fmtEpCode(2, 5)).toBe("S2·E5");
    expect(fmtEpCode(undefined, 12)).toBe("E12");
    expect(fmtEpCode(0, 1)).toBe("Sp·E1");

    expect(fmtCountdown(BASE_MS + 42 * 60_000, false, BASE_MS)).toBe("in 42m");
    expect(fmtCountdown(BASE_MS + (3 * 3600 + 20 * 60) * 1000, false, BASE_MS)).toBe("in 3h 20m");
    expect(fmtCountdown(BASE_MS - 60_000, false, BASE_MS)).toBe("Out now");

    const badge = fmtAirBadge({ episode: 12, at: BASE_MS + 2 * 3600_000 }, BASE_MS);
    expect(badge).toBe("E12 · in 2h");
  });

  it("never invents a clock time for dateOnly TMDB air dates", () => {
    const tomorrowMidnightUtc = Date.UTC(2026, 10, 21, 0, 0, 0);
    const label = fmtCountdown(tomorrowMidnightUtc, true, BASE_MS);
    expect(label).not.toMatch(/\d{1,2}:\d{2}/);
    expect(label).toBe("Tomorrow");

    const todayMidnight = Date.UTC(2026, 10, 20, 0, 0, 0);
    expect(fmtCountdown(todayMidnight, true, BASE_MS)).toBe("Out today");

    const threeDaysOut = BASE_MS + 3 * 86_400_000;
    const weekLabel = fmtCountdown(threeDaysOut, true, BASE_MS);
    expect(weekLabel).toMatch(/^in 3d/);
    expect(weekLabel).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("getTrackingState caught-up and new-episode transitions", () => {
  it("stays caught-up while next episode is still in the future", () => {
    const entry: ProgressEntry = {
      media: ongoingAnime,
      episode: 7,
      position: 0,
      duration: 1440,
      updatedAt: BASE_MS - 3600_000,
      caughtUp: true,
      episodes: {
        "s0:e7": { episode: 7, position: 1440, duration: 1440, completed: true, updatedAt: BASE_MS - 3600_000 },
      },
      schemaVersion: 2,
    };
    const nextAt = BASE_MS + 2 * 86_400_000;
    const state = getTrackingState(
      ongoingAnime,
      entry,
      {
        key: ongoingAnime.key,
        ongoing: true,
        airedCount: 7,
        nextAiring: { episode: 8, at: nextAt },
        checkedAt: BASE_MS,
      },
      BASE_MS,
    );
    expect(state.kind).toBe("caught-up");
    expect(state.caughtUp).toBe(true);
    expect(state.badge).toContain("Caught up");
  });

  it("auto-promotes caught-up shows to new-episode once nextAiring timestamp passes", () => {
    const nextAt = BASE_MS - 5 * 60_000; // aired 5 minutes ago
    const entry: ProgressEntry = {
      media: ongoingShow,
      season: 2,
      episode: 4,
      position: 0,
      duration: 2800,
      updatedAt: BASE_MS - 86_400_000,
      caughtUp: true,
      episodes: {
        "s2:e4": { season: 2, episode: 4, position: 2800, duration: 2800, completed: true, updatedAt: BASE_MS - 86_400_000 },
      },
      schemaVersion: 2,
    };

    const state = getTrackingState(
      ongoingShow,
      entry,
      {
        key: ongoingShow.key,
        ongoing: true,
        nextAiring: { season: 2, episode: 5, at: nextAt, dateOnly: true },
        checkedAt: BASE_MS - 3600_000,
      },
      BASE_MS,
    );
    expect(state.kind).toBe("new-episode");
    expect(state.caughtUp).toBe(false);
    expect(state.nextPlay).toEqual({ season: 2, episode: 5 });
    expect(state.badge).toBe("New · S2·E5");
  });

  it("promotes caught-up anime when snapshot reports newer airedCount than watched episode", () => {
    const entry: ProgressEntry = {
      media: ongoingAnime,
      episode: 10,
      position: 0,
      duration: 1440,
      updatedAt: BASE_MS - 86_400_000,
      caughtUp: true,
      episodes: {
        "s0:e10": { episode: 10, position: 1440, duration: 1440, completed: true, updatedAt: BASE_MS - 86_400_000 },
      },
      schemaVersion: 2,
    };

    const state = getTrackingState(
      ongoingAnime,
      entry,
      {
        key: ongoingAnime.key,
        ongoing: true,
        airedCount: 11,
        nextAiring: { episode: 12, at: BASE_MS + 6 * 86_400_000 },
        checkedAt: BASE_MS,
      },
      BASE_MS,
    );
    expect(state.kind).toBe("new-episode");
    expect(state.nextPlay).toEqual({ season: undefined, episode: 11 });
  });
});
