import { sized } from "../components/Art";
import type { Media } from "./types";

/**
 * Stage light: the whole app is lit by whatever title has focus. Two colors are sampled
 * from its artwork. --a1 / --a2 on :root (read by glows and halos) switch instantly; the big
 * stage gradient eases through its own --l1 / --l2 on the .light layer only, so a light change
 * restyles one element instead of the whole page every frame.
 */
type Pair = [string, string];
const cache = new Map<string, Pair>();
let base: Media | undefined;
let token = 0;

const hashHue = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};

function fromHue(h: number): Pair {
  return [`hsl(${h} 50% 30%)`, `hsl(${(h + 45) % 360} 50% 20%)`];
}

function hexToHsl(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(clean)
    ? clean.replace(/./g, (c) => c + c)
    : /^[0-9a-f]{6}$/i.test(clean)
      ? clean
      : null;
  if (!full) return null;
  const n = parseInt(full, 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * Keep sampled colors in a range that reads as light on near-black without drowning the brand:
 * moderate saturation, dark. The CSS also blends them toward violet, so every title still feels AbixCine.
 */
const tone = ([h, s]: [number, number, number], l: number) =>
  `hsl(${Math.round(h)} ${Math.round(Math.max(0.3, Math.min(0.55, s)) * 100)}% ${Math.min(l, 30)}%)`;

/** Two dominant hues of an image: bucket pixels by hue, weight by how vivid they are. */
function sample(src: string): Promise<Pair> {
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
        const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0 }));
        for (let i = 0; i < px.length; i += 4) {
          const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
          const w = s * (1 - Math.abs(l - 0.5) * 2);
          if (w < 0.05) continue;
          const b = buckets[Math.floor(h / 30) % 12];
          b.w += w;
          b.h += h * w;
          b.s += s * w;
        }
        const ranked = buckets.map((b, i) => ({ ...b, i })).filter((b) => b.w > 0).sort((a, b) => b.w - a.w);
        if (!ranked.length) return reject(new Error("flat"));
        const pick = (b: (typeof ranked)[number]) => [b.h / b.w, b.s / b.w, 0.5] as [number, number, number];
        const first = ranked[0];
        const second = ranked.find((b) => Math.min(Math.abs(b.i - first.i), 12 - Math.abs(b.i - first.i)) >= 2) ?? first;
        resolve([tone(pick(first), 42), tone(pick(second), 24)]);
      } catch (e) {
        reject(e); // tainted canvas: the CDN didn't allow CORS
      }
    };
    img.onerror = reject;
    // 32×18 pixels are all we read, so fetch the smallest rendition, not the 4K backdrop.
    img.src = sized(src, "w92") ?? src;
  });
}

async function colorsFor(m: Media): Promise<Pair> {
  const src = m.backdrop ?? m.poster;
  const id = m.key;
  const hit = cache.get(id);
  if (hit) return hit;
  let pair: Pair;
  const hsl = m.color ? hexToHsl(m.color) : null;
  if (hsl) {
    pair = [tone(hsl, 42), tone([(hsl[0] + 40) % 360, hsl[1], 0.5], 24)];
  } else if (src) {
    pair = await sample(src).catch(() => fromHue(m.hue ?? hashHue(m.key)));
  } else {
    pair = fromHue(m.hue ?? hashHue(m.key));
  }
  cache.set(id, pair);
  return pair;
}

let previewToken = 0;
const lightEl = () => document.querySelector<HTMLElement>(".light");

function clearPreview() {
  previewToken++;
  const s = lightEl()?.style;
  s?.removeProperty("--a1");
  s?.removeProperty("--a2");
}

/** The title a page is "about" (hero slide, title page, player). Sets the app-wide colors. */
export function setStageLight(m: Media | undefined) {
  if (m?.key === base?.key && (m?.backdrop ?? m?.poster) === (base?.backdrop ?? base?.poster)) return;
  base = m;
  const t = ++token;
  // A card you clicked never gets its mouse-leave: don't let its preview outlive the page.
  clearPreview();
  if (!m) return;
  colorsFor(m).then(([a1, a2]) => {
    if (t !== token) return;
    const r = document.documentElement.style;
    r.setProperty("--a1", a1);
    r.setProperty("--a2", a2);
    document.querySelectorAll<HTMLElement>(".light").forEach((el) => {
      el.style.setProperty("--l1", a1);
      el.style.setProperty("--l2", a2);
    });
  });
}

/**
 * Hovering a card borrows the light for a moment; leaving hands it back. Debounced, so sweeping
 * the pointer along a shelf doesn't sample every card it crosses. The preview recolors the
 * backdrop layer alone: writing it on :root (as before) made the browser restyle every element
 * in the app each time the mouse crossed a card.
 */
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
export function previewLight(m: Media | null) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!m) return clearPreview();
    const t = ++previewToken;
    colorsFor(m).then(([a1, a2]) => {
      const s = lightEl()?.style;
      if (t !== previewToken || !s) return;
      s.setProperty("--a1", a1);
      s.setProperty("--a2", a2);
    });
  }, m ? 140 : 60);
}
