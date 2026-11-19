import { afterEach, describe, expect, it } from "vitest";
import {
  EMBED_KEYS,
  NAV_KEYS,
  UP_NEXT_AT,
  clampTip,
  classifyKeyTarget,
  friendlyFailure,
  inUpNextWindow,
  isKeyboardFocused,
  loadSessionMute,
  loadingStage,
  nextSpeed,
  saveSessionMute,
  scrubPoint,
  showsSpinner,
  upNextVisible,
  wheelVolumeSteps,
  type WheelState,
} from "./playerControls";

const make = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("classifyKeyTarget", () => {
  it("hands typing fields their keys", () => {
    expect(classifyKeyTarget(make('<input type="text">'))).toBe("text");
    expect(classifyKeyTarget(make("<input>"))).toBe("text");
    expect(classifyKeyTarget(make('<input type="search">'))).toBe("text");
    expect(classifyKeyTarget(make("<textarea></textarea>"))).toBe("text");
    expect(classifyKeyTarget(make("<select><option>a</option></select>"))).toBe("text");
  });

  it("keeps shortcuts alive on the volume slider (a range input takes no typing)", () => {
    expect(classifyKeyTarget(make('<input type="range">'))).toBe("range");
  });

  it("treats buttons, tabs and non-text inputs as controls, wherever focus sits inside them", () => {
    expect(classifyKeyTarget(make("<button>Go</button>"))).toBe("control");
    expect(classifyKeyTarget(make('<div role="tab">Tab</div>'))).toBe("control");
    expect(classifyKeyTarget(make('<input type="checkbox">'))).toBe("control");
    const inner = make("<button><span>icon</span></button>").querySelector("span");
    expect(classifyKeyTarget(inner)).toBe("control");
  });

  it("leaves the page itself to the player", () => {
    expect(classifyKeyTarget(document.body)).toBe("other");
    expect(classifyKeyTarget(make("<div>video area</div>"))).toBe("other");
    expect(classifyKeyTarget(null)).toBe("other");
  });
});

describe("key sets", () => {
  it("navigation keys belong to sliders and the side panel", () => {
    for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) expect(NAV_KEYS.has(k)).toBe(true);
    expect(NAV_KEYS.has(" ")).toBe(false);
  });

  it("web players only get the keys that drive our own chrome", () => {
    expect(EMBED_KEYS.has("i")).toBe(true);
    expect(EMBED_KEYS.has("f")).toBe(true);
    expect(EMBED_KEYS.has("Escape")).toBe(true);
    expect(EMBED_KEYS.has("m")).toBe(false);
    expect(EMBED_KEYS.has("ArrowUp")).toBe(false);
    expect(EMBED_KEYS.has("0")).toBe(false);
  });

  it("isKeyboardFocused never throws and is false without an element", () => {
    expect(isKeyboardFocused(null)).toBe(false);
    expect(typeof isKeyboardFocused(make("<button>x</button>"))).toBe("boolean");
  });
});

describe("nextSpeed", () => {
  const S = [0.5, 0.75, 1, 1.25, 1.5, 2];
  it("steps through the list and stops at the ends", () => {
    expect(nextSpeed(S, 1, 1)).toBe(1.25);
    expect(nextSpeed(S, 1, -1)).toBe(0.75);
    expect(nextSpeed(S, 2, 1)).toBe(2);
    expect(nextSpeed(S, 0.5, -1)).toBe(0.5);
  });
  it("starts from 1x when the current speed isn't in the list", () => {
    expect(nextSpeed(S, 1.1, 1)).toBe(1.25);
    expect(nextSpeed(S, 1.1, -1)).toBe(0.75);
  });
});

describe("wheelVolumeSteps", () => {
  it("one notch of a line-mode wheel is one step, up for a negative delta", () => {
    const st: WheelState = { acc: 0, at: 0 };
    expect(wheelVolumeSteps(st, -3, 1, 0)).toBe(1);
    expect(wheelVolumeSteps(st, 3, 1, 10)).toBe(-1);
  });

  it("accumulates trackpad pixels into whole steps and keeps the remainder", () => {
    const st: WheelState = { acc: 0, at: 0 };
    expect(wheelVolumeSteps(st, 25, 0, 0)).toBe(0);
    expect(wheelVolumeSteps(st, 25, 0, 20)).toBe(0);
    expect(wheelVolumeSteps(st, 25, 0, 40)).toBe(-1); // 75 px: one step down, 15 left over
    expect(st.acc).toBe(15);
    expect(wheelVolumeSteps(st, -150, 0, 60)).toBe(2); // -135 px: two steps up
  });

  it("a pause starts a new gesture", () => {
    const st: WheelState = { acc: 0, at: 0 };
    wheelVolumeSteps(st, 50, 0, 0);
    expect(wheelVolumeSteps(st, 50, 0, 1000)).toBe(0); // the first 50 px were forgotten
    expect(wheelVolumeSteps(st, 0, 0, 1010)).toBe(0); // no delta, no step
  });
});

describe("scrubPoint / clampTip", () => {
  const rect = { left: 100, width: 400 };
  it("maps the pointer to a time and clamps to the bar", () => {
    expect(scrubPoint(300, rect, 1000)).toEqual({ x: 200, t: 500, w: 400 });
    expect(scrubPoint(50, rect, 1000)).toEqual({ x: 0, t: 0, w: 400 });
    expect(scrubPoint(900, rect, 1000)).toEqual({ x: 400, t: 1000, w: 400 });
  });
  it("is harmless without a bar, a width or a finite duration", () => {
    expect(scrubPoint(300, null, 1000)).toEqual({ x: 0, t: 0, w: 0 });
    expect(scrubPoint(300, { left: 0, width: 0 }, 1000)).toEqual({ x: 0, t: 0, w: 0 });
    expect(scrubPoint(300, rect, Number.POSITIVE_INFINITY).t).toBe(0);
    expect(scrubPoint(300, rect, Number.NaN).t).toBe(0);
  });
  it("keeps the preview tooltip inside the bar", () => {
    expect(clampTip(5, 400, 34)).toBe(34);
    expect(clampTip(395, 400, 34)).toBe(366);
    expect(clampTip(200, 400, 34)).toBe(200);
    expect(clampTip(50, 60, 34)).toBe(30); // narrower than the tip: centre it
  });
});

describe("showsSpinner", () => {
  const base = { waiting: true, failed: false, isEmbed: false, hasStarted: true, playing: true, preparing: false };
  it("spins while connecting and while a playing stream rebuffers", () => {
    expect(showsSpinner({ ...base, hasStarted: false, playing: false })).toBe(true);
    expect(showsSpinner(base)).toBe(true);
  });
  it("doesn't spin over a paused video that is still filling its buffer", () => {
    expect(showsSpinner({ ...base, playing: false })).toBe(false);
  });
  it("never spins over a failure or when nothing is waited for", () => {
    expect(showsSpinner({ ...base, failed: true })).toBe(false);
    expect(showsSpinner({ ...base, waiting: false })).toBe(false);
  });
  it("spins while a file or torrent is being prepared, and until a web player loads", () => {
    expect(showsSpinner({ ...base, playing: false, preparing: true })).toBe(true);
    expect(showsSpinner({ ...base, playing: false, isEmbed: true })).toBe(true);
  });
});

describe("loadingStage", () => {
  const base = { recovering: false, preparingTorrent: false, preparingLocal: false, hasStarted: false, server: "Nova" };
  it("names the server while connecting", () => {
    expect(loadingStage(base)).toBe("Connecting to Nova");
    expect(loadingStage({ ...base, server: undefined })).toBe("Connecting to server");
  });
  it("says what is actually happening, most specific first", () => {
    expect(loadingStage({ ...base, hasStarted: true })).toBe("Buffering");
    expect(loadingStage({ ...base, preparingLocal: true })).toBe("Preparing the audio track");
    expect(loadingStage({ ...base, preparingTorrent: true })).toBe("Starting torrent stream");
    expect(loadingStage({ ...base, recovering: true, hasStarted: true })).toBe("Finding another server");
  });
});

describe("Up next", () => {
  const base = { hasNext: true, dismissed: false, remaining: 10, duration: 1400, ended: false };
  it("shows in the last stretch of a long-enough video", () => {
    expect(upNextVisible(base)).toBe(true);
    expect(upNextVisible({ ...base, remaining: UP_NEXT_AT + 1 })).toBe(false);
    expect(upNextVisible({ ...base, duration: 90 })).toBe(false);
    expect(upNextVisible({ ...base, hasNext: false })).toBe(false);
  });
  it("stays up once the video has ended (it used to vanish at 0.5 s left)", () => {
    expect(upNextVisible({ ...base, remaining: Number.POSITIVE_INFINITY, ended: true })).toBe(true);
    expect(upNextVisible({ ...base, remaining: 0.2 })).toBe(false);
  });
  it("Keep watching hides it", () => {
    expect(upNextVisible({ ...base, dismissed: true })).toBe(false);
    expect(upNextVisible({ ...base, dismissed: true, ended: true })).toBe(false);
  });
  it("the window that re-arms a dismissed card", () => {
    expect(inUpNextWindow(10, false)).toBe(true);
    expect(inUpNextWindow(Number.POSITIVE_INFINITY, true)).toBe(true);
    expect(inUpNextWindow(300, false)).toBe(false);
    expect(inUpNextWindow(Number.POSITIVE_INFINITY, false)).toBe(false);
  });
});

describe("session mute", () => {
  it("round-trips through sessionStorage and defaults to sound on", () => {
    sessionStorage.clear();
    expect(loadSessionMute()).toBe(false);
    saveSessionMute(true);
    expect(loadSessionMute()).toBe(true);
    saveSessionMute(false);
    expect(loadSessionMute()).toBe(false);
  });
});

describe("friendlyFailure", () => {
  it("turns engine error codes into a sentence", () => {
    expect(friendlyFailure("manifestLoadError (403)")).toMatch(/refused/);
    expect(friendlyFailure("fragLoadError (404)")).toMatch(/no longer has/);
    expect(friendlyFailure("stalled")).toMatch(/stopped sending/);
    expect(friendlyFailure("unsupported or unreachable stream")).toMatch(/format/);
    expect(friendlyFailure("manifestLoadError")).toMatch(/reached/);
    expect(friendlyFailure("something odd")).toBe("The stream wouldn't play.");
  });
});
