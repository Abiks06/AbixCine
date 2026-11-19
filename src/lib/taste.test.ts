import { describe, expect, it } from "vitest";
import { laneOf, mixByTaste, tasteFrom, type Taste } from "./taste";
import type { ProgressEntry } from "./progress";
import type { Media } from "./types";

const NOW = Date.UTC(2026, 10, 19);
const DAY = 86_400_000;
const media = (key: string, kind: Media["kind"], title = key) => ({ key, kind, title }) as Media;
const played = (m: Media, daysAgo: number, finished = false) =>
  ({ media: m, position: 600, duration: 1200, updatedAt: NOW - daysAgo * DAY, finished }) as ProgressEntry;

describe("tasteFrom", () => {
  it("is an even three-way mix for someone who has watched nothing", () => {
    const t = tasteFrom([], [], NOW);
    expect(t.share.film).toBeCloseTo(1 / 3);
    expect(t.share.series).toBeCloseTo(1 / 3);
    expect(t.share.anime).toBeCloseTo(1 / 3);
  });

  it("leans toward what you actually watch, without dropping the other lanes", () => {
    const t = tasteFrom([played(media("a1", "anime"), 1), played(media("a2", "anime"), 2), played(media("a3", "anime"), 3), played(media("f1", "movie"), 2)], [], NOW);
    expect(t.order[0]).toBe("anime");
    expect(t.share.anime).toBeGreaterThan(t.share.film);
    expect(t.share.series).toBeGreaterThan(0);
  });

  it("counts a show once however many season entries it has", () => {
    const seasons = [1, 2, 3, 4].map((s) => played(media(`tv:1:s${s}`, "tv", "The Show"), s));
    const t = tasteFrom([...seasons, played(media("f1", "movie"), 1), played(media("f2", "movie"), 1)], [], NOW);
    expect(t.order[0]).toBe("film");
  });

  it("lets recent viewing outweigh old viewing", () => {
    const old = [1, 2, 3].map((i) => played(media(`f${i}`, "movie"), 200 + i));
    const t = tasteFrom([...old, played(media("s1", "tv"), 1), played(media("s2", "tv"), 2)], [], NOW);
    expect(t.order[0]).toBe("series");
  });
});

describe("mixByTaste", () => {
  const pool = (kind: Media["kind"], n: number) => Array.from({ length: n }, (_, i) => media(`${kind}${i}`, kind));
  const even: Taste = { share: { film: 1 / 3, series: 1 / 3, anime: 1 / 3 }, order: ["film", "series", "anime"] };

  it("mixes all three lanes and alternates them", () => {
    const out = mixByTaste({ film: pool("movie", 6), series: pool("tv", 6), anime: pool("anime", 6) }, even, 6);
    expect(out).toHaveLength(6);
    expect(out.map((m) => laneOf(m))).toEqual(["film", "series", "anime", "film", "series", "anime"]);
  });

  it("gives the favourite lane more slots but keeps one of each", () => {
    const anime: Taste = { share: { film: 0.15, series: 0.15, anime: 0.7 }, order: ["anime", "film", "series"] };
    const lanes = mixByTaste({ film: pool("movie", 6), series: pool("tv", 6), anime: pool("anime", 6) }, anime, 6).map((m) => laneOf(m));
    expect(lanes.filter((l) => l === "anime").length).toBeGreaterThanOrEqual(4);
    expect(lanes).toContain("film");
    expect(lanes).toContain("series");
    expect(lanes[0]).toBe("anime");
  });

  it("fills from the other lanes when one is still loading", () => {
    const out = mixByTaste({ film: [], series: [], anime: pool("anime", 8) }, even, 6);
    expect(out).toHaveLength(6);
    expect(out.every((m) => m.kind === "anime")).toBe(true);
  });

  it("never repeats a title that appears in two pools", () => {
    const shared = media("x", "movie");
    const out = mixByTaste({ film: [shared, ...pool("movie", 3)], series: [shared, ...pool("tv", 3)] }, even, 6);
    expect(new Set(out.map((m) => m.key)).size).toBe(out.length);
  });
});
