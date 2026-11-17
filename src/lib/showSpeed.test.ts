import { beforeEach, describe, expect, it } from "vitest";
import { loadShowSpeed, saveShowSpeed, showKeyFor } from "./showSpeed";

describe("per-show playback speed", () => {
  beforeEach(() => localStorage.clear());

  it("carries a speed over within one show only", () => {
    saveShowSpeed("tmdb:tv:1399", 1.5);
    expect(loadShowSpeed("tmdb:tv:1399")).toBe(1.5);
    expect(loadShowSpeed("tmdb:tv:1396")).toBe(1);
  });

  it("clears the entry when set back to normal speed", () => {
    saveShowSpeed("tmdb:tv:1399", 2);
    saveShowSpeed("tmdb:tv:1399", 1);
    expect(loadShowSpeed("tmdb:tv:1399")).toBe(1);
    expect(localStorage.getItem("abx.showSpeed")).toBe("{}");
  });

  it("never remembers a speed for films", () => {
    expect(showKeyFor({ key: "tmdb:movie:1" }, undefined)).toBeUndefined();
    saveShowSpeed(undefined, 1.5);
    expect(loadShowSpeed(undefined)).toBe(1);
  });

  it("keys anime by its franchise so later seasons share the speed", () => {
    expect(showKeyFor({ key: "anilist:2", canonicalKey: "anilist:1" }, 3)).toBe("anilist:1");
    expect(showKeyFor({ key: "tmdb:tv:5" }, 1)).toBe("tmdb:tv:5");
  });

  it("ignores corrupt or out-of-range stored values", () => {
    localStorage.setItem("abx.showSpeed", JSON.stringify({ a: 99, b: "fast" }));
    expect(loadShowSpeed("a")).toBe(1);
    expect(loadShowSpeed("b")).toBe(1);
    localStorage.setItem("abx.showSpeed", "not json");
    expect(loadShowSpeed("a")).toBe(1);
  });
});
