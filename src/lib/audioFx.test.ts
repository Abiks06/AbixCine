import { afterEach, describe, expect, it, vi } from "vitest";

const param = () => ({ value: 0, setTargetAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }) });
const node = () => ({ connect: vi.fn(function (n: unknown) { return n; }), disconnect: vi.fn() });
let created = 0;
const gains: { gain: { value: number } }[] = [];
const comps: { threshold: { value: number }; ratio: { value: number } }[] = [];
class FakeCtx {
  state = "running";
  currentTime = 0;
  destination = { maxChannelCount: 6, channelCount: 6 };
  constructor() {
    created++;
  }
  resume = vi.fn(() => Promise.resolve());
  createMediaElementSource = vi.fn(() => node());
  createBiquadFilter = vi.fn(() => ({ ...node(), type: "", frequency: param(), Q: param(), gain: param() }));
  createDynamicsCompressor = vi.fn(() => {
    const c = { ...node(), knee: param(), attack: param(), release: param(), threshold: param(), ratio: param() };
    comps.push(c);
    return c;
  });
  createGain = vi.fn(() => {
    const g = { ...node(), gain: param() };
    gains.push(g);
    return g;
  });
}
vi.stubGlobal("AudioContext", FakeCtx);

const { hasAudioFx, releaseAudioFx, setAudioFx } = await import("./audioFx");

afterEach(() => {
  created = 0;
  gains.length = 0;
  comps.length = 0;
});

describe("audioFx", () => {
  it("builds nothing until an effect or boost is on, then keeps the graph and neutralises it when off", () => {
    const el = {} as HTMLMediaElement;
    expect(setAudioFx(el, { night: false, dialogue: false, boost: 1 })).toBe(true);
    expect(hasAudioFx(el)).toBe(false);
    expect(created).toBe(0);

    expect(setAudioFx(el, { night: true, dialogue: true })).toBe(true);
    expect(hasAudioFx(el)).toBe(true);
    expect(gains[0].gain.value).toBeGreaterThan(2.5);
    expect(comps[1].threshold.value).toBe(-1);

    // Off again: still routed (a disconnected source would be silence), every stage neutral.
    setAudioFx(el, { night: false, dialogue: false, boost: 1 });
    expect(hasAudioFx(el)).toBe(true);
    expect(gains[0].gain.value).toBe(1);
    expect(comps[1].threshold.value).toBe(0);

    releaseAudioFx(el);
    expect(hasAudioFx(el)).toBe(false);
  });

  it("builds the pre-amp graph when boost > 1 even with night and dialogue off", () => {
    const el = {} as HTMLMediaElement;
    expect(setAudioFx(el, { night: false, dialogue: false, boost: 1.5 })).toBe(true);
    expect(hasAudioFx(el)).toBe(true);
    expect(gains[0].gain.value).toBe(1.5);
    expect(comps[1].threshold.value).toBe(-1);

    releaseAudioFx(el);
  });
});
