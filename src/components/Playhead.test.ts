import { describe, expect, it, vi } from "vitest";
import { createHoverStore, createPlayhead } from "./Playhead";

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

describe("hover store", () => {
  it("notifies only when the hover point really changes", () => {
    const hs = createHoverStore();
    const cb = vi.fn();
    const off = hs.subscribe(cb);
    hs.set({ x: 10, t: 5, w: 400 });
    hs.set({ x: 10, t: 5, w: 400 }); // same point, new object: no re-render
    expect(cb).toHaveBeenCalledTimes(1);
    hs.set({ x: 11, t: 5.5, w: 400 });
    expect(cb).toHaveBeenCalledTimes(2);
    hs.set(null);
    hs.set(null);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(hs.get()).toBeNull();
    off();
    hs.set({ x: 1, t: 1, w: 1 });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("keeps the same object between reads (useSyncExternalStore needs a stable snapshot)", () => {
    const hs = createHoverStore();
    hs.set({ x: 3, t: 2, w: 100 });
    expect(hs.get()).toBe(hs.get());
  });
});
