import { describe, expect, it } from "vitest";
import { computePreviewPosition } from "./hoverPreview";

describe("computePreviewPosition", () => {
  it("keeps preview inside left rail and top utility bar for top-left cards", () => {
    const pos = computePreviewPosition({ left: 20, top: 20, width: 170, height: 255 }, 1440, 900);
    expect(pos.left).toBeGreaterThanOrEqual(82);
    expect(pos.top).toBeGreaterThanOrEqual(52);
    expect(pos.width).toBe(404);
  });

  it("clamps right-edge and bottom-edge anchors inside the viewport", () => {
    const pos = computePreviewPosition({ left: 1320, top: 760, width: 170, height: 255 }, 1440, 900, {
      cardW: 404,
      cardH: 410,
    });
    expect(pos.left + pos.width).toBeLessThanOrEqual(1440 - 16);
    expect(pos.top + 410).toBeLessThanOrEqual(900 - 16);
    expect(pos.originX).toBe("right");
    expect(pos.originY).toBe("bottom");
  });

  it("shrinks popover cleanly on narrow viewports", () => {
    const pos = computePreviewPosition({ left: 80, top: 200, width: 200, height: 120 }, 420, 760);
    expect(pos.left).toBe(68);
    expect(pos.width).toBe(336);
  });
});
