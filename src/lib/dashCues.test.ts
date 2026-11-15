import { describe, expect, it, vi } from "vitest";
import { DashCueCollector } from "./dashCues";

describe("DashCueCollector", () => {
  it("turns Shaka cues (including nested, styled ones) into renderer cues, batched", async () => {
    vi.useFakeTimers();
    try {
      const onCues = vi.fn();
      const c = new DashCueCollector(onCues);
      c.append([
        { startTime: 5, endTime: 7, payload: "Second" },
        { startTime: 1, endTime: 3, nestedCues: [{ startTime: 1, endTime: 3, payload: "<i>Hello</i>" }, { startTime: 1, endTime: 3, lineBreak: true }, { startTime: 1, endTime: 3, payload: "there" }] },
        { startTime: 1, endTime: 3, nestedCues: [{ startTime: 1, endTime: 3, payload: "<i>Hello</i>" }, { startTime: 1, endTime: 3, lineBreak: true }, { startTime: 1, endTime: 3, payload: "there" }] },
        { startTime: 9, endTime: 9, payload: "zero-length" },
      ]);
      expect(onCues).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(80);
      expect(onCues).toHaveBeenCalledTimes(1);
      const cues = onCues.mock.calls[0][0];
      expect(cues.map((x: { start: number }) => x.start)).toEqual([1, 5]);
      expect(cues[0].text).toContain("Hello");
      expect(cues[0].text).toContain("there");
      expect(cues[0].spans.some((s: { italic?: boolean }) => s.italic)).toBe(true);

      // Shaka evicting a buffered range removes its cues.
      c.remove(4, 8);
      await vi.advanceTimersByTimeAsync(80);
      expect(onCues.mock.calls.at(-1)![0]).toHaveLength(1);

      c.reset();
      await vi.advanceTimersByTimeAsync(80);
      expect(onCues.mock.calls.at(-1)![0]).toEqual([]);
      expect(c.isTextVisible()).toBe(false);
      c.setTextVisibility(true);
      expect(c.isTextVisible()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
