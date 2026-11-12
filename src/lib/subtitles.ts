/**
 * Subtitle plumbing shared by the player: fetching and decoding sidecar/server tracks,
 * SRT -> WebVTT, language matching and the viewer's remembered choice.
 */

export type CueSize = "s" | "m" | "l";

export interface SubPref {
  /** Explicit on/off; undefined means "decide from context" (on for subbed anime). */
  on?: boolean;
  /** Preferred language, two-letter where we can tell. */
  lang?: string;
  size: CueSize;
}

const KEY = "abx.subs.v1";

export function loadSubPref(): SubPref {
  try {
    return { size: "m", ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { size: "m" };
  }
}

export function saveSubPref(p: SubPref) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the choice lasts this session only */
  }
}

const THREE_TO_TWO: Record<string, string> = {
  eng: "en", jpn: "ja", fre: "fr", fra: "fr", spa: "es", ger: "de", deu: "de", por: "pt", ita: "it",
  ara: "ar", chi: "zh", zho: "zh", kor: "ko", rus: "ru", hin: "hi", tur: "tr", pol: "pl", nld: "nl", dut: "nl",
  ind: "id", tha: "th", vie: "vi", swe: "sv", may: "ms", msa: "ms",
};
const NAMES: Record<string, string> = { english: "en", japanese: "ja", french: "fr", spanish: "es", german: "de", portuguese: "pt", italian: "it" };

/** "eng", "en-US", "English" -> "en". Unknown stays as given (lowercased). */
export function langBase(lang?: string): string {
  const l = (lang ?? "").toLowerCase().trim();
  if (!l) return "und";
  const head = l.split(/[-_]/)[0];
  return THREE_TO_TWO[head] ?? NAMES[head] ?? head;
}

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

/** Decode bytes as UTF-8, falling back to Windows-1252 (common for older SRT files). */
export function decodeSubtitle(buf: ArrayBuffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

/** SRT (or already-VTT) text to WebVTT the browser can render. */
export function toVtt(text: string): string {
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(t.trimStart())) return t;
  const body = t
    // 00:00:01,000 --> 00:00:02,000  becomes  00:00:01.000 --> 00:00:02.000
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2")
    // ASS-style override tags some SRTs carry, e.g. {\an8}
    .replace(/\{\\[^}]*\}/g, "")
    // <font ...> isn't WebVTT; keep the text.
    .replace(/<\/?font[^>]*>/gi, "");
  return `WEBVTT\n\n${body.trim()}\n`;
}

/** Fetch a subtitle file and return a same-origin blob URL of it as WebVTT. */
export async function loadSubtitle(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const vtt = toVtt(decodeSubtitle(await res.arrayBuffer()));
  return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
}
