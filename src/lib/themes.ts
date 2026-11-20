export type ThemeId = "noir" | "crimson" | "indigo" | "emerald" | "violet" | "alabaster";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  tagline: string;
  mode: "dark" | "light";
  swatches: [bg: string, surface: string, accent: string, ink: string];
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "noir",
    name: "Celluloid Gold",
    tagline: "Warm darkroom obsidian & 35mm amber gold",
    mode: "dark",
    swatches: ["#09080b", "#17151c", "#d8ab4e", "#f5f1e8"],
  },
  {
    id: "crimson",
    name: "Grand Premiere",
    tagline: "Theater velvet obsidian & scarlet rose",
    mode: "dark",
    swatches: ["#0b0709", "#1a1115", "#e25d6c", "#f6eef0"],
  },
  {
    id: "indigo",
    name: "Midnight Tokyo",
    tagline: "Deep twilight indigo & neon cyan glass",
    mode: "dark",
    swatches: ["#070a12", "#121728", "#4fd3ec", "#eef3fb"],
  },
  {
    id: "emerald",
    name: "Criterion Jade",
    tagline: "Pine-obsidian print room & chartreuse jade",
    mode: "dark",
    swatches: ["#070b09", "#101914", "#6fd48c", "#eff5f0"],
  },
  {
    id: "violet",
    name: "A24 Dusk",
    tagline: "Ultraviolet studio night & luminous orchid",
    mode: "dark",
    swatches: ["#0a0710", "#171124", "#ba83f5", "#f3effa"],
  },
  {
    id: "alabaster",
    name: "Daylight Print",
    tagline: "Gallery cotton paper & vermilion ink",
    mode: "light",
    swatches: ["#f4efe6", "#eae3d5", "#c84830", "#191716"],
  },
];

const THEME_SET = new Set<string>(THEMES.map((t) => t.id));

export function isValidTheme(v: unknown): v is ThemeId {
  return typeof v === "string" && THEME_SET.has(v);
}

export function resolveTheme(v?: string): ThemeId {
  return isValidTheme(v) ? v : "noir";
}

export function isLightTheme(id?: ThemeId): boolean {
  return resolveTheme(id) === "alabaster";
}

export function applyThemeToDom(theme: ThemeId, dynamicLight: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(theme);
  root.dataset.dynamicLight = dynamicLight ? "1" : "0";
}
