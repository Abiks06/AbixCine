import type { Settings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import type { StreamHeaders } from "./native";

export type StreamKind = "hls" | "dash" | "file" | "embed";

export interface ManifestValidation {
  ok: boolean;
  kind?: "hls" | "dash";
  quality?: number;
  hasVariants?: boolean;
  segmentCount?: number;
  error?: string;
}

export interface HedgedProbeOptions {
  /** Max concurrent probes per batch (default 3). */
  concurrency?: number;
  /** Ms before launching hedged backup probes when initial batch is slow (default 2500). */
  hedgeDelayMs?: number;
  /** Stop and cancel losing probes once this many valid streams win (default 1). */
  maxWinners?: number;
  signal?: AbortSignal;
  onCandidate?: (c: StreamCandidate) => void;
}

export interface VideoSource {
  id: string;
  name: string;
  isFrench: boolean;
  urls: {
    movie: string;
    tv: string;
    /**
     * Anime by AniList/MAL id with a real sub/dub switch. Placeholders: {anilist}, {mal},
     * {episode}, {audio} ("sub" | "dub"), {dub} ("true" | "false").
     */
    anime?: string;
  };
  /** Default Referer / Origin / User-Agent headers expected by this server's CDN. */
  headers?: StreamHeaders;
  /** Query parameter the player reads as "start at N seconds", so resume and sub/dub flips keep the spot. */
  startParam?: string;
  /** Set false for players whose stream can't be captured (they then only run as a web player). */
  sniff?: boolean;
  /** Often offline: off unless switched on in Settings → Servers → Extra servers. */
  extra?: boolean;
}

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";

export type SubtitleSource = "embedded" | "sidecar" | "stream" | "online" | "user";

export interface SubtitleTrack {
  /** BCP 47 / ISO 639 code when known ("en", "eng", "ja"). */
  lang: string;
  label: string;
  /** WebVTT, SRT, ASS, or SSA (or "embedded://<index>" for local container tracks). */
  url: string;
  format?: SubtitleFormat;
  isDefault?: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  source?: SubtitleSource;
  streamIndex?: number;
}

export interface EmbeddedSubtitle {
  index: number;
  codec: string;
  lang: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isText: boolean;
}

export interface InferredSubtitleMeta {
  lang: string;
  label: string;
  format?: SubtitleFormat;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
}

const SUB_LANG_ENTRIES: [string, [string, string]][] = [
  ["en", ["en", "English"]],
  ["eng", ["en", "English"]],
  ["english", ["en", "English"]],
  ["en-us", ["en-us", "English (US)"]],
  ["en-gb", ["en-gb", "English (UK)"]],
  ["en-au", ["en-au", "English (AU)"]],
  ["en-ca", ["en-ca", "English (CA)"]],
  ["ja", ["ja", "Japanese"]],
  ["jp", ["ja", "Japanese"]],
  ["jpn", ["ja", "Japanese"]],
  ["japanese", ["ja", "Japanese"]],
  ["fr", ["fr", "French"]],
  ["fre", ["fr", "French"]],
  ["fra", ["fr", "French"]],
  ["french", ["fr", "French"]],
  ["francais", ["fr", "French"]],
  ["français", ["fr", "French"]],
  ["fr-ca", ["fr-ca", "French (Canada)"]],
  ["fr-fr", ["fr-fr", "French"]],
  ["es", ["es", "Spanish"]],
  ["spa", ["es", "Spanish"]],
  ["spanish", ["es", "Spanish"]],
  ["espanol", ["es", "Spanish"]],
  ["español", ["es", "Spanish"]],
  ["castellano", ["es", "Spanish"]],
  ["es-es", ["es-es", "Spanish (Spain)"]],
  ["es-419", ["es-419", "Spanish (Latin America)"]],
  ["es-la", ["es-419", "Spanish (Latin America)"]],
  ["lat", ["es-419", "Spanish (Latin America)"]],
  ["latino", ["es-419", "Spanish (Latin America)"]],
  ["de", ["de", "German"]],
  ["ger", ["de", "German"]],
  ["deu", ["de", "German"]],
  ["german", ["de", "German"]],
  ["deutsch", ["de", "German"]],
  ["pt", ["pt", "Portuguese"]],
  ["por", ["pt", "Portuguese"]],
  ["portuguese", ["pt", "Portuguese"]],
  ["portugues", ["pt", "Portuguese"]],
  ["português", ["pt", "Portuguese"]],
  ["pt-pt", ["pt-pt", "Portuguese (Portugal)"]],
  ["pt-br", ["pt-br", "Portuguese (Brazil)"]],
  ["pob", ["pt-br", "Portuguese (Brazil)"]],
  ["pb", ["pt-br", "Portuguese (Brazil)"]],
  ["brazilian", ["pt-br", "Portuguese (Brazil)"]],
  ["it", ["it", "Italian"]],
  ["ita", ["it", "Italian"]],
  ["italian", ["it", "Italian"]],
  ["italiano", ["it", "Italian"]],
  ["ar", ["ar", "Arabic"]],
  ["ara", ["ar", "Arabic"]],
  ["arabic", ["ar", "Arabic"]],
  ["zh", ["zh", "Chinese"]],
  ["chi", ["zh", "Chinese"]],
  ["zho", ["zh", "Chinese"]],
  ["chinese", ["zh", "Chinese"]],
  ["zh-cn", ["zh-cn", "Chinese (Simplified)"]],
  ["zh-hans", ["zh-cn", "Chinese (Simplified)"]],
  ["zh-sg", ["zh-cn", "Chinese (Simplified)"]],
  ["chs", ["zh-cn", "Chinese (Simplified)"]],
  ["zh-tw", ["zh-tw", "Chinese (Traditional)"]],
  ["zh-hant", ["zh-tw", "Chinese (Traditional)"]],
  ["cht", ["zh-tw", "Chinese (Traditional)"]],
  ["zh-hk", ["zh-hk", "Chinese (Hong Kong)"]],
  ["ko", ["ko", "Korean"]],
  ["kor", ["ko", "Korean"]],
  ["korean", ["ko", "Korean"]],
  ["ru", ["ru", "Russian"]],
  ["rus", ["ru", "Russian"]],
  ["russian", ["ru", "Russian"]],
  ["hin", ["hi", "Hindi"]],
  ["hindi", ["hi", "Hindi"]],
  ["tr", ["tr", "Turkish"]],
  ["tur", ["tr", "Turkish"]],
  ["turkish", ["tr", "Turkish"]],
  ["pl", ["pl", "Polish"]],
  ["pol", ["pl", "Polish"]],
  ["polish", ["pl", "Polish"]],
  ["nl", ["nl", "Dutch"]],
  ["nld", ["nl", "Dutch"]],
  ["dut", ["nl", "Dutch"]],
  ["dutch", ["nl", "Dutch"]],
  ["ind", ["id", "Indonesian"]],
  ["indonesian", ["id", "Indonesian"]],
  ["th", ["th", "Thai"]],
  ["tha", ["th", "Thai"]],
  ["thai", ["th", "Thai"]],
  ["vi", ["vi", "Vietnamese"]],
  ["vie", ["vi", "Vietnamese"]],
  ["vietnamese", ["vi", "Vietnamese"]],
  ["sv", ["sv", "Swedish"]],
  ["swe", ["sv", "Swedish"]],
  ["swedish", ["sv", "Swedish"]],
  ["ms", ["ms", "Malay"]],
  ["may", ["ms", "Malay"]],
  ["msa", ["ms", "Malay"]],
  ["malay", ["ms", "Malay"]],
  ["da", ["da", "Danish"]],
  ["dan", ["da", "Danish"]],
  ["danish", ["da", "Danish"]],
  ["fi", ["fi", "Finnish"]],
  ["fin", ["fi", "Finnish"]],
  ["finnish", ["fi", "Finnish"]],
  ["no", ["no", "Norwegian"]],
  ["nor", ["no", "Norwegian"]],
  ["nb", ["no", "Norwegian"]],
  ["nob", ["no", "Norwegian"]],
  ["nn", ["no", "Norwegian"]],
  ["nno", ["no", "Norwegian"]],
  ["norwegian", ["no", "Norwegian"]],
  ["cs", ["cs", "Czech"]],
  ["cze", ["cs", "Czech"]],
  ["ces", ["cs", "Czech"]],
  ["czech", ["cs", "Czech"]],
  ["hu", ["hu", "Hungarian"]],
  ["hun", ["hu", "Hungarian"]],
  ["hungarian", ["hu", "Hungarian"]],
  ["ro", ["ro", "Romanian"]],
  ["rum", ["ro", "Romanian"]],
  ["ron", ["ro", "Romanian"]],
  ["romanian", ["ro", "Romanian"]],
  ["el", ["el", "Greek"]],
  ["gre", ["el", "Greek"]],
  ["ell", ["el", "Greek"]],
  ["greek", ["el", "Greek"]],
  ["he", ["he", "Hebrew"]],
  ["heb", ["he", "Hebrew"]],
  ["iw", ["he", "Hebrew"]],
  ["hebrew", ["he", "Hebrew"]],
  ["uk", ["uk", "Ukrainian"]],
  ["ukr", ["uk", "Ukrainian"]],
  ["ukrainian", ["uk", "Ukrainian"]],
  ["bg", ["bg", "Bulgarian"]],
  ["bul", ["bg", "Bulgarian"]],
  ["bulgarian", ["bg", "Bulgarian"]],
  ["hr", ["hr", "Croatian"]],
  ["hrv", ["hr", "Croatian"]],
  ["croatian", ["hr", "Croatian"]],
  ["sr", ["sr", "Serbian"]],
  ["srp", ["sr", "Serbian"]],
  ["serbian", ["sr", "Serbian"]],
  ["sk", ["sk", "Slovak"]],
  ["slo", ["sk", "Slovak"]],
  ["slk", ["sk", "Slovak"]],
  ["slovak", ["sk", "Slovak"]],
  ["sl", ["sl", "Slovenian"]],
  ["slv", ["sl", "Slovenian"]],
  ["slovenian", ["sl", "Slovenian"]],
  ["fa", ["fa", "Persian"]],
  ["per", ["fa", "Persian"]],
  ["fas", ["fa", "Persian"]],
  ["persian", ["fa", "Persian"]],
  ["farsi", ["fa", "Persian"]],
  ["tl", ["tl", "Filipino"]],
  ["tgl", ["tl", "Filipino"]],
  ["fil", ["tl", "Filipino"]],
  ["filipino", ["tl", "Filipino"]],
  ["tagalog", ["tl", "Filipino"]],
  ["bn", ["bn", "Bengali"]],
  ["ben", ["bn", "Bengali"]],
  ["bengali", ["bn", "Bengali"]],
  ["ta", ["ta", "Tamil"]],
  ["tam", ["ta", "Tamil"]],
  ["tamil", ["ta", "Tamil"]],
  ["te", ["te", "Telugu"]],
  ["tel", ["te", "Telugu"]],
  ["telugu", ["te", "Telugu"]],
  ["ur", ["ur", "Urdu"]],
  ["urd", ["ur", "Urdu"]],
  ["urdu", ["ur", "Urdu"]],
  ["ca", ["ca", "Catalan"]],
  ["cat", ["ca", "Catalan"]],
  ["catalan", ["ca", "Catalan"]],
];

const SUB_LANG_MAP = new Map<string, [string, string]>(SUB_LANG_ENTRIES);

const COMPOUND_LOCALE_PAIRS = new Map<string, [string, string]>([
  ["pt-br", ["pt-br", "Portuguese (Brazil)"]],
  ["pt-pt", ["pt-pt", "Portuguese (Portugal)"]],
  ["zh-cn", ["zh-cn", "Chinese (Simplified)"]],
  ["zh-hans", ["zh-cn", "Chinese (Simplified)"]],
  ["zh-sg", ["zh-cn", "Chinese (Simplified)"]],
  ["zh-tw", ["zh-tw", "Chinese (Traditional)"]],
  ["zh-hant", ["zh-tw", "Chinese (Traditional)"]],
  ["zh-hk", ["zh-hk", "Chinese (Hong Kong)"]],
  ["es-419", ["es-419", "Spanish (Latin America)"]],
  ["es-la", ["es-419", "Spanish (Latin America)"]],
  ["es-es", ["es-es", "Spanish (Spain)"]],
  ["en-us", ["en-us", "English (US)"]],
  ["en-gb", ["en-gb", "English (UK)"]],
  ["en-au", ["en-au", "English (AU)"]],
  ["en-ca", ["en-ca", "English (CA)"]],
  ["fr-ca", ["fr-ca", "French (Canada)"]],
  ["fr-fr", ["fr-fr", "French"]],
]);

function unwrapProxyTarget(raw: string): string {
  if (!/^(?:https?:\/\/abxs\.localhost|abxs:\/\/localhost)\/p\?/i.test(raw)) return raw;
  try {
    const qs = new URL(raw.replace(/^abxs:\/\//i, "http://")).searchParams;
    const u = qs.get("u");
    if (!u) return raw;
    const pad = u.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))) || raw;
  } catch {
    return raw;
  }
}

export function codecToSubtitleFormat(codec?: string | null): SubtitleFormat | undefined {
  const c = (codec ?? "").toLowerCase().trim();
  if (c === "ass") return "ass";
  if (c === "ssa") return "ssa";
  if (c === "subrip" || c === "srt") return "srt";
  if (c === "webvtt" || c === "vtt" || c === "mov_text" || c === "text") return "vtt";
  return undefined;
}

const THUMB_KIND_RX = /thumb(?:nail)?s?|sprite|storyboard|preview/i;

/** Detect thumbnail/sprite VTT or BIF tracks so they aren't surfaced as dialogue subtitles. */
export function isThumbnailSubtitleUrl(url: string, kind?: string): boolean {
  if (kind && THUMB_KIND_RX.test(kind.trim())) return true;
  if (!url) return false;
  const target = unwrapProxyTarget(url);
  let pathAndQuery = target;
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      pathAndQuery = `${u.pathname}${u.search}${u.hash}`;
    } catch {
      /* keep raw target */
    }
  }
  if (/^(?:.*\/)?bif(?:\/|[?#]|$)|\.bif(?:[?#]|$)/i.test(pathAndQuery)) return true;
  return THUMB_KIND_RX.test(pathAndQuery) && /\.vtt(?:$|[?#&]|[^a-z0-9])/i.test(pathAndQuery);
}

function detectSubtitleFormat(target: string): SubtitleFormat | undefined {
  const clean = target.split(/[?#]/)[0];
  const ext = clean.match(/\.(srt|vtt|ass|ssa)$/i)?.[1]?.toLowerCase();
  if (ext === "srt" || ext === "vtt" || ext === "ass" || ext === "ssa") return ext;
  const qIndex = target.indexOf("?");
  if (qIndex >= 0) {
    try {
      const params = new URLSearchParams(target.slice(qIndex + 1).split("#")[0]);
      for (const k of ["format", "ext", "type", "sub_format"]) {
        const v = params.get(k)?.toLowerCase().replace(/^\./, "");
        if (v === "srt" || v === "vtt" || v === "ass" || v === "ssa") return v;
      }
      for (const k of ["file", "filename", "name"]) {
        const v = params.get(k)?.match(/\.(srt|vtt|ass|ssa)$/i)?.[1]?.toLowerCase();
        if (v === "srt" || v === "vtt" || v === "ass" || v === "ssa") return v;
      }
    } catch {
      /* ignore malformed query */
    }
  }
  return undefined;
}

function lookupLangToken(raw: string): [string, string] | undefined {
  const norm = raw.toLowerCase().trim().replace(/_/g, "-");
  if (!norm || norm === "und" || norm === "unknown" || norm === "auto") return undefined;
  return COMPOUND_LOCALE_PAIRS.get(norm) ?? SUB_LANG_MAP.get(norm);
}

function scanTokensForMeta(
  tokens: string[],
  options: { allowBareId?: boolean; wholeStemIsSingleToken?: boolean } = {},
): {
  lang?: [string, string];
  isDefault: boolean;
  isForced: boolean;
  isSigns: boolean;
  isHearingImpaired: boolean;
  hasBareHi: boolean;
  hasUpperHi: boolean;
} {
  let lang: [string, string] | undefined;
  let isDefault = false;
  let isForced = false;
  let isSigns = false;
  let isHearingImpaired = false;
  let hasBareHi = false;
  let hasUpperHi = false;

  const lower = tokens.map((t) => t.toLowerCase());
  const allUpper = tokens.length > 1 && tokens.every((t) => t === t.toUpperCase() && /[A-Z]/.test(t));

  for (let i = 0; i < lower.length; i++) {
    const t = lower[i];
    const next = lower[i + 1];
    const prev = lower[i - 1];

    // Compound locales split across adjacent delimiters (e.g. pt_br, zh-hans, es.419)
    if (next) {
      const pair = COMPOUND_LOCALE_PAIRS.get(`${t}-${next}`);
      if (pair) {
        lang ??= pair;
        i++;
        continue;
      }
      if ((t === "portuguese" || t === "portugues") && (next === "brazil" || next === "brazilian")) {
        lang ??= ["pt-br", "Portuguese (Brazil)"];
        i++;
        continue;
      }
      if (t === "chinese" && next === "simplified") {
        lang ??= ["zh-cn", "Chinese (Simplified)"];
        i++;
        continue;
      }
      if (t === "chinese" && next === "traditional") {
        lang ??= ["zh-tw", "Chinese (Traditional)"];
        i++;
        continue;
      }
      if (t === "spanish" && (next === "latin" || next === "latam" || next === "419")) {
        lang ??= ["es-419", "Spanish (Latin America)"];
        i++;
        continue;
      }
      if (t === "hearing" && next === "impaired") {
        isHearingImpaired = true;
        i++;
        continue;
      }
    }

    if (t === "default" || t === "def") {
      isDefault = true;
      continue;
    }
    if (t === "forced") {
      isForced = true;
      continue;
    }
    if (t === "signs" || t === "sign") {
      isForced = true;
      isSigns = true;
      continue;
    }
    if (t === "sdh" || t === "cc" || t === "hearing-impaired") {
      isHearingImpaired = true;
      continue;
    }
    if (t === "hi") {
      hasBareHi = true;
      if (tokens[i] === "HI" && !allUpper) hasUpperHi = true;
      continue;
    }
    if (t === "id") {
      const adjIdWord = prev && /^(?:id|sub|subs|track|video|movie|ep|episode|drama|item|file)$/.test(prev);
      const nextIsDigits = next != null && /^\d+$/.test(next);
      if ((options.allowBareId || options.wholeStemIsSingleToken) && !adjIdWord && !nextIsDigits) {
        lang ??= ["id", "Indonesian"];
      }
      continue;
    }
    if (t === "no" && next && /^subs?$/i.test(next)) continue;

    const hit = lookupLangToken(t);
    if (hit) lang ??= hit;
  }

  return { lang, isDefault, isForced, isSigns, isHearingImpaired, hasBareHi, hasUpperHi };
}

function splitSegments(raw: string): string[] {
  return raw
    .split(/[\s()[\]{}.,;_/\\]+/)
    .flatMap((seg) => (COMPOUND_LOCALE_PAIRS.has(seg.toLowerCase()) ? [seg] : seg.split("-")))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Infer subtitle language, clean display label, format, and track flags from a URL or file path
 * plus optional provider-supplied language/label hints.
 */
export function inferSubtitleMeta(urlOrPath: string, hintLang?: string, hintLabel?: string): InferredSubtitleMeta {
  const target = unwrapProxyTarget(urlOrPath ?? "");
  const format = detectSubtitleFormat(target);

  // Explicit hintLang (ISO-639-1/2/3 or BCP-47) is authoritative unless empty/und.
  let resolvedLang = hintLang ? lookupLangToken(hintLang) : undefined;
  if (!resolvedLang && hintLang?.trim().toLowerCase() === "hi") {
    resolvedLang = ["hi", "Hindi"];
  }
  const rawHintNorm = hintLang?.trim().toLowerCase();
  const explicitBcp47 =
    !resolvedLang && rawHintNorm && rawHintNorm !== "und" && rawHintNorm !== "unknown" && /^[a-z]{2,3}(?:-[a-z0-9]{2,4})?$/i.test(rawHintNorm)
      ? rawHintNorm
      : undefined;

  let isDefault = false;
  let isForced = false;
  let isSigns = false;
  let isHearingImpaired = false;
  let hasBareHi = false;
  let hasUpperHi = false;

  const mergeScan = (scan: ReturnType<typeof scanTokensForMeta>) => {
    isDefault ||= scan.isDefault;
    isForced ||= scan.isForced;
    isSigns ||= scan.isSigns;
    isHearingImpaired ||= scan.isHearingImpaired;
    hasBareHi ||= scan.hasBareHi;
    hasUpperHi ||= scan.hasUpperHi;
    resolvedLang ??= scan.lang;
  };

  if (hintLabel?.trim()) {
    mergeScan(scanTokensForMeta(splitSegments(hintLabel), { allowBareId: true }));
  }

  let pathname = target.split(/[?#]/)[0];
  let queryStr = "";
  const qPos = target.indexOf("?");
  if (qPos >= 0) queryStr = target.slice(qPos + 1).split("#")[0];
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      pathname = decodeURIComponent(u.pathname);
    } catch {
      /* fall back to raw pathname */
    }
  }

  if (queryStr) {
    try {
      const params = new URLSearchParams(queryStr);
      for (const k of ["lang", "language", "locale", "srclang"]) {
        const v = params.get(k);
        if (v) {
          const hit = v.trim().toLowerCase() === "hi" ? (["hi", "Hindi"] as [string, string]) : lookupLangToken(v);
          if (hit) resolvedLang ??= hit;
        }
      }
      for (const k of ["label", "name", "title"]) {
        const v = params.get(k);
        if (v) mergeScan(scanTokensForMeta(splitSegments(v), { allowBareId: true }));
      }
    } catch {
      /* ignore malformed query */
    }
  }

  // Inspect filename stem first (without extension), then parent folders right-to-left.
  const pathParts = pathname.split(/[\\/]/).filter(Boolean);
  const filePart = pathParts.pop() ?? "";
  const stem = filePart.replace(/\.(srt|vtt|ass|ssa)$/i, "");
  if (stem) {
    const stemTokens = splitSegments(stem);
    mergeScan(scanTokensForMeta(stemTokens, { allowBareId: true, wholeStemIsSingleToken: stemTokens.length === 1 }));
  }

  // Parent directory segments (skip numeric/ID pairs such as /id/12345/).
  for (let i = pathParts.length - 1; i >= 0; i--) {
    const seg = pathParts[i];
    const nextSeg = pathParts[i + 1];
    if (seg.toLowerCase() === "id" && nextSeg && /^\d+$/.test(nextSeg)) continue;
    const segTokens = splitSegments(seg);
    mergeScan(scanTokensForMeta(segTokens, { allowBareId: segTokens.length === 1 && !nextSeg?.match(/^\d+$/) }));
  }

  if (hasBareHi) {
    if (resolvedLang || explicitBcp47 || hasUpperHi) {
      isHearingImpaired = true;
    } else {
      resolvedLang = ["hi", "Hindi"];
    }
  }

  const lang = resolvedLang?.[0] ?? explicitBcp47 ?? "und";
  const cleanHintLabel = hintLabel?.trim() ?? "";
  const isGenericHintLabel = !cleanHintLabel || /^(?:track\s*\d+|subtitles?|captions?|und|unknown)$/i.test(cleanHintLabel);
  const hintIsOnlyCode = cleanHintLabel && lookupLangToken(cleanHintLabel)?.[0] === lang && cleanHintLabel.length <= 5;

  let label: string;
  if (!isGenericHintLabel && !hintIsOnlyCode) {
    label = cleanHintLabel;
  } else {
    const baseName = resolvedLang?.[1] ?? (explicitBcp47 ? explicitBcp47.toUpperCase() : "Subtitles");
    const suffixes: string[] = [];
    if (isSigns) suffixes.push("Signs");
    else if (isForced) suffixes.push("Forced");
    if (isHearingImpaired) suffixes.push("SDH");
    label = suffixes.length ? `${baseName} · ${suffixes.join(" · ")}` : baseName;
  }

  return {
    lang,
    label,
    ...(format ? { format } : {}),
    isDefault,
    isForced,
    isHearingImpaired,
  };
}

/** Convert captured subtitle URLs into deduplicated, thumbnail-filtered SubtitleTrack items. */
export function inferSniffedSubtitles(urls: string[], wrapUrl: (url: string) => string): SubtitleTrack[] {
  const seenUrls = new Set<string>();
  const tracks: SubtitleTrack[] = [];
  for (const raw of urls) {
    if (!raw || seenUrls.has(raw) || isThumbnailSubtitleUrl(raw)) continue;
    seenUrls.add(raw);
    const meta = inferSubtitleMeta(raw);
    tracks.push({
      lang: meta.lang,
      label: meta.label,
      url: wrapUrl(raw),
      ...(meta.format ? { format: meta.format } : {}),
      isDefault: meta.isDefault,
      isForced: meta.isForced,
      isHearingImpaired: meta.isHearingImpaired,
      source: "stream",
    });
  }
  const labelCounts = new Map<string, number>();
  for (const t of tracks) {
    const count = (labelCounts.get(t.label) ?? 0) + 1;
    labelCounts.set(t.label, count);
    if (count > 1) t.label = `${t.label} ${count}`;
  }
  return tracks;
}

/** One playable option a provider found for a request. */
export interface StreamCandidate {
  providerId: string;
  providerName: string;
  label: string;
  url: string;
  kind: StreamKind;
  /** Vertical resolution if known (from filename, manifest, or server metadata). */
  quality?: number;
  /** Absolute path for a library file; desktop playback normalizes unsupported audio codecs. */
  localPath?: string;
  subtitles?: SubtitleTrack[];
  /**
   * What audio this stream carries. "dual" means it has both and the player picks the track;
   * "unknown" is an embed that can't be told which one to play.
   */
  audio?: "sub" | "dub" | "dual" | "unknown";
  /** Embeds only: query parameter for a start time (see VideoSource.startParam). */
  startParam?: string;
  /**
   * How AbixCine plays it. "direct": a stream URL from an API; "sniffed": captured from an
   * embed page and played in AbixCine's own player; "embed": the page itself in a shielded frame.
   */
  via?: "direct" | "sniffed" | "embed";
  /** The embed page a sniffed stream came from (also the web-player fallback). */
  pageUrl?: string;
  /** Normalized Referer/Origin/User-Agent headers associated with this stream. */
  headers?: StreamHeaders;
  /** Intro/outro ranges in seconds, when the source knows them. */
  skip?: { intro?: [number, number]; outro?: [number, number] };
  /** Filled in by the ranker. */
  probe?: { ok: boolean; latencyMs: number; quality?: number; error?: string };
  /** Time this provider's lookup took in the current source race, used to rank time-to-play. */
  lookupMs?: number;
  score?: number;
  /** Short reasons the ranker liked it: "played last time", "fastest", "best quality". */
  why?: string[];
}

/**
 * A source provider. Add a new one by implementing this and registering it in registry.ts.
 * Providers must only return streams the user has the right to play (their files,
 * their media server, a licensed API).
 */
export interface SourceProvider {
  id: string;
  name: string;
  /** "local" sources are on this PC; "external" ones are servers; "embed" are web streaming embeds. */
  category: "local" | "external" | "embed";
  /** Higher wins ties. Local files beat network sources by default. */
  priority: number;
  isFrench?: boolean;
  /** Lookup timeout when the provider needs longer than the default (e.g. it captures a page itself). */
  timeoutMs?: number;
  isEnabled(s: Settings): boolean;
  find(req: PlaybackRequest, s: Settings, signal: AbortSignal): Promise<StreamCandidate[]>;
}
