import { describe, expect, it, vi } from "vitest";
import { createPlayhead } from "./Playhead";

describe("playhead store", () => {
  it("notifies only on real changes and ignores non-finite values", () => {
    const ph = createPlayhead();
    const cb = vi.fn();
    const off = ph.subscribe(cb);
    ph.set(5);
    ph.set(5);
    ph.set(Number.NaN);
    ph.setBuffered(30);
    ph.setBuffered(30);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(ph.get()).toBe(5);
    expect(ph.getBuffered()).toBe(30);
    off();
    ph.set(6);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
