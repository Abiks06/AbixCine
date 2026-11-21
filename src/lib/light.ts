import { sized } from "../components/Art";
import { getSettings } from "./settings";
import { isLightTheme, resolveTheme } from "./themes";
import type { Media } from "./types";

/**
 * Stage light: the app is lit by whatever title has focus. One hue pair is sampled from its
 * artwork and turned into perceptually even OKLCH tones:
 *
 *   --tone / --tone-ink / --tone-deep   on :root   the accent, its text-safe lift, its dark plate
 *   --l1 / --l2                         on .light  the two pools of ambient light behind the page
 *
 * The root tones change only when the page's subject changes (a hero slide, a title page). A card
 * hover borrows just the ambient layer, so sweeping the pointer along a shelf restyles one
 * element instead of the whole document.
 */
export interface Tones {
  tone: string;
  ink: string;
  deep: string;
  l1: string;
  l2: string;
}

const CACHE_MAX = 240;
const cache = new Map<string, Tones>();
let base: Media | undefined;
let baseTones: Tones | undefined;
let token = 0;

const hashHue = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** sRGB (0-255) → OKLCH [lightness 0-1, chroma, hue 0-360]. */
export function rgbToOklch(r8: number, g8: number, b8: number): [number, number, number] {
  const r = lin(r8 / 255), g = lin(g8 / 255), b = lin(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

function hexToOklch(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(clean) ? clean.replace(/./g, (c) => c + c) : /^[0-9a-f]{6}$/i.test(clean) ? clean : null;
  if (!full) return null;
  const n = parseInt(full, 16);
  return rgbToOklch((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const f = (n: number, d = 3) => Number(n.toFixed(d));
const oklch = (l: number, c: number, h: number) => `oklch(${f(l)} ${f(c)} ${f(h, 1)})`;

/**
 * Build the tone set from a dominant and a secondary hue. Lightness is fixed per role so every
 * title gets the same contrast: the ink always clears 7:1 on the canvas, whatever the artwork.
 * Grey artwork keeps a whisper of chroma rather than inventing a colour it doesn't have.
 */
export function tonesFrom(h1: number, c1: number, h2 = (h1 + 40) % 360, c2 = c1): Tones {
  const vivid = clamp(c1 * 1.38, 0.055, 0.2);
  const soft = clamp(c2 * 1.2, 0.045, 0.16);
  if (isLightTheme(resolveTheme(getSettings().theme))) {
    return {
      tone: oklch(0.54, vivid, h1),
      ink: oklch(0.42, Math.min(vivid, 0.17), h1),
      deep: oklch(0.92, Math.min(vivid, 0.045), h1),
      l1: oklch(0.75, Math.min(vivid, 0.11), h1),
      l2: oklch(0.79, Math.min(soft, 0.095), h2),
    };
  }
  return {
    tone: oklch(0.84, vivid, h1),
    ink: oklch(0.92, Math.min(vivid, 0.135), h1),
    deep: oklch(0.24, Math.min(vivid, 0.055), h1),
    l1: oklch(0.42, Math.min(vivid, 0.14), h1),
    l2: oklch(0.32, Math.min(soft, 0.115), h2),
  };
}

/** Two dominant hues of an image: bucket pixels by OKLCH hue, weight by chroma and mid-lightness. */
function sample(src: string): Promise<Tones> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 32;
        c.height = 18;
        const x = c.getContext("2d", { willReadFrequently: true });
        if (!x) return reject(new Error("no-2d-context"));
        x.drawImage(img, 0, 0, 32, 18);
        const px = x.getImageData(0, 0, 32, 18).data;
        const buckets = Array.from({ length: 12 }, () => ({ w: 0, x: 0, y: 0, c: 0 }));
        for (let i = 0; i < px.length; i += 4) {
          const [L, C, H] = rgbToOklch(px[i], px[i + 1], px[i + 2]);
          const w = C * (1 - Math.abs(L - 0.6) * 1.3);
          if (w < 0.012) continue;
          const b = buckets[Math.floor(H / 30) % 12];
          const rad = (H * Math.PI) / 180;
          b.w += w;
          b.x += Math.cos(rad) * w; // circular mean: 359° and 1° average to 0°, not 180°
          b.y += Math.sin(rad) * w;
          b.c += C * w;
        }
        const ranked = buckets.map((b, i) => ({ ...b, i })).filter((b) => b.w > 0).sort((a, b) => b.w - a.w);
        if (!ranked.length) return reject(new Error("flat"));
        const hue = (b: (typeof ranked)[number]) => ((Math.atan2(b.y, b.x) * 180) / Math.PI + 360) % 360;
        const first = ranked[0];
        const second = ranked.find((b) => Math.min(Math.abs(b.i - first.i), 12 - Math.abs(b.i - first.i)) >= 2) ?? first;
        resolve(tonesFrom(hue(first), first.c / first.w, hue(second), second.c / second.w));
      } catch (e) {
        reject(e); // tainted canvas: the CDN didn't allow CORS
      }
    };
    img.onerror = reject;
    // 32×18 pixels are all we read, so fetch the smallest rendition, not the 4K backdrop.
    img.src = sized(src, "w92") ?? src;
  });
}

export async function tonesFor(m: Media): Promise<Tones> {
  const src = m.backdrop ?? m.poster;
  const id = `${m.key}|${src ?? ""}`;
  const hit = cache.get(id);
  if (hit) {
    // refresh recency
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const fallback = () => tonesFrom(m.hue ?? hashHue(m.key), 0.11);
  let tones: Tones;
  const given = m.color ? hexToOklch(m.color) : null;
  if (given) tones = tonesFrom(given[2], given[1]);
  else if (src) tones = await sample(src).catch(fallback);
  else tones = fallback();
  cache.set(id, tones);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return tones;
}

const lightEls = () => document.querySelectorAll<HTMLElement>(".light");

function paintLight(t: Tones | undefined) {
  lightEls().forEach((el) => {
    if (t) {
      el.style.setProperty("--l1", t.l1);
      el.style.setProperty("--l2", t.l2);
    } else {
      el.style.removeProperty("--l1");
      el.style.removeProperty("--l2");
    }
  });
}

/**
 * The room also carries the focused title's own picture, blurred until only its colour is left
 * (.light::before / ::after in styles/base.css). That soft colour field is what every pane of
 * glass in the app looks through: translucent plates over it read as frosted with no blur of
 * their own. Two layers take turns, so a new picture cross-fades over the old one, and nothing
 * shows until the image has loaded.
 */
let artSrc: string | undefined;
let artToken = 0;
let artFlip = false;
/** A few hundred pixels are plenty for something that is blurred to a glow. */
function artOf(m: Media | undefined) {
  const raw = m?.backdrop ?? m?.poster;
  return raw ? sized(raw, m?.backdrop ? "w300" : "w185") ?? raw : undefined;
}
function paintArt(src: string | undefined) {
  if (typeof document === "undefined") return;
  if (src === artSrc) return;
  artSrc = src;
  const t = ++artToken;
  const show = (url?: string) => {
    if (t !== artToken) return;
    if (url) artFlip = !artFlip;
    lightEls().forEach((el) => {
      if (url) el.style.setProperty(artFlip ? "--art-a" : "--art-b", `url(${JSON.stringify(url)})`);
      el.dataset.art = url ? (artFlip ? "a" : "b") : "";
    });
  };
  if (!src) return show();
  const img = new Image();
  img.decoding = "async";
  img.onload = () => show(src);
  img.onerror = () => show();
  img.src = src;
}

/**
 * The last room is remembered, so a cold start (or a page with no title of its own, opened
 * first) is lit straight away by the film you last looked at instead of an empty black room.
 */
const ROOM_KEY = "abx.room";
let restored: { src?: string; tones: Tones } | undefined;
function remember(src: string | undefined, tones: Tones) {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({ src, tones }));
  } catch {
    /* storage full or blocked: the room just starts dark next time */
  }
}
const dynamicEnabled = () => getSettings().dynamicLight !== false;

function setRootTones(t: Tones) {
  const r = document.documentElement.style;
  r.setProperty("--tone", t.tone);
  r.setProperty("--tone-ink", t.ink);
  r.setProperty("--tone-deep", t.deep);
}
function clearRootTones() {
  const r = document.documentElement.style;
  r.removeProperty("--tone");
  r.removeProperty("--tone-ink");
  r.removeProperty("--tone-deep");
  paintLight(undefined);
}
function restoreRoom() {
  if (typeof window === "undefined") return;
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY) || "null") as typeof restored | null;
    const t = saved?.tones;
    if (!t || ![t.tone, t.ink, t.deep, t.l1, t.l2].every((v) => typeof v === "string" && v.startsWith("oklch("))) return;
    restored = saved;
  } catch {
    return;
  }
  if (!dynamicEnabled()) return;
  setRootTones(restored.tones);
  // The room element mounts with the app; wait a few frames for it, unless a page lit it first.
  let tries = 0;
  const paint = () => {
    if (base || !dynamicEnabled()) return;
    if (!document.querySelector(".light")) {
      if (++tries < 120) requestAnimationFrame(paint);
      return;
    }
    paintLight(restored!.tones);
    paintArt(restored!.src);
  };
  requestAnimationFrame(paint);
}
restoreRoom();

let cachedLightMode: boolean | undefined;
let previewToken = 0;
function clearPreview() {
  previewToken++;
  if (!dynamicEnabled()) {
    paintLight(undefined);
    return;
  }
  paintLight(baseTones ?? restored?.tones);
}

/** Re-sync ambient lighting and accent tones when the user switches theme or toggles dynamic light. */
export function syncThemeLight() {
  const light = isLightTheme(resolveTheme(getSettings().theme));
  if (cachedLightMode !== undefined && cachedLightMode !== light) {
    cache.clear();
    baseTones = undefined;
  }
  cachedLightMode = light;
  if (!dynamicEnabled()) {
    clearRootTones();
    return;
  }
  if (base) {
    const cur = base;
    base = undefined;
    setStageLight(cur);
  } else if (restored?.tones) {
    setRootTones(restored.tones);
    paintLight(restored.tones);
  }
}

/** The title a page is "about" (hero slide, title page, player). Sets the app-wide tones. */
export function setStageLight(m: Media | undefined) {
  if (m?.key === base?.key && (m?.backdrop ?? m?.poster) === (base?.backdrop ?? base?.poster)) return;
  base = m;
  const t = ++token;
  // A card you clicked never gets its mouse-leave: don't let its preview outlive the page.
  clearTimeout(hoverTimer);
  previewToken++;
  const src = artOf(m);
  paintArt(src);
  if (!m) return;
  tonesFor(m).then((tones) => {
    if (t !== token) return;
    baseTones = tones;
    remember(src, tones);
    if (!dynamicEnabled()) return;
    setRootTones(tones);
    paintLight(tones);
  });
}

/**
 * Hovering a card borrows the room's light for a moment; leaving hands it back. Debounced, so
 * sweeping the pointer along a shelf doesn't sample every card it crosses.
 */
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
export function previewLight(m: Media | null) {
  if (!dynamicEnabled()) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(
    () => {
      if (!dynamicEnabled()) return;
      if (!m) return clearPreview();
      const t = ++previewToken;
      tonesFor(m).then((tones) => {
        if (t === previewToken && dynamicEnabled()) paintLight(tones);
      });
    },
    m ? 160 : 80,
  );
}