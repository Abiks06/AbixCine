import { describe, expect, it } from "vitest";
import { nearestInDirection } from "./gamepad";

const rect = (left: number, top: number, w = 100, h = 40) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const el = (name: string) => ({ name }) as unknown as HTMLElement;

describe("nearestInDirection", () => {
  // A 3×2 grid of cards, 120 px apart.
  const cells = [
    { el: el("a1"), r: rect(0, 0) },
    { el: el("a2"), r: rect(120, 0) },
    { el: el("a3"), r: rect(240, 0) },
    { el: el("b1"), r: rect(0, 100) },
    { el: el("b2"), r: rect(120, 100) },
    { el: el("b3"), r: rect(240, 100) },
  ];
  const from = (i: number) => cells[i].r;
  const others = (i: number) => cells.filter((_, j) => j !== i);
  const name = (x: HTMLElement | null) => (x as unknown as { name: string } | null)?.name;

  it("moves to the neighbour in the pressed direction, not a diagonal one", () => {
    expect(name(nearestInDirection(from(1), "right", others(1)))).toBe("a3");
    expect(name(nearestInDirection(from(1), "left", others(1)))).toBe("a1");
    expect(name(nearestInDirection(from(1), "down", others(1)))).toBe("b2");
    expect(name(nearestInDirection(from(4), "up", others(4)))).toBe("a2");
  });

  it("stays put at an edge", () => {
    expect(nearestInDirection(from(2), "right", others(2))).toBeNull();
    expect(nearestInDirection(from(0), "up", others(0))).toBeNull();
  });
});
