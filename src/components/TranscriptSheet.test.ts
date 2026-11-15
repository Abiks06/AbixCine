import { describe, expect, it } from "vitest";
import type { SubtitleCue } from "../lib/subtitles";
import { pairTranscript } from "./TranscriptSheet";

const cue = (start: number, end: number, text: string) => ({ id: `${start}`, start, end, text, spans: [{ text }], align: 2 }) as unknown as SubtitleCue;

describe("pairTranscript", () => {
  it("puts the overlapping second-language lines under each main line, honouring both offsets", () => {
    const main = [cue(1, 3, "Hello"), cue(4, 6, "Goodbye")];
    const second = [cue(1.2, 2.8, "こんにちは"), cue(4.1, 5, "さよ"), cue(5, 5.9, "うなら")];
    const lines = pairTranscript(main, second);
    expect(lines.map((l) => [l.text, l.second])).toEqual([
      ["Hello", "こんにちは"],
      ["Goodbye", "さよ\nうなら"],
    ]);
    // The second track is 2 s late: shifted, it no longer overlaps the first main line.
    const shifted = pairTranscript(main, second, 2);
    expect(shifted[0].second).toBeUndefined();
    // The main offset moves the lines themselves.
    expect(pairTranscript(main, undefined, 0, 1.5)[0].start).toBe(2.5);
  });
});
