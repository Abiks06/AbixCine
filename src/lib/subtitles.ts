/**
 * Core subtitle engine shared across player, sources, and settings:
 * - Multi-encoding decoding (UTF-8/BOM, UTF-16LE/BE, Windows-1252)
 * - Structured parser & cue engine for WebVTT, SRT, and ASS/SSA
 * - Binary-search active cue lookup with offset & overlap support
 * - Preference schema + persistence (`abx.subs.v1`) & per-media track memory
 * - Smart track matching & language normalization
 */

/* ------------------------------------------------------------------ types */

export type CueSize = "xs" | "s" | "m" | "l" | "xl";
export type SubFont = "sans" | "serif" | "mono" | "rounded";
export type SubBg = "glass" | "box" | "none";
export type SubEdge = "shadow" | "outline" | "raised" | "none";
export type SubMode = "auto" | "on" | "off";
export type SubHIFilter = "any" | "avoid" | "prefer";

export interface SubPref {
  /** Legacy explicit on/off; undefined means "auto" (on for subbed anime / foreign language). */
  on?: boolean;
  /** Subtitle activation mode ("auto" | "on" | "off"). */
  mode: SubMode;
  /** Primary preferred language code (e.g. "en", "pt-br"). */
  lang: string;
  /** Secondary (dual) subtitle language code ("" = off). */
  secondaryLang: string;
  size: CueSize;
  font: SubFont;
  color: string;
  bg: SubBg;
  bgOpacity: number;
  edge: SubEdge;
  bottomPct: number;
  lineHeight: number;
  preferHearingImpaired: SubHIFilter;
  autoFetchOnline: boolean;
}

export interface CueSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
}

/** Numpad alignment (1=bottom-left .. 2=bottom-center .. 8=top-center .. 9=top-right). */
export type CueAlign = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
  spans: CueSpan[];
  align: CueAlign;
  pos?: { xPct: number; yPct: number };
  layer?: number;
}

export interface ParsedSubtitles {
  format: "vtt" | "srt" | "ass";
  cues: SubtitleCue[];
  vtt: string;
}

export interface MatchableSubtitleTrack {
  lang?: string;
  label?: string;
  format?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  source?: string;
}

export interface SubTrackMemoryEntry {
  selectedLang?: string;
  selectedLabel?: string;
  secondaryLang?: string;
  offsetSec?: number;
  enabled?: boolean;
  updatedAt?: number;
}

/* ----------------------------------------------------------- language map */

const THREE_TO_TWO: Record<string, string> = {
  eng: "en", jpn: "ja", fre: "fr", fra: "fr", spa: "es", ger: "de", deu: "de",
  por: "pt", pob: "pt", ita: "it", ara: "ar", chi: "zh", zho: "zh", zhs: "zh", zht: "zh",
  kor: "ko", rus: "ru", hin: "hi", tur: "tr", pol: "pl", nld: "nl", dut: "nl",
  ind: "id", tha: "th", vie: "vi", swe: "sv", may: "ms", msa: "ms",
  ukr: "uk", ces: "cs", cze: "cs", ron: "ro", rum: "ro", ell: "el", gre: "el",
  heb: "he", hun: "hu", dan: "da", nor: "no", nob: "no", nno: "no", fin: "fi",
  bul: "bg", hrv: "hr", srp: "sr", slk: "sk", slo: "sk", fas: "fa", per: "fa",
  ben: "bn", tam: "ta", tel: "te", urd: "ur", cat: "ca", tgl: "tl", fil: "fil",
  jp: "ja", pb: "pt",
};

const NAMES: Record<string, string> = {
  english: "en", japanese: "ja", french: "fr", spanish: "es", german: "de",
  portuguese: "pt", brazilian: "pt", italian: "it", arabic: "ar", chinese: "zh",
  korean: "ko", russian: "ru", hindi: "hi", turkish: "tr", polish: "pl",
  dutch: "nl", indonesian: "id", thai: "th", vietnamese: "vi", swedish: "sv",
  malay: "ms", ukrainian: "uk", czech: "cs", romanian: "ro", greek: "el",
  hebrew: "he", hungarian: "hu", danish: "da", norwegian: "no", finnish: "fi",
  bulgarian: "bg", croatian: "hr", serbian: "sr", slovak: "sk", persian: "fa",
  farsi: "fa", bengali: "bn", tamil: "ta", telugu: "te", urdu: "ur", catalan: "ca",
  tagalog: "tl", filipino: "fil",
};

export const COMMON_SUB_LANGS: readonly { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "pt-br", label: "Portuguese (Brazil)" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "zh-tw", label: "Chinese (Traditional)" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ru", label: "Russian" },
  { code: "tr", label: "Turkish" },
  { code: "pl", label: "Polish" },
  { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" },
  { code: "no", label: "Norwegian" },
  { code: "da", label: "Danish" },
  { code: "fi", label: "Finnish" },
  { code: "id", label: "Indonesian" },
  { code: "ms", label: "Malay" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "uk", label: "Ukrainian" },
  { code: "cs", label: "Czech" },
  { code: "ro", label: "Romanian" },
  { code: "el", label: "Greek" },
  { code: "he", label: "Hebrew" },
  { code: "hu", label: "Hungarian" },
];

const LANG_LABELS: Record<string, string> = {
  ...Object.fromEntries(COMMON_SUB_LANGS.map((l) => [l.code, l.label])),
  zh: "Chinese",
  bg: "Bulgarian",
  hr: "Croatian",
  sr: "Serbian",
  sk: "Slovak",
  fa: "Persian",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  ur: "Urdu",
  ca: "Catalan",
  tl: "Tagalog",
  fil: "Filipino",
};

/** "eng", "en-US", "English" -> "en". Unknown stays as given (lowercased). */
export function langBase(lang?: string): string {
  const l = (lang ?? "").toLowerCase().trim();
  if (!l) return "und";
  const head = l.split(/[-_\s]/)[0];
  return THREE_TO_TWO[head] ?? NAMES[head] ?? head;
}

/** Normalize language code preserving key regional subtitle variants (`pt-br`, `zh-tw`). */
export function normalizeSubLang(code?: string): string {
  const raw = (code ?? "").toLowerCase().trim().replace(/_/g, "-");
  if (!raw || raw === "und" || raw === "unknown") return "und";
  if (raw === "pob" || raw === "pb" || raw === "pt-br" || raw.includes("brazil")) return "pt-br";
  if (raw === "zht" || raw === "zh-tw" || raw === "zh-hk" || raw === "zh-hant" || raw.includes("traditional")) return "zh-tw";
  if (raw === "zhs" || raw === "zh-cn" || raw === "zh-hans" || raw.includes("simplified")) return "zh";
  return langBase(raw);
}

/** Human-readable display name for a language code ("eng" -> "English", "pt-br" -> "Portuguese (Brazil)"). */
export function langLabel(code?: string): string {
  const norm = normalizeSubLang(code);
  if (norm === "und") return "Unknown";
  if (LANG_LABELS[norm]) return LANG_LABELS[norm];
  const base = langBase(norm);
  if (LANG_LABELS[base]) return LANG_LABELS[base];
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
      const display = new Intl.DisplayNames(["en"], { type: "language" }).of(norm);
      if (display && display.toLowerCase() !== norm) return display;
    }
  } catch {
    /* ignore invalid BCP-47 tag */
  }
  return (code ?? "").trim().toUpperCase() || "Unknown";
}

/* ------------------------------------------------------------ preferences */

const KEY = "abx.subs.v1";
export const SUB_PREF_EVENT = "abx:subpref";

export const DEFAULT_SUB_PREF: SubPref = {
  mode: "auto",
  lang: "en",
  secondaryLang: "",
  size: "m",
  font: "sans",
  color: "#ffffff",
  bg: "glass",
  bgOpacity: 0.72,
  edge: "shadow",
  bottomPct: 7,
  lineHeight: 1.35,
  preferHearingImpaired: "any",
  autoFetchOnline: false,
};

const CUE_SIZES = new Set<CueSize>(["xs", "s", "m", "l", "xl"]);
const SUB_FONTS = new Set<SubFont>(["sans", "serif", "mono", "rounded"]);
const SUB_BGS = new Set<SubBg>(["glass", "box", "none"]);
const SUB_EDGES = new Set<SubEdge>(["shadow", "outline", "raised", "none"]);
const SUB_MODES = new Set<SubMode>(["auto", "on", "off"]);
const SUB_HI = new Set<SubHIFilter>(["any", "avoid", "prefer"]);

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function safeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function finiteOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function deriveModeAndOn(raw: Record<string, unknown>): { mode: SubMode; on: boolean | undefined } {
  if (typeof raw.mode === "string" && SUB_MODES.has(raw.mode as SubMode)) {
    const mode = raw.mode as SubMode;
    return { mode, on: mode === "on" ? true : mode === "off" ? false : undefined };
  }
  if (typeof raw.on === "boolean") {
    return { mode: raw.on ? "on" : "off", on: raw.on };
  }
  return { mode: DEFAULT_SUB_PREF.mode, on: undefined };
}

/** Normalize any raw preference payload (including legacy `abx.subs.v1`) into a full `SubPref`. */
export function normalizeSubPref(raw?: Partial<SubPref> | Record<string, unknown> | null): SubPref {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { mode, on } = deriveModeAndOn(src);
  const rawLang = typeof src.lang === "string" ? src.lang.trim() : "";
  const normLang = rawLang ? normalizeSubLang(rawLang) : DEFAULT_SUB_PREF.lang;
  const rawSec = typeof src.secondaryLang === "string" ? src.secondaryLang.trim() : "";
  const normSec = rawSec ? normalizeSubLang(rawSec) : "";

  return {
    ...(on !== undefined ? { on } : {}),
    mode,
    lang: normLang === "und" ? DEFAULT_SUB_PREF.lang : normLang,
    secondaryLang: normSec === "und" ? "" : normSec,
    size: SUB_SIZE_OR(src.size, DEFAULT_SUB_PREF.size),
    font: SUB_FONTS.has(src.font as SubFont) ? (src.font as SubFont) : DEFAULT_SUB_PREF.font,
    color: safeHexColor(src.color, DEFAULT_SUB_PREF.color),
    bg: SUB_BGS.has(src.bg as SubBg) ? (src.bg as SubBg) : DEFAULT_SUB_PREF.bg,
    bgOpacity: finiteOr(src.bgOpacity, DEFAULT_SUB_PREF.bgOpacity, 0, 1),
    edge: SUB_EDGES.has(src.edge as SubEdge) ? (src.edge as SubEdge) : DEFAULT_SUB_PREF.edge,
    bottomPct: finiteOr(src.bottomPct, DEFAULT_SUB_PREF.bottomPct, 2, 45),
    lineHeight: finiteOr(src.lineHeight, DEFAULT_SUB_PREF.lineHeight, 1, 2.2),
    preferHearingImpaired: SUB_HI.has(src.preferHearingImpaired as SubHIFilter)
      ? (src.preferHearingImpaired as SubHIFilter)
      : DEFAULT_SUB_PREF.preferHearingImpaired,
    autoFetchOnline: typeof src.autoFetchOnline === "boolean" ? src.autoFetchOnline : DEFAULT_SUB_PREF.autoFetchOnline,
  };
}

function SUB_SIZE_OR(v: unknown, fallback: CueSize): CueSize {
  return CUE_SIZES.has(v as CueSize) ? (v as CueSize) : fallback;
}

export function loadSubPref(): SubPref {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SUB_PREF };
    return normalizeSubPref(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SUB_PREF };
  }
}

export function saveSubPref(patchOrFull: Partial<SubPref>): SubPref {
  const cur = loadSubPref();
  const patch = (patchOrFull && typeof patchOrFull === "object" ? patchOrFull : {}) as Partial<SubPref>;
  const merged: Record<string, unknown> = { ...cur, ...patch };

  // Keep legacy `on` and new `mode` synchronized even when a caller spreads an older `SubPref` object.
  const hasMode = "mode" in patch && patch.mode !== undefined && SUB_MODES.has(patch.mode);
  const hasOn = "on" in patch;
  if (hasMode && (!hasOn || patch.mode !== cur.mode)) {
    merged.mode = patch.mode;
    merged.on = patch.mode === "on" ? true : patch.mode === "off" ? false : undefined;
  } else if (hasOn && patch.on !== cur.on) {
    merged.on = patch.on;
    merged.mode = patch.on === true ? "on" : patch.on === false ? "off" : "auto";
  }

  const next = normalizeSubPref(merged);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the choice lasts this session only */
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent<SubPref>(SUB_PREF_EVENT, { detail: next }));
    } catch {
      /* non-DOM environment */
    }
  }
  return next;
}

/* ------------------------------------------------------ audio convenience */

/** Audio-track languages that mean "sub" (original Japanese) or "dub" (English). */
export const audioLangs = (a: "sub" | "dub") => (a === "dub" ? ["en"] : ["ja"]);

/** Prefer the requested anime track, otherwise the title's original-language track. */
export function preferredAudioTrackIndex(
  tracks: { lang?: string }[],
  audio?: "sub" | "dub",
  originalLanguage?: string,
): number {
  const langs = audio ? audioLangs(audio) : originalLanguage ? [langBase(originalLanguage)] : [];
  return tracks.findIndex((track) => langs.includes(langBase(track.lang)));
}

/* --------------------------------------------------------------- decoding */

function decodeUtf16BeFallback(bytes: Uint8Array): string {
  const evenLen = bytes.length & ~1;
  const swapped = new Uint8Array(evenLen);
  for (let i = 0; i < evenLen; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return new TextDecoder("utf-16le").decode(swapped);
}

/**
 * Decode subtitle bytes handling:
 * - UTF-8 BOM (`EF BB BF`)
 * - UTF-16LE BOM (`FF FE`)
 * - UTF-16BE BOM (`FE FF`)
 * - Strict UTF-8
 * - Windows-1252 / ISO-8859-1 fallback
 */
export function decodeSubtitle(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return "";

  // UTF-16LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  }

  // UTF-16BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be").decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      return decodeUtf16BeFallback(bytes.subarray(2)).replace(/^\uFEFF/, "");
    }
  }

  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      return new TextDecoder("windows-1252").decode(bytes.subarray(3));
    }
  }

  // Strict UTF-8, falling back to Windows-1252
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/* ----------------------------------------------------- format & cue utils */

function normalizeRaw(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function hintToFormat(hint?: string): "vtt" | "srt" | "ass" | null {
  if (!hint) return null;
  const cleaned = hint.trim().toLowerCase().split(/[?#]/)[0];
  if (cleaned === "vtt" || cleaned.endsWith(".vtt")) return "vtt";
  if (cleaned === "srt" || cleaned.endsWith(".srt")) return "srt";
  if (cleaned === "ass" || cleaned === "ssa" || cleaned.endsWith(".ass") || cleaned.endsWith(".ssa")) return "ass";
  return null;
}

/** Detect whether subtitle text is WebVTT, ASS/SSA, or SRT. */
export function detectSubtitleFormat(raw: string, hint?: string): "vtt" | "srt" | "ass" {
  const t = normalizeRaw(raw);
  const trimmed = t.trimStart();
  if (/^WEBVTT(?:\s|$|-)/i.test(trimmed)) return "vtt";
  if (/^\s*\[Script Info\]/im.test(t) || /^\s*\[V4\+? Styles\]/im.test(t) || /^\s*\[Events\]/im.test(t) || /^\s*Dialogue:\s*\d+/im.test(t)) {
    return "ass";
  }
  const byHint = hintToFormat(hint);
  if (/\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(t)) return "srt";
  if (/(?:\d{1,2}:)?\d{2}:\d{2}\.\d{1,3}\s*-->/.test(t)) return byHint === "srt" ? "srt" : "vtt";
  return byHint ?? "srt";
}

function coalesceSpans(spans: CueSpan[]): CueSpan[] {
  const out: CueSpan[] = [];
  for (const s of spans) {
    if (!s.text) continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      Boolean(prev.bold) === Boolean(s.bold) &&
      Boolean(prev.italic) === Boolean(s.italic) &&
      Boolean(prev.underline) === Boolean(s.underline) &&
      Boolean(prev.strike) === Boolean(s.strike) &&
      prev.color === s.color
    ) {
      prev.text += s.text;
    } else {
      const clean: CueSpan = { text: s.text };
      if (s.bold) clean.bold = true;
      if (s.italic) clean.italic = true;
      if (s.underline) clean.underline = true;
      if (s.strike) clean.strike = true;
      if (s.color) clean.color = s.color;
      out.push(clean);
    }
  }
  return out;
}

function toCueAlign(n: number): CueAlign {
  return n >= 1 && n <= 9 ? (n as CueAlign) : 2;
}

const SSA_LEGACY_ALIGN: Record<number, CueAlign> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 7,
  6: 8,
  7: 9,
  8: 8,
  9: 4,
  10: 5,
  11: 6,
};

function legacyAlignToNumpad(n: number): CueAlign {
  return SSA_LEGACY_ALIGN[n] ?? 2;
}

/* ----------------------------------------------------- ASS / SSA parsing */

interface AssStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  align: CueAlign;
}

function parseAssColor(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const hexMatch = s.match(/^&H([0-9a-fA-F]+)&?$/i);
  let bgrHex: string;
  if (hexMatch) {
    const hex = hexMatch[1].padStart(6, "0");
    bgrHex = hex.slice(-6);
  } else if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return undefined;
    bgrHex = ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  } else {
    return undefined;
  }
  const bb = bgrHex.slice(0, 2);
  const gg = bgrHex.slice(2, 4);
  const rr = bgrHex.slice(4, 6);
  return `#${rr}${gg}${bb}`.toLowerCase();
}

function parseAssBool(raw?: string): boolean {
  if (!raw) return false;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return false;
  return n !== 0 && n !== 400;
}

function parseTimestamp(raw: string): number {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/);
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec) || !Number.isFinite(frac)) return NaN;
  return h * 3600 + min * 60 + sec + frac;
}

function splitAssFields(payload: string, fieldCount: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < fieldCount - 1; i++) {
    const comma = payload.indexOf(",", start);
    if (comma === -1) break;
    out.push(payload.slice(start, comma));
    start = comma + 1;
  }
  out.push(payload.slice(start));
  return out;
}

/** Split an ASS override block `{...}` into top-level `\tag` tokens, respecting `(...)` nesting. */
function tokenizeAssTags(block: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] !== "\\") {
      i++;
      continue;
    }
    let j = i + 1;
    let depth = 0;
    while (j < block.length) {
      const ch = block[j];
      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0) depth--;
      else if (ch === "\\" && depth === 0) break;
      j++;
    }
    tokens.push(block.slice(i + 1, j));
    i = j;
  }
  return tokens;
}

interface InlineStyleState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
}

function applyAssTagToken(
  token: string,
  state: InlineStyleState,
  baseStyle: AssStyle,
  stylesMap: Map<string, AssStyle>,
  playResX: number,
  playResY: number,
  meta: { align?: CueAlign; pos?: { xPct: number; yPct: number }; drawing: boolean },
) {
  const t = token.trim();
  if (!t) return;

  const posMatch = t.match(/^pos\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)/i);
  if (posMatch) {
    const x = Number(posMatch[1]);
    const y = Number(posMatch[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      meta.pos = {
        xPct: Math.round(clamp((x / playResX) * 100, 0, 100) * 100) / 100,
        yPct: Math.round(clamp((y / playResY) * 100, 0, 100) * 100) / 100,
      };
    }
    return;
  }

  const moveMatch = t.match(/^move\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)/i);
  if (moveMatch && !meta.pos) {
    const x = Number(moveMatch[1]);
    const y = Number(moveMatch[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      meta.pos = {
        xPct: Math.round(clamp((x / playResX) * 100, 0, 100) * 100) / 100,
        yPct: Math.round(clamp((y / playResY) * 100, 0, 100) * 100) / 100,
      };
    }
    return;
  }

  const anMatch = t.match(/^an([1-9])$/);
  if (anMatch) {
    meta.align = toCueAlign(Number(anMatch[1]));
    return;
  }

  const aMatch = t.match(/^a(\d+)$/);
  if (aMatch) {
    meta.align = legacyAlignToNumpad(Number(aMatch[1]));
    return;
  }

  const pMatch = t.match(/^p(\d+)$/);
  if (pMatch) {
    meta.drawing = Number(pMatch[1]) > 0;
    return;
  }

  const bMatch = t.match(/^b(\d*)$/);
  if (bMatch) {
    if (!bMatch[1]) state.bold = baseStyle.bold;
    else {
      const w = Number(bMatch[1]);
      state.bold = w === 1 || w >= 600;
    }
    return;
  }

  const iMatch = t.match(/^i(\d*)$/);
  if (iMatch) {
    state.italic = !iMatch[1] ? baseStyle.italic : Number(iMatch[1]) !== 0;
    return;
  }

  const uMatch = t.match(/^u(\d*)$/);
  if (uMatch) {
    state.underline = !uMatch[1] ? baseStyle.underline : Number(uMatch[1]) !== 0;
    return;
  }

  const sMatch = t.match(/^s(\d*)$/);
  if (sMatch) {
    state.strike = !sMatch[1] ? baseStyle.strike : Number(sMatch[1]) !== 0;
    return;
  }

  const colorMatch = t.match(/^1?c(?:(&H[0-9a-fA-F]*&?))?$/i);
  if (colorMatch) {
    state.color = colorMatch[1] ? (parseAssColor(colorMatch[1]) ?? baseStyle.color) : baseStyle.color;
    return;
  }

  if (t.startsWith("r")) {
    const targetName = t.slice(1).trim();
    const resetTo =
      (targetName && (stylesMap.get(targetName) ?? stylesMap.get(targetName.toLowerCase()))) || baseStyle;
    state.bold = resetTo.bold;
    state.italic = resetTo.italic;
    state.underline = resetTo.underline;
    state.strike = resetTo.strike;
    state.color = resetTo.color;
  }
}

function parseAssDialogueText(
  rawText: string,
  baseStyle: AssStyle,
  stylesMap: Map<string, AssStyle>,
  playResX: number,
  playResY: number,
): { spans: CueSpan[]; align: CueAlign; pos?: { xPct: number; yPct: number } } {
  const state: InlineStyleState = {
    bold: baseStyle.bold,
    italic: baseStyle.italic,
    underline: baseStyle.underline,
    strike: baseStyle.strike,
    color: baseStyle.color,
  };
  const meta: { align?: CueAlign; pos?: { xPct: number; yPct: number }; drawing: boolean } = {
    drawing: false,
  };
  const rawSpans: CueSpan[] = [];

  const pushText = (chunk: string) => {
    if (!chunk || meta.drawing) return;
    const expanded = chunk
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\h/g, "\u00A0");
    rawSpans.push({
      text: expanded,
      ...(state.bold ? { bold: true } : {}),
      ...(state.italic ? { italic: true } : {}),
      ...(state.underline ? { underline: true } : {}),
      ...(state.strike ? { strike: true } : {}),
      ...(state.color ? { color: state.color } : {}),
    });
  };

  let cursor = 0;
  while (cursor < rawText.length) {
    const open = rawText.indexOf("{", cursor);
    if (open === -1) {
      pushText(rawText.slice(cursor));
      break;
    }
    const close = rawText.indexOf("}", open + 1);
    if (close === -1) {
      pushText(rawText.slice(cursor));
      break;
    }
    if (open > cursor) pushText(rawText.slice(cursor, open));
    const inner = rawText.slice(open + 1, close);
    for (const tok of tokenizeAssTags(inner)) {
      applyAssTagToken(tok, state, baseStyle, stylesMap, playResX, playResY, meta);
    }
    cursor = close + 1;
  }

  return {
    spans: coalesceSpans(rawSpans),
    align: meta.align ?? baseStyle.align,
    ...(meta.pos ? { pos: meta.pos } : {}),
  };
}

function lookupAssStyle(styles: Map<string, AssStyle>, name: string): AssStyle {
  const defaultStyle: AssStyle = { bold: false, italic: false, underline: false, strike: false, align: 2 };
  const trimmed = name.trim();
  if (!trimmed) return styles.get("default") ?? defaultStyle;
  return (
    styles.get(trimmed) ??
    styles.get(trimmed.toLowerCase()) ??
    styles.get(trimmed.replace(/^\*/, "").toLowerCase()) ??
    styles.get("default") ??
    defaultStyle
  );
}

function parseAssSubtitles(normalized: string): SubtitleCue[] {
  const lines = normalized.split("\n");
  let section = "";
  let playResX = 384;
  let playResY = 288;
  let styleFormat = ["name", "fontname", "fontsize", "primarycolour", "secondarycolour", "outlinecolour", "backcolour", "bold", "italic", "underline", "strikeout", "scalex", "scaley", "spacing", "angle", "borderstyle", "outline", "shadow", "alignment", "marginl", "marginr", "marginv", "encoding"];
  let eventFormat = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  const styles = new Map<string, AssStyle>();
  const cues: SubtitleCue[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("!:")) continue;

    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      section = secMatch[1].trim().toLowerCase();
      continue;
    }

    if (section === "script info" || !section) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        const key = m[1].trim().toLowerCase();
        const val = Number(m[2].trim());
        if (key === "playresx" && Number.isFinite(val) && val > 0) playResX = val;
        if (key === "playresy" && Number.isFinite(val) && val > 0) playResY = val;
      }
      continue;
    }

    if (section === "v4+ styles" || section === "v4 styles") {
      if (/^Format:/i.test(line)) {
        styleFormat = line.slice(line.indexOf(":") + 1).split(",").map((c) => c.trim().toLowerCase());
      } else if (/^Style:/i.test(line)) {
        const fields = splitAssFields(line.slice(line.indexOf(":") + 1).trimStart(), styleFormat.length);
        const col = (name: string) => {
          const idx = styleFormat.indexOf(name);
          return idx >= 0 ? fields[idx]?.trim() : undefined;
        };
        const styleName = col("name") || "Default";
        const parsedColor = parseAssColor(col("primarycolour"));
        // Keep standard pure white (#ffffff) unset on the base style so the viewer's color preference still applies.
        const color = parsedColor && parsedColor !== "#ffffff" ? parsedColor : undefined;
        const alignRaw = Number(col("alignment") ?? "2");
        const align = section === "v4 styles" ? legacyAlignToNumpad(alignRaw) : toCueAlign(alignRaw);
        const styleObj: AssStyle = {
          bold: parseAssBool(col("bold")),
          italic: parseAssBool(col("italic")),
          underline: parseAssBool(col("underline")),
          strike: parseAssBool(col("strikeout")),
          ...(color ? { color } : {}),
          align,
        };
        styles.set(styleName, styleObj);
        styles.set(styleName.toLowerCase(), styleObj);
      }
      continue;
    }

    if (section === "events") {
      if (/^Format:/i.test(line)) {
        eventFormat = line.slice(line.indexOf(":") + 1).split(",").map((c) => c.trim().toLowerCase());
      } else if (/^Dialogue:/i.test(line)) {
        const textIdx = eventFormat.indexOf("text");
        const colCount = textIdx >= 0 ? textIdx + 1 : eventFormat.length;
        const fields = splitAssFields(line.slice(line.indexOf(":") + 1).trimStart(), colCount);
        const idxOf = (name: string) => eventFormat.indexOf(name);
        const startIdx = idxOf("start");
        const endIdx = idxOf("end");
        if (startIdx < 0 || endIdx < 0) continue;

        const start = parseTimestamp(fields[startIdx] ?? "");
        const end = parseTimestamp(fields[endIdx] ?? "");
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

        const layerIdx = idxOf("layer");
        const layerVal = layerIdx >= 0 ? Number(fields[layerIdx]?.trim()) : 0;
        const layer = Number.isFinite(layerVal) ? layerVal : 0;

        const styleIdx = idxOf("style");
        const baseStyle = lookupAssStyle(styles, styleIdx >= 0 ? (fields[styleIdx] ?? "") : "");

        const rawText = textIdx >= 0 ? (fields[textIdx] ?? "") : (fields[fields.length - 1] ?? "");
        const parsed = parseAssDialogueText(rawText, baseStyle, styles, playResX, playResY);
        const text = parsed.spans.map((s) => s.text).join("");
        if (!text.trim()) continue;

        cues.push({
          id: `ass-${cues.length + 1}`,
          start,
          end,
          text,
          spans: parsed.spans,
          align: parsed.align,
          ...(parsed.pos ? { pos: parsed.pos } : {}),
          layer,
        });
      }
    }
  }

  cues.sort((a, b) => a.start - b.start || (a.layer ?? 0) - (b.layer ?? 0) || a.end - b.end);
  return cues;
}

/* ----------------------------------------------------- VTT & SRT parsing */

const SAFE_NAMED_COLORS = new Set([
  "white", "black", "red", "green", "blue", "yellow", "cyan", "magenta",
  "lime", "aqua", "silver", "gray", "grey", "orange", "pink", "purple", "gold",
]);

function sanitizeCssColor(raw?: string): string | undefined {
  if (!raw) return undefined;
  const c = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (SAFE_NAMED_COLORS.has(c)) return c;
  return undefined;
}

function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&nbsp;/gi, "\u00A0")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = Number(dec);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&amp;/gi, "&");
}

function parseVttInlineText(rawText: string): { spans: CueSpan[]; alignOverride?: CueAlign; posOverride?: { xPct: number; yPct: number } } {
  // Handle optional ASS-style overrides sometimes embedded inside SRT cues (e.g. {\an8}, {\b1}).
  let cleaned = rawText;
  let alignOverride: CueAlign | undefined;
  let posOverride: { xPct: number; yPct: number } | undefined;
  const assMeta = { drawing: false } as { align?: CueAlign; pos?: { xPct: number; yPct: number }; drawing: boolean };
  const dummyState: InlineStyleState = { bold: false, italic: false, underline: false, strike: false };
  const dummyStyles = new Map<string, AssStyle>();
  const dummyBase: AssStyle = { bold: false, italic: false, underline: false, strike: false, align: 2 };

  // Convert ASS inline formatting tags in SRT into safe HTML markers or capture alignment/position, stripping unknown {\...}.
  cleaned = cleaned.replace(/\{\\[^}]*\}/g, (match) => {
    const inner = match.slice(1, -1);
    let out = "";
    for (const tok of tokenizeAssTags(inner)) {
      const prevBold = dummyState.bold;
      const prevItalic = dummyState.italic;
      const prevUnderline = dummyState.underline;
      const prevStrike = dummyState.strike;
      const prevColor = dummyState.color;
      applyAssTagToken(tok, dummyState, dummyBase, dummyStyles, 384, 288, assMeta);
      if (dummyState.bold !== prevBold) out += dummyState.bold ? "<b>" : "</b>";
      if (dummyState.italic !== prevItalic) out += dummyState.italic ? "<i>" : "</i>";
      if (dummyState.underline !== prevUnderline) out += dummyState.underline ? "<u>" : "</u>";
      if (dummyState.strike !== prevStrike) out += dummyState.strike ? "<s>" : "</s>";
      if (dummyState.color !== prevColor && dummyState.color) out += `<font color="${dummyState.color}">`;
    }
    return out;
  });
  alignOverride = assMeta.align;
  posOverride = assMeta.pos;

  // Strip dangerous script/style elements outright and normalize <br>.
  cleaned = cleaned
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");

  interface StackFrame {
    tag: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    color?: string;
  }

  const stack: StackFrame[] = [];
  const rawSpans: CueSpan[] = [];
  const tagRx = /<(\/?)([a-zA-Z][a-zA-Z0-9._-]*)([^>]*)>|<\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3}>/g;
  let lastIdx = 0;

  const currentStyle = () => {
    let bold = false;
    let italic = false;
    let underline = false;
    let strike = false;
    let color: string | undefined;
    for (const f of stack) {
      if (f.bold) bold = true;
      if (f.italic) italic = true;
      if (f.underline) underline = true;
      if (f.strike) strike = true;
      if (f.color) color = f.color;
    }
    return { bold, italic, underline, strike, color };
  };

  let m: RegExpExecArray | null;
  while ((m = tagRx.exec(cleaned)) !== null) {
    if (m.index > lastIdx) {
      const txt = decodeHtmlEntities(cleaned.slice(lastIdx, m.index));
      if (txt) rawSpans.push({ text: txt, ...currentStyle() });
    }
    lastIdx = tagRx.lastIndex;

    // Timestamp karaoke tag (<00:01:02.000>)
    if (!m[2]) continue;

    const closing = m[1] === "/";
    const rawTag = m[2];
    const attrs = m[3] ?? "";
    const parts = rawTag.toLowerCase().split(".");
    const baseTag = parts[0];

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === baseTag) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    if (baseTag === "b") stack.push({ tag: "b", bold: true });
    else if (baseTag === "i") stack.push({ tag: "i", italic: true });
    else if (baseTag === "u") stack.push({ tag: "u", underline: true });
    else if (baseTag === "s" || baseTag === "strike" || baseTag === "del") stack.push({ tag: baseTag, strike: true });
    else if (baseTag === "font") {
      const cm = attrs.match(/\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const color = sanitizeCssColor(cm?.[1] ?? cm?.[2] ?? cm?.[3]);
      stack.push({ tag: "font", ...(color ? { color } : {}) });
    } else if (baseTag === "c") {
      const colorClass = parts.slice(1).map((p) => sanitizeCssColor(p)).find(Boolean);
      stack.push({ tag: "c", ...(colorClass ? { color: colorClass } : {}) });
    }
    // Other tags (v, lang, ruby, rt, or unrecognized HTML tags like <img>) are stripped cleanly.
  }

  if (lastIdx < cleaned.length) {
    const txt = decodeHtmlEntities(cleaned.slice(lastIdx));
    if (txt) rawSpans.push({ text: txt, ...currentStyle() });
  }

  return { spans: coalesceSpans(rawSpans), alignOverride, posOverride };
}

function parseVttCueSettings(settingsStr: string): { align: CueAlign; pos?: { xPct: number; yPct: number } } {
  let col = 1; // 0=left, 1=center, 2=right
  let row = 0; // 0=bottom (1..3), 1=middle (4..6), 2=top (7..9)
  let xPct: number | undefined;
  let yPct: number | undefined;

  for (const part of settingsStr.trim().split(/\s+/)) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon).toLowerCase();
    const val = part.slice(colon + 1).toLowerCase();

    if (key === "align") {
      if (val === "start" || val === "left") col = 0;
      else if (val === "end" || val === "right") col = 2;
      else col = 1;
    } else if (key === "position") {
      const numMatch = val.match(/^(\d+(?:\.\d+)?)%/);
      if (numMatch) xPct = clamp(Number(numMatch[1]), 0, 100);
    } else if (key === "line") {
      const head = val.split(",")[0];
      const pctMatch = head.match(/^(\d+(?:\.\d+)?)%$/);
      if (pctMatch) {
        const pct = clamp(Number(pctMatch[1]), 0, 100);
        yPct = pct;
        row = pct < 33.34 ? 2 : pct <= 66.66 ? 1 : 0;
      } else if (/^\d+$/.test(head)) {
        const lineNum = Number(head);
        if (lineNum >= 0 && lineNum < 5) row = 2;
      }
    }
  }

  const align = toCueAlign(row * 3 + col + 1);
  if (xPct !== undefined || yPct !== undefined) {
    return {
      align,
      pos: {
        xPct: xPct ?? (col === 0 ? 15 : col === 2 ? 85 : 50),
        yPct: yPct ?? (row === 2 ? 10 : row === 1 ? 50 : 90),
      },
    };
  }
  return { align };
}

const TIMING_LINE_RX = /^((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})(.*)$/;

function parseVttOrSrtSubtitles(normalized: string, format: "vtt" | "srt"): SubtitleCue[] {
  const lines = normalized.split("\n");
  const cues: SubtitleCue[] = [];
  let i = 0;

  if (format === "vtt" && /^WEBVTT(?:\s|$|-)/i.test(lines[0]?.trim() ?? "")) {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "") i++;
  }

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Skip WebVTT NOTE / STYLE / REGION blocks.
    if (format === "vtt" && /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(trimmed)) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    let cueId: string | undefined;
    let timingMatch = trimmed.match(TIMING_LINE_RX);
    if (!timingMatch && !trimmed.includes("-->") && i + 1 < lines.length) {
      const nextMatch = lines[i + 1].trim().match(TIMING_LINE_RX);
      if (nextMatch) {
        cueId = trimmed;
        i++;
        timingMatch = nextMatch;
      }
    }

    if (!timingMatch) {
      i++;
      continue;
    }

    const start = parseTimestamp(timingMatch[1]);
    const end = parseTimestamp(timingMatch[2]);
    const settingsStr = timingMatch[3] ?? "";
    i++;

    const payloadLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === "") break;
      // Defensive recovery when an SRT omits blank lines between consecutive cues.
      if (TIMING_LINE_RX.test(cur.trim())) break;
      if (/^\d+$/.test(cur.trim()) && i + 1 < lines.length && TIMING_LINE_RX.test(lines[i + 1].trim())) break;
      payloadLines.push(cur);
      i++;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const rawPayload = payloadLines.join("\n").trim();
    if (!rawPayload) continue;

    const { align: vttAlign, pos: vttPos } = parseVttCueSettings(settingsStr);
    const { spans, alignOverride, posOverride } = parseVttInlineText(rawPayload);
    const text = spans.map((s) => s.text).join("");
    if (!text.trim()) continue;

    const pos = posOverride ?? vttPos;
    cues.push({
      id: cueId || `${format}-${cues.length + 1}`,
      start,
      end,
      text,
      spans,
      align: alignOverride ?? vttAlign,
      ...(pos ? { pos } : {}),
    });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/* ----------------------------------------------------- VTT serialization */

function formatVttTimestamp(sec: number): string {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const ms = msTotal % 1000;
  const sTotal = Math.floor(msTotal / 1000);
  const s = sTotal % 60;
  const mTotal = Math.floor(sTotal / 60);
  const m = mTotal % 60;
  const h = Math.floor(mTotal / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function escapeVttText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeCueSpans(spans: CueSpan[]): string {
  return spans
    .map((s) => {
      let out = escapeVttText(s.text);
      if (s.bold) out = `<b>${out}</b>`;
      if (s.italic) out = `<i>${out}</i>`;
      if (s.underline) out = `<u>${out}</u>`;
      return out;
    })
    .join("");
}

/** Serialize structured cues back into standard WebVTT. */
export function cuesToVtt(cues: SubtitleCue[]): string {
  if (!cues.length) return "WEBVTT\n\n";
  const blocks = cues.map((cue, idx) => {
    const settings: string[] = [];
    const col = (cue.align - 1) % 3;
    const row = Math.floor((cue.align - 1) / 3);
    if (col === 0) settings.push("align:start");
    else if (col === 2) settings.push("align:end");
    if (cue.pos) {
      settings.push(`position:${Math.round(cue.pos.xPct)}%`);
      settings.push(`line:${Math.round(cue.pos.yPct)}%`);
    } else if (row === 2) {
      settings.push("line:8%");
    } else if (row === 1) {
      settings.push("line:50%");
    }
    const header = `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}${settings.length ? " " + settings.join(" ") : ""}`;
    const body = cue.spans.length ? serializeCueSpans(cue.spans) : escapeVttText(cue.text);
    return `${idx + 1}\n${header}\n${body}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/** SRT, ASS/SSA, or already-VTT text to WebVTT the browser can render. */
export function toVtt(text: string): string {
  const t = normalizeRaw(text);
  const trimmed = t.trimStart();
  if (/^WEBVTT/.test(trimmed)) return t;
  if (detectSubtitleFormat(t) === "ass") {
    return cuesToVtt(parseAssSubtitles(t));
  }
  const body = t
    // 00:00:01,000 --> 00:00:02,000  becomes  00:00:01.000 --> 00:00:02.000
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2")
    // ASS-style override tags some SRTs carry, e.g. {\an8}
    .replace(/\{\\[^}]*\}/g, "")
    // <font ...> isn't WebVTT; keep the text.
    .replace(/<\/?font[^>]*>/gi, "");
  return `WEBVTT\n\n${body.trim()}\n`;
}

/** Parse SRT, WebVTT, or ASS/SSA subtitle text into structured cues + WebVTT output. */
export function parseSubtitles(raw: string, formatHint?: string): ParsedSubtitles {
  const normalized = normalizeRaw(raw);
  const format = detectSubtitleFormat(normalized, formatHint);
  const cues =
    format === "ass"
      ? parseAssSubtitles(normalized)
      : parseVttOrSrtSubtitles(normalized, format);
  const vtt = format === "vtt" && /^WEBVTT(?:\s|$|-)/i.test(normalized.trimStart()) ? normalized : toVtt(normalized);
  return { format, cues, vtt };
}

/* ----------------------------------------------------- active cue lookup */

interface CueIndexMeta {
  length: number;
  sorted: boolean;
  maxEnd: number[];
}

const cueIndexCache = new WeakMap<readonly SubtitleCue[], CueIndexMeta>();

function getCueIndexMeta(cues: readonly SubtitleCue[]): CueIndexMeta {
  const cached = cueIndexCache.get(cues);
  if (cached && cached.length === cues.length) return cached;

  const maxEnd = new Array<number>(cues.length);
  let sorted = true;
  let runningMax = -Infinity;
  let prevStart = -Infinity;

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.start < prevStart) sorted = false;
    prevStart = c.start;
    runningMax = Math.max(runningMax, c.end);
    maxEnd[i] = runningMax;
  }

  const meta: CueIndexMeta = { length: cues.length, sorted, maxEnd };
  cueIndexCache.set(cues, meta);
  return meta;
}

/**
 * Return all cues active at `timeSec` with optional sync `offsetSec`.
 * Displayed interval is `[cue.start + offsetSec, cue.end + offsetSec)`,
 * so `+0.5` makes subtitles appear 0.5s later.
 */
export function activeCuesAt(cues: readonly SubtitleCue[], timeSec: number, offsetSec = 0): SubtitleCue[] {
  if (!cues.length || !Number.isFinite(timeSec)) return [];
  const t = timeSec - (Number.isFinite(offsetSec) ? offsetSec : 0);
  const meta = getCueIndexMeta(cues);

  if (!meta.sorted) {
    return cues.filter((c) => c.start <= t && t < c.end);
  }

  // Binary search upper bound: largest index i with cues[i].start <= t.
  let lo = 0;
  let hi = cues.length - 1;
  let rightMost = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].start <= t) {
      rightMost = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (rightMost < 0) return [];

  const matched: SubtitleCue[] = [];
  for (let i = rightMost; i >= 0; i--) {
    if (meta.maxEnd[i] <= t) break;
    if (cues[i].end > t) matched.push(cues[i]);
  }
  matched.reverse();
  return matched;
}

/* ------------------------------------------- smart matching & track memory */

function isForcedTrack(t: MatchableSubtitleTrack): boolean {
  return Boolean(t.isForced) || /\b(forced|signs?(?:\s*(?:&|and)\s*songs?)?|songs?)\b/i.test(t.label ?? "");
}

function isHearingImpairedTrack(t: MatchableSubtitleTrack): boolean {
  return Boolean(t.isHearingImpaired) || /\b(sdh|cc|hi|hearing[\s_-]?impaired)\b/i.test(t.label ?? "");
}

/** Decide whether subtitles should auto-enable based on user mode, anime audio, and original language. */
export function shouldAutoEnableSubtitles(
  pref: Pick<SubPref, "mode" | "on" | "lang">,
  audio?: "sub" | "dub",
  originalLang?: string,
): boolean {
  if (pref.mode === "on" || (pref.mode !== "off" && pref.on === true)) return true;
  if (pref.mode === "off" || pref.on === false) return false;
  if (audio === "sub") return true;
  if (originalLang) {
    const orig = langBase(originalLang);
    const want = langBase(pref.lang || "en");
    if (orig !== "und" && want !== "und" && orig !== want) return true;
  }
  return false;
}

function scoreTrack(
  track: MatchableSubtitleTrack,
  wantExact: string,
  wantBase: string,
  hiPref: SubHIFilter,
  allowNonWantFallback: boolean,
): number {
  const trackExact = normalizeSubLang(track.lang);
  const trackBase = langBase(track.lang);

  let score = 0;
  if (wantBase !== "und" && trackExact === wantExact) score += 200;
  else if (wantBase !== "und" && trackBase === wantBase) score += 160;
  else if (allowNonWantFallback && trackBase === "en") score += 80;
  else if (allowNonWantFallback) score += 20;
  else return -Infinity;

  if (!isForcedTrack(track)) score += 30;

  const isHI = isHearingImpairedTrack(track);
  if (hiPref === "prefer") score += isHI ? 25 : 0;
  else if (hiPref === "avoid") score += isHI ? -35 : 10;

  const fmt = (track.format ?? "").toLowerCase();
  if (fmt === "ass" || fmt === "ssa") score += 12;
  else if (fmt === "vtt") score += 4;
  else if (fmt === "srt") score += 2;

  if (track.source === "user") score += 8;
  else if (track.source === "sidecar") score += 6;
  else if (track.source === "embedded") score += 4;

  if (track.isDefault) score += 5;
  return score;
}

/**
 * Pick the best subtitle track index matching `pref` (language, SDH filter, non-forced, format).
 * When `excludeIndex` is passed (e.g. choosing a dual-sub secondary track), only tracks matching
 * the requested language are considered, returning `-1` if none match.
 */
export function pickBestSubtitleIndex(
  tracks: MatchableSubtitleTrack[],
  pref: Partial<SubPref>,
  _originalLang?: string,
  excludeIndex?: number,
): number {
  if (!tracks.length) return -1;
  const wantExact = normalizeSubLang(pref.lang ?? (excludeIndex != null ? "" : DEFAULT_SUB_PREF.lang));
  const wantBase = langBase(wantExact);
  const hiPref = pref.preferHearingImpaired ?? DEFAULT_SUB_PREF.preferHearingImpaired;
  const isSecondary = excludeIndex != null;
  if (isSecondary && wantBase === "und") return -1;

  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < tracks.length; i++) {
    if (i === excludeIndex) continue;
    const score = scoreTrack(tracks[i], wantExact, wantBase, hiPref, !isSecondary);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const SUB_MEM_KEY = "abx.submem.v1";
const MAX_SUB_MEM = 120;

function readMemoryMap(): Map<string, SubTrackMemoryEntry> {
  const map = new Map<string, SubTrackMemoryEntry>();
  try {
    const raw = localStorage.getItem(SUB_MEM_KEY);
    if (!raw) return map;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (k && v && typeof v === "object") {
          map.set(k, v as SubTrackMemoryEntry);
        }
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return map;
}

function writeMemoryMap(map: Map<string, SubTrackMemoryEntry>) {
  while (map.size > MAX_SUB_MEM) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  try {
    localStorage.setItem(SUB_MEM_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* storage blocked or full */
  }
}

export function loadSubTrackMemory(mediaKey: string): SubTrackMemoryEntry | null {
  if (!mediaKey) return null;
  const entry = readMemoryMap().get(mediaKey);
  return entry ? { ...entry } : null;
}

export function saveSubTrackMemory(mediaKey: string, entry: SubTrackMemoryEntry): SubTrackMemoryEntry {
  if (!mediaKey) return entry;
  const map = readMemoryMap();
  const prev = map.get(mediaKey) ?? {};
  const next: SubTrackMemoryEntry = {
    ...prev,
    ...entry,
    updatedAt: Date.now(),
  };
  if (next.offsetSec !== undefined && !Number.isFinite(next.offsetSec)) {
    next.offsetSec = prev.offsetSec ?? 0;
  }
  // Delete and re-insert to keep LRU order (oldest first, newest last).
  map.delete(mediaKey);
  map.set(mediaKey, next);
  writeMemoryMap(map);
  return next;
}

/** Fetch a subtitle file and return a same-origin blob URL of it as WebVTT. */
export async function loadSubtitle(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const vtt = toVtt(decodeSubtitle(await res.arrayBuffer()));
  return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
}
