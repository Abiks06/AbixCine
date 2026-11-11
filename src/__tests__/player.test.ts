import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayerBus, type PlayerState } from "../player/bus";
import { parsePlayerParams, parseTime, playerParamsToQuery } from "../player/params";
import { watchHref } from "../lib/play";
import { rank, tierOf } from "../sources/registry";
import { providerStatus, recordLookupFailure, recordProbe, resetHealth } from "../sources/health";
import type { StreamCandidate } from "../sources/types";
import type { PlaybackRequest } from "../lib/types";

const q = (s: string) => new URLSearchParams(s);

describe("parseTime", () => {
  it.each([
    ["120", 120],
    ["12:34", 754],
    ["1:02:03", 3723],
    ["1h2m3s", 3723],
    ["90s", 90],
    ["5m", 300],
  ])("%s → %d", (v, want) => expect(parseTime(v)).toBe(want));

  it.each(["", "abc", "-5", "1:2:3:4", "h", "999999999"])("rejects %j", (v) => expect(parseTime(v)).toBeUndefined());
});

describe("parsePlayerParams", () => {
  it("reads every option, with the aliases from the link spec", () => {
    expect(parsePlayerParams(q("t=754&speed=1.25&provider=local&controls=0&autoplay=0&muted=1&sub=EN&title=Director%27s%20cut"))).toEqual({
      start: 754,
      speed: 1.25,
      provider: "local",
      controls: false,
      autoplay: false,
      muted: true,
      sub: "en",
      title: "Director's cut",
    });
    expect(parsePlayerParams(q("start=10&server=jellyfin"))).toEqual({ start: 10, provider: "jellyfin" });
  });

  it("ignores values it can't trust", () => {
    expect(parsePlayerParams(q("speed=3&provider=../../etc&controls=maybe&sub=<script>&provider=auto"))).toEqual({});
    expect(parsePlayerParams(q("provider=auto"))).toEqual({});
  });

  it("round-trips through the query builder, writing only non-defaults", () => {
    const p = { start: 61.7, speed: 1.5, provider: "jellyfin", controls: false };
    expect(playerParamsToQuery(p)).toEqual({ t: "61", speed: "1.5", provider: "jellyfin", controls: "0" });
    expect(playerParamsToQuery({ speed: 1, controls: true, autoplay: true, muted: false })).toEqual({});
    expect(parsePlayerParams(q(new URLSearchParams(playerParamsToQuery(p)).toString()))).toEqual({ ...p, start: 61 });
  });

  it("watchHref carries player options after episode and audio", () => {
    expect(watchHref("tmdb:tv:1", 1, 2, "sub", { start: 90, speed: 1.25 })).toBe("/watch/tmdb%3Atv%3A1?s=1&e=2&a=sub&t=90&speed=1.25");
    expect(watchHref("tmdb:movie:550")).toBe("/watch/tmdb%3Amovie%3A550");
  });
});

const fakeState = (over: Partial<PlayerState> = {}): PlayerState => ({
  title: "T",
  playing: false,
  waiting: false,
  currentTime: 0,
  duration: 100,
  buffered: 0,
  volume: 1,
  muted: false,
  speed: 1,
  sources: [],
  subtitles: [],
  subtitleTrack: -1,
  qualities: [],
  quality: -1,
  ...over,
});

describe("player bus", () => {
  it("routes commands to the attached player and reports when nothing is attached", () => {
    const bus = createPlayerBus();
    expect(bus.send({ type: "play" })).toBe(false);
    expect(bus.state()).toBeNull();
    const run = vi.fn();
    const detach = bus.attach({ run, state: () => fakeState({ speed: 1.5 }) });
    expect(bus.send({ type: "seekBy", seconds: 10 })).toBe(true);
    expect(run).toHaveBeenCalledWith({ type: "seekBy", seconds: 10 });
    expect(bus.state()?.speed).toBe(1.5);
    detach();
    expect(bus.attached).toBe(false);
  });

  it("an old player detaching late doesn't unplug the new one", () => {
    const bus = createPlayerBus();
    const a = bus.attach({ run: vi.fn(), state: () => fakeState() });
    const runB = vi.fn();
    bus.attach({ run: runB, state: () => fakeState() });
    a();
    expect(bus.send({ type: "pause" })).toBe(true);
    expect(runB).toHaveBeenCalled();
  });

  it("delivers typed events, survives a throwing listener, and unsubscribes", () => {
    const bus = createPlayerBus();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: number[] = [];
    bus.on("timeupdate", () => {
      throw new Error("bad plugin");
    });
    const off = bus.on("timeupdate", (e) => seen.push(e.currentTime));
    const any = vi.fn();
    bus.onAny(any);
    bus.emit("timeupdate", { currentTime: 5, duration: 10, buffered: 6 });
    off();
    bus.emit("timeupdate", { currentTime: 6, duration: 10, buffered: 6 });
    expect(seen).toEqual([5]);
    expect(any).toHaveBeenCalledTimes(2);
    expect(any).toHaveBeenCalledWith("timeupdate", { currentTime: 5, duration: 10, buffered: 6 });
    err.mockRestore();
  });
});

const req: PlaybackRequest = { media: { key: "tmdb:movie:1", kind: "movie", title: "X", overview: "", genres: [] } };
const cand = (providerId: string, quality: number, latencyMs: number): StreamCandidate => ({
  providerId,
  providerName: providerId,
  label: providerId,
  url: `http://x/${providerId}/${quality}`,
  kind: "file",
  quality,
  probe: { ok: true, latencyMs, quality },
});

describe("provider preference, tiers and health", () => {
  beforeEach(() => resetHealth());

  it("a provider picked in the link outranks a better copy, but never an unreachable one wins", () => {
    const fast = rank(cand("local", 1080, 5), 1080, 30, req, "jellyfin");
    const slow = rank(cand("jellyfin", 720, 900), 1080, 20, req, "jellyfin");
    expect(slow.score!).toBeGreaterThan(fast.score!);
    expect(slow.why?.[0]).toBe("your pick");
    const dead = rank({ ...cand("jellyfin", 2160, 0), probe: { ok: false, latencyMs: 0 } }, 1080, 20, req, "jellyfin");
    expect(dead.score!).toBeLessThan(fast.score!);
  });

  it("labels tiers by where the stream comes from", () => {
    expect(tierOf("local")).toBe(1);
    expect(tierOf("jellyfin")).toBe(2);
    expect(tierOf("manual")).toBe(4);
  });

  it("reports health from history", () => {
    expect(providerStatus("jellyfin").state).toBe("new");
    for (let i = 0; i < 5; i++) recordProbe(cand("jellyfin", 1080, 40));
    expect(providerStatus("jellyfin").state).toBe("healthy");
    vi.useFakeTimers({ now: Date.now() + 1000 });
    recordLookupFailure("jellyfin");
    expect(providerStatus("jellyfin").state).toBe("down");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(providerStatus("jellyfin").state).not.toBe("down");
    vi.useRealTimers();
  });
});
