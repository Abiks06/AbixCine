import { afterEach, describe, expect, it, vi } from "vitest";
import {
  epKey,
  getAllProgress,
  getContinueWatching,
  getEpisodeProgress,
  getEpisodesMap,
  getProgress,
  getResumePosition,
  isEpisodeWatched,
  markEpisodeWatched,
  markSeasonWatched,
  mergeProgressEntry,
  removeProgress,
  saveProgress,
  type ProgressEntry,
} from "./progress";
import type { Media } from "./types";

const series: Media = {
  key: "tmdb:tv:99001",
  kind: "tv",
  title: "Andor",
  overview: "",
  genres: ["Sci-Fi", "Drama"],
  status: "Returning Series",
};

const ongoingAnime: Media = {
  key: "anilist:180001",
  kind: "anime",
  format: "TV",
  title: "Dandadan",
  overview: "",
  genres: ["Action"],
  status: "RELEASING",
  nextAiring: { episode: 8, at: Date.now() + 86_400_000 * 3 },
};

const cour2AliasKey = "anilist:180002";

const createdKeys = new Set<string>();
function track(k: string) {
  createdKeys.add(k);
  return k;
}

describe("per-episode progress schema v2 and caught-up tracking", () => {
  afterEach(() => {
    for (const k of createdKeys) removeProgress(k);
    createdKeys.clear();
    vi.restoreAllMocks();
  });

  it("retains earlier episode timestamps when switching episodes and respects resume threshold and rewatch", () => {
    track(series.key);
    // Watch S1E1 past RESUME_MIN_SEC (15s)
    saveProgress({ media: series, season: 1, episode: 1, position: 640, duration: 2400 }, { season: 1, episode: 2 });
    expect(getResumePosition(series.key, 1, 1)).toBe(640);
    expect(isEpisodeWatched(series.key, 1, 1)).toBe(false);

    // Switch to S1E2 and watch briefly (< 15s)
    saveProgress({ media: series, season: 1, episode: 2, position: 8, duration: 2400 }, { season: 1, episode: 3 });

    // Going back to S1E1 must still recover 640s instead of wiping to 0
    expect(getResumePosition(series.key, 1, 1)).toBe(640);
    expect(getProgress(series.key, 1, 1)?.position).toBe(640);
    // Under 15s on S1E2 does not count as a mid-episode resume point yet
    expect(getResumePosition(series.key, 1, 2)).toBeUndefined();

    // Finish S1E1 -> marked watched, rewatch resume starts at 0 (undefined resume position)
    saveProgress({ media: series, season: 1, episode: 1, position: 2370, duration: 2400 }, { season: 1, episode: 2 });
    expect(isEpisodeWatched(series.key, 1, 1)).toBe(true);
    expect(getResumePosition(series.key, 1, 1)).toBeUndefined();
  });

  it("folds cour aliases into canonicalKey and prunes duplicate keys", () => {
    const k = track(ongoingAnime.key);
    track(cour2AliasKey);

    saveProgress({ media: { ...ongoingAnime, key: cour2AliasKey }, episode: 12, position: 420, duration: 1440 });
    expect(getEpisodeProgress(cour2AliasKey, undefined, 12)?.position).toBe(420);

    // Save E13 under canonical key with aliasKeys pointing at cour2AliasKey
    saveProgress(
      { media: { ...ongoingAnime, key: cour2AliasKey, canonicalKey: k }, season: 1, episode: 13, position: 510, duration: 1440 },
      { season: 1, episode: 14 },
      { aliasKeys: [cour2AliasKey] },
    );

    const all = getAllProgress();
    expect(all.some((p) => p.media.key === cour2AliasKey)).toBe(false);
    const map = getEpisodesMap(k);
    expect(map["s0:e12"]?.position).toBe(420);
    expect(map["s1:e13"]?.position).toBe(510);
    // Season=1 lookup falls back cleanly to s0:e12 as well
    expect(getEpisodeProgress(k, 1, 12)?.position).toBe(420);
  });

  it("marks ongoing series caughtUp instead of finished on last aired episode and excludes them from Continue Watching", () => {
    const k = track(ongoingAnime.key);
    saveProgress(
      { media: ongoingAnime, episode: 7, position: 1400, duration: 1440 },
      null,
      { ongoing: true },
    );

    const active = getContinueWatching();
    expect(active.some((p) => p.media.key === k)).toBe(false);
    const stored = getAllProgress().find((p) => p.media.key === k);
    expect(stored?.caughtUp).toBe(true);
    expect(stored?.finished).toBeUndefined();
    expect(isEpisodeWatched(k, undefined, 7)).toBe(true);
  });

  it("toggles single episodes and entire seasons with markEpisodeWatched and markSeasonWatched", () => {
    const k = track(series.key);
    const prev = markSeasonWatched(
      series,
      1,
      [
        { number: 1, runtime: 40 },
        { number: 2, runtime: 42 },
      ],
      true,
    );
    expect(prev).toBeUndefined();
    expect(isEpisodeWatched(k, 1, 1)).toBe(true);
    expect(isEpisodeWatched(k, 1, 2)).toBe(true);

    markEpisodeWatched(series, 1, 1, false);
    expect(isEpisodeWatched(k, 1, 1)).toBe(false);
    expect(isEpisodeWatched(k, 1, 2)).toBe(true);
  });

  it("performs per-episode CRDT merge and preserves v2 episodes against legacy v1 remote payloads", () => {
    const t0 = 1_700_000_000_000;
    const local: ProgressEntry = {
      media: series,
      season: 1,
      episode: 2,
      position: 500,
      duration: 2400,
      updatedAt: t0 + 1000,
      schemaVersion: 2,
      episodes: {
        [epKey(1, 1)]: { season: 1, episode: 1, position: 2380, duration: 2400, updatedAt: t0, completed: true },
        [epKey(1, 2)]: { season: 1, episode: 2, position: 500, duration: 2400, updatedAt: t0 + 1000 },
      },
    };
    const remoteV2: ProgressEntry = {
      media: ongoingAnime, // also test preserving remote nextAiring metadata
      season: 1,
      episode: 2,
      position: 900,
      duration: 2400,
      updatedAt: t0 + 5000,
      schemaVersion: 2,
      episodes: {
        [epKey(1, 2)]: { season: 1, episode: 2, position: 900, duration: 2400, updatedAt: t0 + 5000 },
        [epKey(1, 3)]: { season: 1, episode: 3, position: 120, duration: 2400, updatedAt: t0 + 4000 },
      },
    };

    const merged = mergeProgressEntry(local, remoteV2);
    expect(merged.episodes?.[epKey(1, 1)]?.completed).toBe(true);
    expect(merged.episodes?.[epKey(1, 2)]?.position).toBe(900);
    expect(merged.episodes?.[epKey(1, 3)]?.position).toBe(120);
    expect(merged.media.nextAiring?.episode).toBe(8);

    // Older v1 remote payload lacking `episodes` must not wipe local S1E1/S1E2 history
    const legacyRemote: ProgressEntry = {
      media: series,
      season: 1,
      episode: 4,
      position: 210,
      duration: 2400,
      updatedAt: t0 + 9000,
    };
    const mergedLegacy = mergeProgressEntry(local, legacyRemote);
    expect(mergedLegacy.episode).toBe(4);
    expect(mergedLegacy.episodes?.[epKey(1, 1)]?.completed).toBe(true);
    expect(mergedLegacy.episodes?.[epKey(1, 2)]?.position).toBe(500);
    expect(mergedLegacy.episodes?.[epKey(1, 4)]?.position).toBe(210);
  });
});
