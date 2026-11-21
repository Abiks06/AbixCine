import { describe, expect, it } from "vitest";
import { applyThemeToDom, isLightTheme, isValidTheme, resolveTheme, THEMES } from "./themes";

describe("themes", () => {
  it("exposes 8 unique curated themes including noir default and light modes", () => {
    expect(THEMES).toHaveLength(8);
    const ids = new Set(THEMES.map((t) => t.id));
    expect(ids.size).toBe(8);
    expect(ids.has("noir")).toBe(true);
    expect(ids.has("solstice")).toBe(true);
    expect(ids.has("alabaster")).toBe(true);
    expect(ids.has("washi")).toBe(true);
  });

  it("validates and falls back cleanly to noir", () => {
    expect(isValidTheme("crimson")).toBe(true);
    expect(isValidTheme("solstice")).toBe(true);
    expect(isValidTheme("washi")).toBe(true);
    expect(isValidTheme("unknown")).toBe(false);
    expect(resolveTheme("indigo")).toBe("indigo");
    expect(resolveTheme(undefined)).toBe("noir");
    expect(resolveTheme("bogus")).toBe("noir");
  });

  it("identifies light themes accurately", () => {
    expect(isLightTheme("alabaster")).toBe(true);
    expect(isLightTheme("washi")).toBe(true);
    expect(isLightTheme("noir")).toBe(false);
    expect(isLightTheme("solstice")).toBe(false);
  });

  it("writes theme, mode, and dynamicLight attributes onto documentElement", () => {
    applyThemeToDom("violet", false);
    expect(document.documentElement.dataset.theme).toBe("violet");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(document.documentElement.dataset.dynamicLight).toBe("0");

    applyThemeToDom("alabaster", true);
    expect(document.documentElement.dataset.theme).toBe("alabaster");
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.dataset.dynamicLight).toBe("1");

    applyThemeToDom("washi", true);
    expect(document.documentElement.dataset.theme).toBe("washi");
    expect(document.documentElement.dataset.mode).toBe("light");
  });
});
