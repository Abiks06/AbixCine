export type ThemeId =
  | "noir"
  | "crimson"
  | "indigo"
  | "emerald"
  | "violet"
  | "solstice"
  | "alabaster"
  | "washi";

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
    tagline: "Deep darkroom charcoal, Kodak amber & slate blue",
    mode: "dark",
    swatches: ["#08080c", "#14141d", "#e2b14c", "#f5f1e8"],
  },
  {
    id: "crimson",
    name: "Grand Premiere",
    tagline: "Opera velvet obsidian, scarlet rose & champagne",
    mode: "dark",
    swatches: ["#0b060a", "#1b0f17", "#ee5b6f", "#f7eef0"],
  },
  {
    id: "indigo",
    name: "Midnight Tokyo",
    tagline: "Pacific twilight indigo, neon cyan & sakura violet",
    mode: "dark",
    swatches: ["#060914", "#10172b", "#43d9f5", "#eef4fc"],
  },
  {
    id: "emerald",
    name: "Criterion Jade",
    tagline: "Pine archival slate, celadon jade & brass gold",
    mode: "dark",
    swatches: ["#060b09", "#0e1a15", "#5ee296", "#eff6f1"],
  },
  {
    id: "violet",
    name: "A24 Dusk",
    tagline: "Studio slate indigo, periwinkle & twilight blue",
    mode: "dark",
    swatches: ["#090a12", "#131524", "#9aa8f2", "#f0f2fa"],
  },
  {
    id: "solstice",
    name: "Dune Solstice",
    tagline: "Desert obsidian, molten copper & twilight cobalt",
    mode: "dark",
    swatches: ["#0c0806", "#1c120d", "#ea854c", "#f7f0e8"],
  },
  {
    id: "alabaster",
    name: "Daylight Print",
    tagline: "Gallery cotton paper, vermilion & cobalt ink",
    mode: "light",
    swatches: ["#f6f1e8", "#ebe3d5", "#cc4429", "#181614"],
  },
  {
    id: "washi",
    name: "Kyoto Washi",
    tagline: "Cherry-blossom washi paper, carmine & sage ink",
    mode: "light",
    swatches: ["#f7f2f4", "#ede4e8", "#be3b63", "#1d151a"],
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
  const r = resolveTheme(id);
  return r === "alabaster" || r === "washi";
}

export function applyThemeToDom(theme: ThemeId, dynamicLight: boolean) {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.mode = isLightTheme(resolved) ? "light" : "dark";
  root.dataset.dynamicLight = dynamicLight ? "1" : "0";
}
