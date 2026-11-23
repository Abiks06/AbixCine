/**
 * Player building blocks shared by the player component and its hooks: constants, the
 * TextTrack → SubtitleCue conversion, embed message parsing and small media helpers.
 * Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { ENHANCE_MODES, type EnhanceMode } from "../../lib/enhance";
import { classifyTextCue, langBase, parseSubtitles, type CueAlign, type SubtitleCue } from "../../lib/subtitles";
import type { Episode } from "../../lib/types";
import type { SubtitleFormat } from "../../sources/types";

/** The title being played, as the player needs it (subtitle search, media session, art). */
export interface PlayerMedia {
  key?: string;
  /** Franchise key when one anime series spans several catalog entries. */
  canonicalKey?: string;
  tmdbId?: number;
  imdbId?: string;
  malId?: number;
  anilistId?: number;
  title: string;
  logo?: string;
  overview?: string;
  year?: number;
  rating?: number;
  backdrop?: string;
  kind?: string;
}

/** What the player needs to show the episode list and move between episodes. */
export interface EpisodeNav {
  seasons?: { number: number; name: string; episodeCount: number }[];
  season?: number;
  episode: number;
  /** Absolute episode count for anime (no seasons). */
  count?: number;
  loadSeason?: (season: number) => Promise<Episode[]>;
  /** Anime: titles/stills for the whole run (merged into the numbered list). */
  loadAll?: () => Promise<Episode[]>;
  go: (season: number | undefined, episode: number) => void;
  fallbackStill?: string;
  /** "S1 · E5 · Title" of the next one, for the Up next card. */
  nextLabel?: string;
}

export interface ExtractedSubtitleResult {
  format: "ass" | "vtt";
  content: string;
  path: string;
}

export interface TrackCueCache {
  cues?: SubtitleCue[];
  raw?: string;
  format?: SubtitleFormat;
  loading?: boolean;
  error?: string;
}

export type Sheet = "servers" | "episodes" | "subtitles" | "transcript" | "audio" | "picture";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const MAX_VOL = 2; // Up to 200% pre-amp boost via Web Audio + brickwall safety limiter
export const TIME_LEFT_KEY = "abx.timeLeft";
/** Controls fade this long after the last pointer move or key press (while playing). */
export const IDLE_MS = 2800;
/** A connect or rebuffer that runs this long offers the next server instead of only spinning. */
export const SLOW_MS = 8000;
export const SHORTCUTS: [string, string][] = [
  ["Space / K", "Play or pause"],
  ["← / →", "Back or forward 5s (Shift: 30s)"],
  ["J / L", "Back or forward 10s"],
  ["0 – 9", "Jump to 0% – 90%"],
  ["↑ / ↓ · wheel", "Volume"],
  ["M", "Mute"],
  ["< / >", "Slower or faster"],
  [", / .", "Step a frame (paused)"],
  ["C · Shift+C", "Subtitles on/off · Cycle track"],
  ["[ / ]", "Subtitle timing ±0.5s (Shift: ±0.1s)"],
  ["S · E", "Servers · Episodes"],
  ["I", "Title details"],
  ["N", "Next episode"],
  ["F · double-click", "Fullscreen (F11 too)"],
  ["P", "Picture-in-picture"],
  ["?", "This list"],
  ["Esc", "Close panel, leave fullscreen, go back"],
];
/** Pointer over these keeps the controls up: they don't fade from under a resting cursor. */
export const HOLD_CHROME = ".ptop-actions, .ptop > .pbtn, .ptitle-btn, .pbot, .upnext, .skip-btn, .psheet, .perr-card, .pload-next";
export const ENHANCE_KEY = "abx.enhance.v1";
export const SUB_FILE_EXT_RX = /\.(srt|vtt|ass|ssa)$/i;
export const SUB_LANG_HINT_RX = /(?:^|[._ -])(en|eng|english|ja|jpn|japanese|fr|fra|fre|french|es|spa|spanish|de|deu|ger|german|pt|pt-br|por|portuguese|it|ita|italian|ar|ara|arabic|ko|kor|korean|zh|chi|zho|chinese|ru|rus|russian|hi|hin|tr|tur|pl|pol|nl|nld)(?:[._ -]|$)/i;

export function inferUserSubLang(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const m = stem.match(SUB_LANG_HINT_RX);
  return m ? langBase(m[1]) : "und";
}

/**
 * Converted cue lists, per text track. The cue engine runs every 60 ms while subtitles are on;
 * rebuilding (and re-parsing every styled cue of) the whole track each time cost real CPU, and the
 * fresh array also defeated activeCuesAt's index cache, which is keyed on the array itself.
 * Rebuilt only when the track's cue list actually changes (HLS appends cues as segments load).
 */
export const trackCueMemo = new WeakMap<TextTrack, { sig: string; prefix: string; cues: SubtitleCue[] }>();

export function textTrackToCues(track: TextTrack, prefix: string): { cues: SubtitleCue[]; usingActiveFallback: boolean } {
  const full = track.cues;
  const usingActiveFallback = !(full && full.length > 0);
  if (!usingActiveFallback && full) {
    const sig = `${full.length}:${full[0].startTime}:${full[full.length - 1].endTime}`;
    const hit = trackCueMemo.get(track);
    if (hit && hit.sig === sig && hit.prefix === prefix) return { cues: hit.cues, usingActiveFallback };
    const built = convertCues(full, prefix);
    trackCueMemo.set(track, { sig, prefix, cues: built });
    return { cues: built, usingActiveFallback };
  }
  const list = track.activeCues;
  if (!list || list.length === 0) return { cues: [], usingActiveFallback };
  return { cues: convertCues(list, prefix), usingActiveFallback };
}

export function convertCues(list: TextTrackCueList, prefix: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as VTTCue | (TextTrackCue & { text?: string });
    const rawText = "text" in c && typeof c.text === "string" ? c.text : "";
    const vc = c as Partial<VTTCue>;
    const horiz = vc.align === "left" || vc.align === "start" ? 0 : vc.align === "right" || vc.align === "end" ? 2 : 1;
    let vert = 0; // 0 = bottom (1..3), 3 = middle (4..6), 6 = top (7..9)
    let pos: { xPct: number; yPct: number } | undefined;
    if (typeof vc.line === "number" && Number.isFinite(vc.line)) {
      if (vc.snapToLines === false) {
        const yPct = Math.max(0, Math.min(100, vc.line));
        vert = yPct < 33.34 ? 6 : yPct <= 66.66 ? 3 : 0;
        const xPct =
          typeof vc.position === "number" && Number.isFinite(vc.position)
            ? Math.max(0, Math.min(100, vc.position))
            : undefined;
        const isStandardBottom = yPct >= 78 && (xPct === undefined || (xPct >= 40 && xPct <= 60));
        if (!isStandardBottom) {
          pos = {
            xPct: xPct ?? (horiz === 0 ? 15 : horiz === 2 ? 85 : 50),
            yPct,
          };
        }
      } else {
        if (vc.line >= 0 && vc.line <= 5) vert = 6;
        else if (vc.line > 5 && vc.line <= 10) vert = 3;
        else vert = 0;
      }
    }
    const baseAlign = (vert + horiz + 1) as CueAlign;
    const needsInline = rawText.includes("<") || rawText.includes("{\\") || rawText.includes("&");
    if (needsInline) {
      const parsed = parseSubtitles(`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${rawText}`, "vtt");
      const first = parsed.cues[0];
      const finalAlign = first && first.align !== 2 ? first.align : baseAlign;
      const finalPos = first?.pos ?? pos;
      const finalText = first?.text ?? rawText;
      const finalKind =
        first?.kind && first.kind !== "dialogue" ? first.kind : classifyTextCue(finalText, finalAlign, finalPos);
      out.push({
        id: `${prefix}-${i}-${c.startTime}-${c.endTime}`,
        start: c.startTime,
        end: c.endTime,
        text: finalText,
        spans: first?.spans ?? [{ text: rawText }],
        align: finalAlign,
        ...(finalPos ? { pos: finalPos } : {}),
        kind: finalKind,
      });
    } else {
      const finalKind = classifyTextCue(rawText, baseAlign, pos);
      out.push({
        id: `${prefix}-${i}-${c.startTime}-${c.endTime}`,
        start: c.startTime,
        end: c.endTime,
        text: rawText,
        spans: [{ text: rawText }],
        align: baseAlign,
        ...(pos ? { pos } : {}),
        kind: finalKind,
      });
    }
  }
  return out;
}

export function cueSignature(cues: readonly SubtitleCue[]): string {
  if (!cues.length) return "";
  return cues
    .map((c) => `${c.id}:${c.text}:${c.align}:${c.kind ?? ""}:${c.pos ? `${c.pos.xPct},${c.pos.yPct}` : ""}`)
    .join("|");
}

export const candKey = (c: { url: string; pageUrl?: string }): string => c.pageUrl ?? c.url;
/** Append a "start at" parameter so an embed resumes where we left off. */
export function withStart(url: string, param: string | undefined, at: number) {
  if (!param || at < 5) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(param, String(Math.floor(at)));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Embed players report progress with postMessage in a few shapes:
 * { type: "PLAYER_EVENT", data: { event, currentTime, duration } }, a JSON string with
 * { timestamp, duration }, or { event: "time", time, duration }. Read any of them.
 */
export function readEmbedMessage(raw: unknown): { time?: number; duration?: number; ended?: boolean } | null {
  let d: unknown = raw;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const obj = d as Record<string, unknown>;
  const p = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : obj;
  const ev = String(p.event ?? obj.event ?? p.type ?? "").toLowerCase();
  const num = (...v: unknown[]) => v.map(Number).find((n) => Number.isFinite(n) && n >= 0);
  const time = num(p.currentTime, p.time, p.timestamp);
  const duration = num(p.duration);
  const ended = ev === "ended" || ev === "complete";
  if (!ended && (time == null || !duration || duration < 60 || time > duration + 5)) return null;
  return { time, duration, ended };
}

export function loadEnhance(): EnhanceMode {
  try {
    const v = localStorage.getItem(ENHANCE_KEY) as EnhanceMode | null;
    return v && ENHANCE_MODES.some((m) => m.id === v) ? v : "off";
  } catch {
    return "off";
  }
}

/** End of the buffered range the playhead is in (not the last range, which may be far ahead after a seek). */
export function bufferedAhead(v: HTMLVideoElement) {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.end(i);
  return t;
}
