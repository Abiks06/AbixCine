import { describe, expect, it, vi } from "vitest";
import { createHlsSideLoader, parseSubtitlePlaylist, vttTimestampShift } from "./hlsSideSubs";

const playlist = (n: number, dur = 6) =>
  ["#EXTM3U", "#EXT-X-TARGETDURATION:6", ...Array.from({ length: n }, (_, i) => `#EXTINF:${dur},\nseg${i}.vtt`), "#EXT-X-ENDLIST"].join("\n");

const vttSeg = (i: number, mpegts = 900000) =>
  `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n\n00:00:${String(i * 6 + 1).padStart(2, "0")}.000 --> 00:00:${String(i * 6 + 3).padStart(2, "0")}.000\nline ${i}\n`;

describe("hlsSideSubs", () => {
  it("parses a subtitle media playlist into timed segments", () => {
    const segs = parseSubtitlePlaylist(playlist(3), "https://cdn.x/subs/en/index.m3u8");
    expect(segs.map((s) => [s.url, s.start, s.end])).toEqual([
      ["https://cdn.x/subs/en/seg0.vtt", 0, 6],
      ["https://cdn.x/subs/en/seg1.vtt", 6, 12],
      ["https://cdn.x/subs/en/seg2.vtt", 12, 18],
    ]);
  });

  it("aligns WebVTT segment clocks with the stream's first timestamp", () => {
    // MPEGTS 900000 = 10 s, the stream also starts at 10 s: no shift.
    expect(vttTimestampShift(vttSeg(0), 10)).toBeCloseTo(0);
    // Stream starts at 0 s: cues move 10 s later.
    expect(vttTimestampShift(vttSeg(0), 0)).toBeCloseTo(10);
    // Unknown start with the standard 10 s map: assume it matches.
    expect(vttTimestampShift(vttSeg(0), null)).toBeCloseTo(0);
    expect(vttTimestampShift("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n", 10)).toBe(0);
  });

  it("loads short playlists whole and long ones around the playhead, de-duplicating cues", async () => {
    const fetchText = vi.fn(async (url: string) => {
      if (url.endsWith("index.m3u8")) return playlist(100);
      const i = Number(url.match(/seg(\d+)\.vtt$/)![1]);
      return vttSeg(i % 10);
    });
    let latest: { start: number; text: string }[] = [];
    const loader = createHlsSideLoader({
      playlistUrl: "https://cdn.x/subs/fr/index.m3u8",
      getInitPtsSec: () => 10,
      fetchText,
      onCues: (cues) => (latest = cues),
    });
    loader.ensure(300); // 100 segments × 6 s: only the window around 5:00 is fetched
    await vi.waitFor(() => expect(latest.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    const fetchedSegs = fetchText.mock.calls.map(([u]) => u).filter((u) => u.endsWith(".vtt"));
    expect(fetchedSegs.length).toBeLessThanOrEqual(26); // (30 + 120) / 6 ≈ 25 segments
    expect(fetchedSegs.length).toBeGreaterThan(20);
    // Cues are sorted and unique.
    const starts = latest.map((c) => c.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    loader.dispose();
  });
});
