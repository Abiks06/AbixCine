import { describe, expect, it } from "vitest";
import { applyThemeToDom, isLightTheme, isValidTheme, resolveTheme, THEMES } from "./themes";

describe("themes", () => {
  it("exposes 6 unique curated themes including noir default and alabaster light mode", () => {
    expect(THEMES).toHaveLength(6);
    const ids = new Set(THEMES.map((t) => t.id));
    expect(ids.size).toBe(6);
    expect(ids.has("noir")).toBe(true);
    expect(ids.has("alabaster")).toBe(true);
  });

  it("validates and falls back cleanly to noir", () => {
    expect(isValidTheme("crimson")).toBe(true);
    expect(isValidTheme("unknown")).toBe(false);
    expect(resolveTheme("indigo")).toBe("indigo");
    expect(resolveTheme(undefined)).toBe("noir");
    expect(resolveTheme("bogus")).toBe("noir");
  });

  it("identifies light themes accurately", () => {
    expect(isLightTheme("alabaster")).toBe(true);
    expect(isLightTheme("noir")).toBe(false);
    expect(isLightTheme("crimson")).toBe(false);
  });

  it("writes theme and dynamicLight attributes onto documentElement", () => {
    applyThemeToDom("violet", false);
    expect(document.documentElement.dataset.theme).toBe("violet");
    expect(document.documentElement.dataset.dynamicLight).toBe("0");

    applyThemeToDom("alabaster", true);
    expect(document.documentElement.dataset.theme).toBe("alabaster");
    expect(document.documentElement.dataset.dynamicLight).toBe("1");
  });
});
