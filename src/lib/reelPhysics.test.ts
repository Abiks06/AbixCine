import { describe, expect, it } from "vitest";
import {
  BASE_REEL_SPEED,
  classifyWheelGesture,
  spoolAngleDeg,
  stepReelPhysics,
  velocityTiltDeg,
  wrapOffset,
} from "./reelPhysics";

describe("wrapOffset", () => {
  it("wraps positive, negative, and boundary offsets cleanly into [0, span)", () => {
    expect(wrapOffset(0, 1000)).toBe(0);
    expect(wrapOffset(1000, 1000)).toBe(0);
    expect(wrapOffset(1250, 1000)).toBe(250);
    expect(wrapOffset(-40, 1000)).toBe(960);
    expect(wrapOffset(-2040, 1000)).toBe(960);
  });

  it("returns 0 for zero, negative, or non-finite span/position", () => {
    expect(wrapOffset(120, 0)).toBe(0);
    expect(wrapOffset(120, -200)).toBe(0);
    expect(wrapOffset(Number.NaN, 1000)).toBe(0);
    expect(wrapOffset(100, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("classifyWheelGesture", () => {
  it("lets vertical page scrolling pass untouched", () => {
    expect(classifyWheelGesture(0, 80, false)).toEqual({ delta: 0, discrete: false });
    expect(classifyWheelGesture(10, 50, false)).toEqual({ delta: 0, discrete: false });
  });

  it("captures two-finger horizontal trackpad swipes precisely", () => {
    expect(classifyWheelGesture(18, 2, false)).toEqual({ delta: 18, discrete: false });
    expect(classifyWheelGesture(-22, 4, false)).toEqual({ delta: -22, discrete: false });
  });

  it("captures Shift+wheel as discrete horizontal step impulses", () => {
    expect(classifyWheelGesture(0, 100, true)).toEqual({ delta: 100, discrete: true });
    expect(classifyWheelGesture(0, -120, true)).toEqual({ delta: -120, discrete: true });
  });

  it("scales line deltaMode=1 inputs", () => {
    expect(classifyWheelGesture(3, 0, false, 1)).toEqual({ delta: 84, discrete: true });
  });
});

describe("stepReelPhysics", () => {
  it("advances smoothly at cruising speed and wraps around seam", () => {
    const res = stepReelPhysics(
      { pos: 995, vel: BASE_REEL_SPEED },
      { span: 1000, targetVel: BASE_REEL_SPEED, dt: 0.25, coasting: false, dragging: false },
    );
    // dt clamped to 0.05 -> 995 + 38 * 0.05 = 996.9
    expect(res.pos).toBeCloseTo(996.9, 5);
    expect(res.vel).toBe(BASE_REEL_SPEED);
  });

  it("decelerates progressively toward 0 rather than snapping when hovered or paused", () => {
    let s = { pos: 100, vel: BASE_REEL_SPEED };
    s = stepReelPhysics(s, { span: 1000, targetVel: 0, dt: 0.016, coasting: false, dragging: false });
    expect(s.vel).toBeGreaterThan(0);
    expect(s.vel).toBeLessThan(BASE_REEL_SPEED);

    for (let i = 0; i < 60; i++) {
      s = stepReelPhysics(s, { span: 1000, targetVel: 0, dt: 0.016, coasting: false, dragging: false });
    }
    expect(s.vel).toBe(0);
  });

  it("coasts smoothly with friction and wraps backwards on negative flicks", () => {
    const next = stepReelPhysics(
      { pos: 5, vel: -1000 },
      { span: 1000, targetVel: BASE_REEL_SPEED, dt: 0.02, coasting: true, dragging: false },
    );
    expect(next.vel).toBeLessThan(0);
    expect(next.vel).toBeGreaterThan(-1000);
    expect(next.pos).toBeGreaterThan(950);
  });

  it("does not move position automatically while user is actively dragging", () => {
    const res = stepReelPhysics(
      { pos: 240, vel: 500 },
      { span: 1000, targetVel: 0, dt: 0.016, coasting: false, dragging: true },
    );
    expect(res.pos).toBe(240);
    expect(res.vel).toBe(500);
  });
});

describe("velocityTiltDeg & spoolAngleDeg", () => {
  it("stays flat during normal cruising speeds and tilts cleanly on fast flicks", () => {
    expect(velocityTiltDeg(BASE_REEL_SPEED)).toBe(0);
    expect(velocityTiltDeg(61)).toBe(0);
    expect(velocityTiltDeg(-80)).toBe(0);

    const fastForward = velocityTiltDeg(1800);
    const fastBack = velocityTiltDeg(-1800);
    expect(fastForward).toBeLessThan(0);
    expect(fastForward).toBeGreaterThanOrEqual(-1.35);
    expect(fastBack).toBeGreaterThan(0);
    expect(fastBack).toBeLessThanOrEqual(1.35);
  });

  it("wraps spool rotation cleanly into [0, 360)", () => {
    expect(spoolAngleDeg(0)).toBe(0);
    const a1 = spoolAngleDeg(100);
    const a2 = spoolAngleDeg(200);
    expect(a2).toBeGreaterThan(a1);
    expect(spoolAngleDeg(10_000)).toBeLessThan(360);
    expect(spoolAngleDeg(10_000)).toBeGreaterThanOrEqual(0);
  });
});
