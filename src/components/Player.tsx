import type Hls from "hls.js";
import type shaka from "shaka-player";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fmtTime } from "../lib/format";
import { ENHANCE_MODES, startEnhancer, upscalerAvailable, type EnhanceMode, type Enhancer, type EnhancerStats } from "../lib/enhance";
import { fetchSkipSegments, mergeSkipRanges, type SkipSegments } from "../lib/skipSegments";
import {
  SUB_PREF_EVENT,
  activeCuesAt,
  cuesToVtt,
  decodeSubtitle,
  langBase,
  loadSubPref,
  loadSubTrackMemory,
  normalizeSubPref,
  parseSubtitles,
  pickBestSubtitleIndex,
  preferredAudioTrackIndex,
  saveSubPref,
  saveSubTrackMemory,
  shouldAutoEnableSubtitles,
  type CueAlign,
  type SubPref,
  type SubtitleCue,
} from "../lib/subtitles";
import {
  fetchAndParseSubtitle,
  searchOnlineSubtitles,
  type OnlineSubtitleResult,
} from "../lib/subtitleProviders";
import { getSettings, updateSettings, type Audio } from "../lib/settings";
import type { Episode } from "../lib/types";
import type { StreamCandidate, SubtitleFormat } from "../sources/types";
import { isUrlTokenExpired, native, proxyUrl, unwrapProxyUrl } from "../sources/native";
import type { SessionSnapshot, SourceSession } from "../sources/session";
import { SourceBoard } from "./SourceBoard";
import { AudioToggle } from "./AudioToggle";
import { Icon } from "./Icon";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { SubtitleSheet, type UnifiedSubTrack } from "./SubtitleSheet";

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

interface Props {
  /** The shared source session: the one list of servers, and where playback results are reported. */
  session: SourceSession;
  /** candKey of the stream to start from (the session's pick when omitted). */
  initialSource?: string;
  title: string;
  subtitle?: string;
  startAt?: number;
  onProgress?: (pos: number, dur: number) => void;
  onEnded?: () => void;
  onNext?: () => void;
  autoNext?: boolean;
  onBack: () => void;
  /** Re-run the source search when every candidate has died. */
  onRetry?: () => void;
  nextLabel?: string;
  audio?: Audio;
  onAudio?: (a: Audio) => void;
  originalLanguage?: string;
  episodes?: EpisodeNav;
  season?: number;
  episode?: number;
  media?: {
    key?: string;
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
  };
}

interface ExtractedSubtitleResult {
  format: "ass" | "vtt";
  content: string;
  path: string;
}

interface TrackCueCache {
  cues?: SubtitleCue[];
  raw?: string;
  format?: SubtitleFormat;
  loading?: boolean;
  error?: string;
}

type Sheet = "servers" | "episodes" | "subtitles" | "audio" | "picture";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const UP_NEXT_AT = 25; // seconds before the end
const TIME_LEFT_KEY = "abx.timeLeft";
const SHORTCUTS: [string, string][] = [
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
  ["N", "Next episode"],
  ["F · P", "Fullscreen · Picture-in-picture"],
  ["Esc", "Close panel, leave fullscreen, go back"],
];
const ENHANCE_KEY = "abx.enhance.v1";
const SUB_FILE_EXT_RX = /\.(srt|vtt|ass|ssa)$/i;
const SUB_LANG_HINT_RX = /(?:^|[._ -])(en|eng|english|ja|jpn|japanese|fr|fra|fre|french|es|spa|spanish|de|deu|ger|german|pt|pt-br|por|portuguese|it|ita|italian|ar|ara|arabic|ko|kor|korean|zh|chi|zho|chinese|ru|rus|russian|hi|hin|tr|tur|pl|pol|nl|nld)(?:[._ -]|$)/i;

function inferUserSubLang(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const m = stem.match(SUB_LANG_HINT_RX);
  return m ? langBase(m[1]) : "und";
}

function textTrackToCues(track: TextTrack, prefix: string): { cues: SubtitleCue[]; usingActiveFallback: boolean } {
  const full = track.cues;
  const usingActiveFallback = !(full && full.length > 0);
  const list = usingActiveFallback ? track.activeCues : full;
  if (!list || list.length === 0) return { cues: [], usingActiveFallback };
  const out: SubtitleCue[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as VTTCue | (TextTrackCue & { text?: string });
    const rawText = "text" in c && typeof c.text === "string" ? c.text : "";
    const vc = c as Partial<VTTCue>;
    const horiz = vc.align === "left" || vc.align === "start" ? 0 : vc.align === "right" || vc.align === "end" ? 2 : 1;
    const vert = typeof vc.line === "number" ? (vc.line >= 0 && vc.line <= 25 ? 7 : vc.line > 25 && vc.line <= 65 ? 4 : 1) : 1;
    const align = (vert + horiz) as CueAlign;
    if (rawText.includes("<")) {
      const parsed = parseSubtitles(`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${rawText}`, "vtt");
      const first = parsed.cues[0];
      out.push({
        id: `${prefix}-${i}-${c.startTime}-${c.endTime}`,
        start: c.startTime,
        end: c.endTime,
        text: first?.text ?? rawText,
        spans: first?.spans ?? [{ text: rawText }],
        align,
      });
    } else {
      out.push({
        id: `${prefix}-${i}-${c.startTime}-${c.endTime}`,
        start: c.startTime,
        end: c.endTime,
        text: rawText,
        spans: [{ text: rawText }],
        align,
      });
    }
  }
  return { cues: out, usingActiveFallback };
}

function cueSignature(cues: readonly SubtitleCue[]): string {
  if (!cues.length) return "";
  return cues.map((c) => `${c.id}:${c.text}:${c.align}`).join("|");
}

const candKey = (c: { url: string; pageUrl?: string }): string => c.pageUrl ?? c.url;
/** Append a "start at" parameter so an embed resumes where we left off. */
function withStart(url: string, param: string | undefined, at: number) {
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
function readEmbedMessage(raw: unknown): { time?: number; duration?: number; ended?: boolean } | null {
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

function loadEnhance(): EnhanceMode {
  try {
    const v = localStorage.getItem(ENHANCE_KEY) as EnhanceMode | null;
    return v && ENHANCE_MODES.some((m) => m.id === v) ? v : "off";
  } catch {
    return "off";
  }
}

export function Player({ session, initialSource, title, subtitle, startAt, onProgress, onEnded, onNext, autoNext, nextLabel, onBack, onRetry, audio, onAudio, originalLanguage, episodes, media, season, episode }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shakaRef = useRef<shaka.Player | null>(null);
  const dashHeightsRef = useRef<number[]>([]);
  const resumeAt = useRef(startAt ?? 0);
  // One list of servers, owned by the session and shared with the screens before this one.
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const candidates = snap.candidates;
  /** A server being checked because the viewer picked it. */
  const [checking, setChecking] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>(
    () => initialSource ?? (snap.pick ? candKey(snap.pick) : candidates[0] ? candKey(candidates[0]) : ""),
  );
  const [retrySeq, setRetrySeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [liveStreamId, setLiveStreamId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  // Never start silent: a saved volume of zero (or an unreadable one) comes back as full.
  const [vol, setVol] = useState(() => {
    const v = Number(localStorage.getItem("abx.vol"));
    return Number.isFinite(v) && v > 0.05 ? Math.min(1, v) : 1;
  });
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [waiting, setWaiting] = useState(true);
  const [preparingLocal, setPreparingLocal] = useState(false);
  const [preparingTorrent, setPreparingTorrent] = useState(false);
  const [idle, setIdle] = useState(false);
  const activeTorrentIdRef = useRef<number | null>(null);
  const stopActiveTorrent = useCallback(() => {
    const id = activeTorrentIdRef.current;
    if (id == null) return;
    activeTorrentIdRef.current = null;
    if (isTauri()) {
      void invoke("torrent_stop", { id }).catch(() => {});
    }
  }, []);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [levels, setLevels] = useState<{ height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [activeLevel, setActiveLevel] = useState(-1);
  const [videoHeight, setVideoHeight] = useState<number | undefined>(undefined);
  const [hover, setHover] = useState<{ x: number; t: number; w: number } | null>(null);
  /** The ±seconds badge that appears on the side you skipped towards; repeated presses add up. */
  const [bump, setBump] = useState<{ total: number; n: number } | null>(null);
  const bumpTimer = useRef<number>();
  const [timeLeft, setTimeLeft] = useState(() => localStorage.getItem(TIME_LEFT_KEY) === "1");
  const [keysOpen, setKeysOpen] = useState(false);

  const idx = useMemo(() => candidates.findIndex((c) => candKey(c) === activeId), [candidates, activeId]);
  const cur = idx >= 0 ? candidates[idx] : undefined;
  const isEmbed = cur?.kind === "embed";
  const activeKey = cur ? candKey(cur) : activeId;

  useEffect(() => {
    if (cur && candKey(cur) !== activeId) {
      setActiveId(candKey(cur));
    }
  }, [cur, activeId]);

  // Watch keeps appending late backup servers to `candidates`; read them through refs so a
  // new backup never re-runs the attach effect (which would restart the stream).
  const candsRef = useRef(candidates);
  candsRef.current = candidates;
  const curRef = useRef(cur);
  curRef.current = cur;
  const activeIdRef = useRef(activeKey);
  activeIdRef.current = activeKey;
  const videoHeightRef = useRef<number | undefined>(undefined);
  videoHeightRef.current = videoHeight;
  const attachStartRef = useRef<number>(performance.now());

  const toastTimer = useRef<number>();
  const mountedRef = useRef(true);
  const verifyCtlRef = useRef<AbortController | null>(null);
  const verifyGenRef = useRef(0);
  const refreshCtlRef = useRef<AbortController | null>(null);
  const activeSessionRef = useRef(0);
  const failedSessionRef = useRef(-1);
  const flash = (msg: string) => {
    if (!mountedRef.current) return;
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      verifyCtlRef.current?.abort();
      verifyCtlRef.current = null;
      refreshCtlRef.current?.abort();
      refreshCtlRef.current = null;
      clearTimeout(toastTimer.current);
      clearTimeout(bumpTimer.current);
    };
  }, []);

  /* ---------------------------------------------------------------- playhead */

  /** Last position an embed reported, since we can't read its <video>. */
  const embedPos = useRef({ time: 0, duration: 0 });
  const [embedClock, setEmbedClock] = useState({ time: 0, duration: 0 });
  const position = () => {
    const v = video.current;
    if (curRef.current?.kind === "embed") return embedPos.current;
    return { time: v?.currentTime ?? 0, duration: v?.duration || 0 };
  };
  /** Save the playhead now (before switching source or audio) so the next stream resumes there. */
  const saveNow = () => {
    const p = position();
    if (p.time > 1) resumeAt.current = p.time;
    if (p.duration) onProgress?.(p.time, p.duration);
  };
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  /* --------------------------------------------------------------- failover */

  const started = useRef(false);
  const stallTimer = useRef<number>();
  const clearStall = useCallback(() => clearTimeout(stallTimer.current), []);
  const reported = useRef(new Set<string>());

  // The current stream died: tell the session, and play whatever it hands back at the same spot.
  const failover = useCallback((why: string) => {
    if (!mountedRef.current) return;
    if (failedSessionRef.current === activeSessionRef.current) return;
    failedSessionRef.current = activeSessionRef.current;

    clearStall();
    saveNowRef.current();
    setPlaying(false);
    setHasStarted(false);
    started.current = false;
    setLiveStreamId(null);

    const deadId = activeIdRef.current;
    reported.current.delete(deadId);
    session.report(deadId, false, { error: why || "won't play" });

    verifyCtlRef.current?.abort();
    refreshCtlRef.current?.abort();
    refreshCtlRef.current = null;
    setChecking(null);

    const ctl = new AbortController();
    verifyCtlRef.current = ctl;
    const gen = ++verifyGenRef.current;
    setWaiting(true);
    const backupReady = session.getSnapshot().candidates.some((c) => candKey(c) !== deadId && c.probe?.ok && c.kind !== "embed");
    if (!backupReady) flash(`Checking backup servers (${why})…`);
    void session.failover(deadId, ctl.signal).then((next) => {
      if (!mountedRef.current || ctl.signal.aborted || gen !== verifyGenRef.current) return;
      if (verifyCtlRef.current === ctl) verifyCtlRef.current = null;
      if (next) {
        const nextId = candKey(next);
        activeIdRef.current = nextId;
        setActiveId(nextId);
        flash(`Switched to ${next.providerName} (${why})`);
        return;
      }
      setWaiting(false);
      flash(`Playback failed: ${why}`);
      setSheet("servers");
    });
  }, [clearStall, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // First frame from a source is the proof it plays: the session marks it ready and learns from it.
  const onPlaying = useCallback(() => {
    const c = curRef.current;
    if (!c) return;
    const key = candKey(c);
    setLiveStreamId(key);
    if (reported.current.has(key)) return;
    reported.current.add(key);
    session.report(key, true, {
      latencyMs: Math.max(1, Math.round(performance.now() - attachStartRef.current)),
      quality: video.current?.videoHeight || videoHeightRef.current,
    });
  }, [session]);

  /* -------------------------------------------------------------- subtitles */

  const [pref, setPref] = useState<SubPref>(() => loadSubPref());
  const prefRef = useRef(pref);
  prefRef.current = pref;

  const patchPref = useCallback((patch: Partial<SubPref>) => {
    const syncedPatch: Partial<SubPref> =
      patch.on !== undefined && patch.mode === undefined
        ? { ...patch, mode: patch.on ? (prefRef.current.mode === "off" ? "on" : prefRef.current.mode) : "off" }
        : patch;
    const next = normalizeSubPref({ ...prefRef.current, ...syncedPatch });
    prefRef.current = next;
    setPref(next);
    saveSubPref(next);
    updateSettings({ subtitlePref: next });
  }, []);

  useEffect(() => {
    const syncFromStorage = () => setPref(loadSubPref());
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === "abx.subs.v1") syncFromStorage();
    };
    window.addEventListener(SUB_PREF_EVENT, syncFromStorage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SUB_PREF_EVENT, syncFromStorage);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const epSeason = season ?? episodes?.season;
  const epNumber = episode ?? episodes?.episode;
  const subMemoryKey = useMemo(() => {
    const base =
      media?.key ||
      (media?.tmdbId ? `tmdb:${media.kind ?? "media"}:${media.tmdbId}` : "") ||
      (media?.imdbId ? `imdb:${media.imdbId}` : "") ||
      cur?.localPath ||
      title;
    if (!base) return "";
    return epNumber != null ? `${base}:s${epSeason ?? 0}e${epNumber}` : base;
  }, [media?.key, media?.tmdbId, media?.imdbId, media?.kind, cur?.localPath, title, epSeason, epNumber]);
  const subMemoryKeyRef = useRef(subMemoryKey);
  subMemoryKeyRef.current = subMemoryKey;

  const persistTrackMemory = useCallback((entry: {
    selectedLang?: string;
    selectedLabel?: string;
    secondaryLang?: string;
    offsetSec?: number;
    enabled?: boolean;
  }) => {
    const key = subMemoryKeyRef.current;
    if (!key) return;
    saveSubTrackMemory(key, entry);
  }, []);

  const dragDepthRef = useRef(0);
  const [dragOverSub, setDragOverSub] = useState(false);

  const activeCurUrl = cur?.url ?? "";
  const activeCurUrlRef = useRef(activeCurUrl);
  activeCurUrlRef.current = activeCurUrl;

  const [hlsReady, setHlsReady] = useState(false);
  const [hlsSubsState, setHlsSubsState] = useState<{ url: string; tracks: UnifiedSubTrack[] }>({ url: "", tracks: [] });
  const [nativeSubsState, setNativeSubsState] = useState<{ url: string; tracks: UnifiedSubTrack[] }>({ url: "", tracks: [] });
  const [onlineSubsState, setOnlineSubsState] = useState<{ url: string; tracks: UnifiedSubTrack[] }>({ url: "", tracks: [] });
  const [addedSubs, setAddedSubs] = useState<UnifiedSubTrack[]>([]);
  const [trackDataState, setTrackDataState] = useState<{ url: string; data: Record<string, TrackCueCache> }>({ url: "", data: {} });

  const hlsSubs = hlsSubsState.url === activeCurUrl ? hlsSubsState.tracks : [];
  const nativeSubs = nativeSubsState.url === activeCurUrl ? nativeSubsState.tracks : [];
  const onlineSubs = onlineSubsState.url === activeCurUrl ? onlineSubsState.tracks : [];
  const trackData = trackDataState.url === activeCurUrl ? trackDataState.data : {};

  const setHlsSubs = useCallback((tracks: UnifiedSubTrack[]) => {
    setHlsSubsState({ url: activeCurUrlRef.current, tracks });
  }, []);
  const setNativeSubs = useCallback((tracks: UnifiedSubTrack[]) => {
    const url = activeCurUrlRef.current;
    setNativeSubsState((prev) => {
      if (
        prev.url === url &&
        prev.tracks.length === tracks.length &&
        prev.tracks.every(
          (t, i) =>
            t.id === tracks[i].id &&
            t.label === tracks[i].label &&
            t.lang === tracks[i].lang &&
            t.nativeTrack === tracks[i].nativeTrack,
        )
      ) {
        return prev;
      }
      return { url, tracks };
    });
  }, []);
  const appendOnlineSub = useCallback((url: string, track: UnifiedSubTrack) => {
    setOnlineSubsState((prev) => {
      const list = prev.url === url ? prev.tracks : [];
      return list.some((t) => t.id === track.id) ? { url, tracks: list } : { url, tracks: [...list, track] };
    });
  }, []);
  const patchTrackData = useCallback((url: string, id: string, entry: TrackCueCache) => {
    setTrackDataState((prev) => ({
      url,
      data: prev.url === url ? { ...prev.data, [id]: entry } : { [id]: entry },
    }));
  }, []);

  const trackDataRef = useRef(trackData);
  trackDataRef.current = trackData;
  const trackCtlsRef = useRef(new Map<string, AbortController>());
  const sourceGenRef = useRef(0);

  const candidateSubs = useMemo<UnifiedSubTrack[]>(() => {
    const list = cur?.subtitles;
    if (!list?.length || isEmbed) return [];
    const counts = new Map<string, number>();
    return list.map((s, i) => {
      const baseLabel = s.label || s.lang || `Track ${i + 1}`;
      const n = (counts.get(baseLabel) ?? 0) + 1;
      counts.set(baseLabel, n);
      const label = n > 1 ? `${baseLabel} ${n}` : baseLabel;
      const origin: UnifiedSubTrack["origin"] =
        s.source ?? (s.streamIndex != null || s.url.startsWith("embedded://") ? "embedded" : cur?.providerId === "local" ? "sidecar" : "stream");
      return {
        id: `cand-${i}`,
        label,
        lang: s.lang || "und",
        origin,
        format: s.format,
        isDefault: s.isDefault,
        isForced: s.isForced,
        isHearingImpaired: s.isHearingImpaired,
        url: s.url,
        streamIndex: s.streamIndex,
      };
    });
  }, [cur?.url, cur?.subtitles, cur?.providerId, isEmbed]);

  const subTracks = useMemo<UnifiedSubTrack[]>(() => {
    const raw = [...hlsSubs, ...nativeSubs, ...candidateSubs, ...onlineSubs, ...addedSubs];
    return raw.map((t) => {
      const d = trackData[t.id];
      return d ? { ...t, ...d } : t;
    });
  }, [hlsSubs, nativeSubs, candidateSubs, onlineSubs, addedSubs, trackData]);
  const subTracksRef = useRef(subTracks);
  subTracksRef.current = subTracks;

  const trackStructureKey = useMemo(
    () => [...hlsSubs, ...nativeSubs, ...candidateSubs, ...onlineSubs, ...addedSubs].map((t) => t.id).join("|"),
    [hlsSubs, nativeSubs, candidateSubs, onlineSubs, addedSubs],
  );

  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const selectedSubRef = useRef<string | null>(null);
  selectedSubRef.current = selectedSub;
  const [secondarySub, setSecondarySub] = useState<string | null>(null);
  const secondarySubRef = useRef<string | null>(null);
  secondarySubRef.current = secondarySub;

  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string; lang: string }[]>([]);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(-1);
  const manualAudio = useRef(false);
  const pendingSub = useRef<string | null>(null);
  const pendingSecondary = useRef<string | null>(null);
  /** Once the viewer picks a track on this source, stop auto-choosing for them. */
  const manualSub = useRef(false);
  const manualSecondary = useRef(false);
  const lastActiveSubRef = useRef<{ prim: string; sec: string | null } | null>(null);

  const [offset, setOffset] = useState(() => (subMemoryKey ? loadSubTrackMemory(subMemoryKey)?.offsetSec ?? 0 : 0));
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const [timingShiftUnsupported, setTimingShiftUnsupported] = useState(false);
  const timingShiftUnsupportedRef = useRef(false);

  const [activePrimaryCues, setActivePrimaryCues] = useState<SubtitleCue[]>([]);
  const [activeSecondaryCues, setActiveSecondaryCues] = useState<SubtitleCue[]>([]);
  const lastSigRef = useRef({ prim: "", sec: "" });

  const [onlineResults, setOnlineResults] = useState<OnlineSubtitleResult[]>([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineSearched, setOnlineSearched] = useState(false);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [loadingOnlineId, setLoadingOnlineId] = useState<string | null>(null);
  const [loadedOnlineMap, setLoadedOnlineMap] = useState<Map<string, string>>(() => new Map());
  const searchCtlRef = useRef<AbortController | null>(null);
  const loadOnlineCtlsRef = useRef(new Set<AbortController>());
  const autoFetchedRef = useRef(new Set<string>());
  const [savingTrackId, setSavingTrackId] = useState<string | null>(null);
  const [savedTrackIds, setSavedTrackIds] = useState<Set<string>>(() => new Set());

  const ensureTrackLoaded = useCallback(async (track: UnifiedSubTrack) => {
    if (track.origin === "hls" || track.origin === "native" || track.origin === "user") return;
    if (track.cues) return;
    const existing = trackDataRef.current[track.id];
    if (existing?.cues || existing?.loading) return;
    const activeUrl = activeCurUrlRef.current;

    if (track.origin === "embedded" && track.streamIndex != null) {
      const localPath = curRef.current?.localPath;
      if (!localPath) {
        patchTrackData(activeUrl, track.id, { loading: false, error: "Local file path unavailable" });
        return;
      }
      const ctl = new AbortController();
      trackCtlsRef.current.set(track.id, ctl);
      const gen = sourceGenRef.current;
      patchTrackData(activeUrl, track.id, { loading: true, error: undefined });
      try {
        const res = await invoke<ExtractedSubtitleResult>("extract_local_subtitle", {
          path: localPath,
          streamIndex: track.streamIndex,
        });
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
        const parsed = parseSubtitles(res.content, res.format);
        patchTrackData(activeUrl, track.id, { cues: parsed.cues, raw: res.content, format: parsed.format, loading: false, error: undefined });
      } catch (e) {
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        patchTrackData(activeUrl, track.id, { loading: false, error: msg });
        if (selectedSubRef.current === track.id || secondarySubRef.current === track.id) {
          flash(`Couldn't extract subtitle: ${msg}`);
        }
      } finally {
        if (trackCtlsRef.current.get(track.id) === ctl) trackCtlsRef.current.delete(track.id);
      }
      return;
    }

    const url = track.url;
    if (!url || url.startsWith("embedded://")) return;
    const ctl = new AbortController();
    trackCtlsRef.current.set(track.id, ctl);
    const gen = sourceGenRef.current;
    patchTrackData(activeUrl, track.id, { loading: true, error: undefined });
    try {
      const parsed = await fetchAndParseSubtitle(url, { formatHint: track.format, signal: ctl.signal });
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      patchTrackData(activeUrl, track.id, { cues: parsed.cues, raw: parsed.raw, format: parsed.format, loading: false, error: undefined });
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      if (gen !== sourceGenRef.current || !mountedRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      patchTrackData(activeUrl, track.id, { loading: false, error: msg });
      if (selectedSubRef.current === track.id || secondarySubRef.current === track.id) {
        flash(`Couldn't load subtitle: ${msg}`);
      }
    } finally {
      if (trackCtlsRef.current.get(track.id) === ctl) trackCtlsRef.current.delete(track.id);
    }
  }, [patchTrackData]);

  const applySubPair = useCallback((primId: string | null, secId: string | null) => {
    const list = subTracksRef.current;
    const prim = primId ? list.find((x) => x.id === primId) : undefined;
    const safeSecId = secId && (!prim || secId !== prim.id) ? secId : null;
    const sec = safeSecId ? list.find((x) => x.id === safeSecId) : undefined;

    const finalPrim = prim ? prim.id : null;
    const finalSec = sec ? sec.id : null;
    selectedSubRef.current = finalPrim;
    secondarySubRef.current = finalSec;
    setSelectedSub(finalPrim);
    setSecondarySub(finalSec);

    const v = video.current;
    const hls = hlsRef.current;
    if (hls) {
      hls.subtitleDisplay = false;
      const activeHlsIdx =
        prim?.origin === "hls" && prim.hlsIndex != null
          ? prim.hlsIndex
          : sec?.origin === "hls" && sec.hlsIndex != null
            ? sec.hlsIndex
            : -1;
      hls.subtitleTrack = activeHlsIdx;
    }

    if (v) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        const isNativeSelected =
          (prim?.origin === "native" && prim.nativeTrack === tt) ||
          (sec?.origin === "native" && sec.nativeTrack === tt);
        if (!hls) {
          tt.mode = isNativeSelected ? "hidden" : "disabled";
        } else if (tt.mode === "showing") {
          tt.mode = "hidden";
        }
      }
    }

    if (prim) void ensureTrackLoaded(prim);
    if (sec) void ensureTrackLoaded(sec);
  }, [ensureTrackLoaded]);

  const chooseSub = useCallback((id: string | null) => {
    manualSub.current = true;
    const list = subTracksRef.current;
    const t = id ? list.find((x) => x.id === id) : undefined;
    const curSec = secondarySubRef.current;
    const nextSec = !t ? null : curSec === t.id ? null : curSec;
    if (curSec && !nextSec) manualSecondary.current = true;
    if (t) lastActiveSubRef.current = { prim: t.id, sec: nextSec };
    applySubPair(t ? t.id : null, nextSec);
    const baseLang = t ? langBase(t.lang) : undefined;
    persistTrackMemory(
      t
        ? { enabled: true, selectedLang: baseLang, selectedLabel: t.label }
        : { enabled: false },
    );
    flash(`Subtitles: ${t ? t.label : "Off"}`);
  }, [applySubPair, persistTrackMemory]);

  const chooseSecondary = useCallback((id: string | null) => {
    manualSecondary.current = true;
    const list = subTracksRef.current;
    const t = id ? list.find((x) => x.id === id) : undefined;
    if (t && t.id === selectedSubRef.current) return;
    if (selectedSubRef.current) {
      lastActiveSubRef.current = { prim: selectedSubRef.current, sec: t ? t.id : null };
    }
    applySubPair(selectedSubRef.current, t ? t.id : null);
    const baseLang = t ? langBase(t.lang) : "";
    persistTrackMemory({ secondaryLang: baseLang && baseLang !== "und" ? baseLang : "" });
    flash(t ? `Dual subtitle: ${t.label}` : "Dual subtitle off");
  }, [applySubPair, persistTrackMemory]);

  const findPreferredSub = useCallback((list: UnifiedSubTrack[], p: SubPref) => {
    if (!list.length) return undefined;
    const idx = pickBestSubtitleIndex(list, p, originalLanguage);
    return idx >= 0 ? list[idx] : list[0];
  }, [originalLanguage]);

  const findSecondaryForLang = useCallback((list: UnifiedSubTrack[], wantLang: string, p: SubPref, primaryId: string | null) => {
    const base = langBase(wantLang);
    if (!base || base === "und") return undefined;
    const matching = list.filter((t) => t.id !== primaryId && langBase(t.lang) === base);
    if (!matching.length) return undefined;
    const idx = pickBestSubtitleIndex(matching, { ...p, lang: base }, originalLanguage);
    return idx >= 0 ? matching[idx] : matching[0];
  }, [originalLanguage]);

  // Reset subtitle selection/caches whenever switching streams so auto-pick runs cleanly for the new source.
  useEffect(() => {
    sourceGenRef.current++;
    searchCtlRef.current?.abort();
    searchCtlRef.current = null;
    loadOnlineCtlsRef.current.forEach((ctl) => ctl.abort());
    loadOnlineCtlsRef.current.clear();
    trackCtlsRef.current.forEach((ctl) => ctl.abort());
    trackCtlsRef.current.clear();

    setHlsReady(false);
    setHlsSubsState({ url: activeCurUrl, tracks: [] });
    setNativeSubsState({ url: activeCurUrl, tracks: [] });
    setOnlineSubsState({ url: activeCurUrl, tracks: [] });
    setTrackDataState({ url: activeCurUrl, data: {} });
    setOnlineResults([]);
    setOnlineLoading(false);
    setOnlineSearched(false);
    setOnlineError(null);
    setLoadingOnlineId(null);
    setLoadedOnlineMap(new Map());
    setSavingTrackId(null);
    setSavedTrackIds(new Set());
    manualSub.current = false;
    manualSecondary.current = false;
    lastActiveSubRef.current = null;
    selectedSubRef.current = null;
    secondarySubRef.current = null;
    setSelectedSub(null);
    setSecondarySub(null);
    lastSigRef.current = { prim: "", sec: "" };
    setActivePrimaryCues([]);
    setActiveSecondaryCues([]);
    timingShiftUnsupportedRef.current = false;
    setTimingShiftUnsupported(false);
    const restoredOffset = subMemoryKeyRef.current ? (loadSubTrackMemory(subMemoryKeyRef.current)?.offsetSec ?? 0) : 0;
    offsetRef.current = restoredOffset;
    setOffset(restoredOffset);
  }, [activeCurUrl]);

  // Apply pending user-loaded tracks or auto-pick best primary + optional dual track when available tracks change.
  useEffect(() => {
    const list = subTracksRef.current;
    if (pendingSub.current && list.some((t) => t.id === pendingSub.current)) {
      const id = pendingSub.current;
      pendingSub.current = null;
      chooseSub(id);
      return;
    }
    if (pendingSecondary.current && list.some((t) => t.id === pendingSecondary.current)) {
      const secId = pendingSecondary.current;
      pendingSecondary.current = null;
      chooseSecondary(secId);
      return;
    }
    if (manualSub.current) return;

    const p = prefRef.current;
    const mem = subMemoryKey ? loadSubTrackMemory(subMemoryKey) : null;
    const wantOn =
      mem?.enabled !== undefined
        ? mem.enabled
        : shouldAutoEnableSubtitles(p, audio, originalLanguage);

    if (!wantOn || !list.length) {
      applySubPair(null, null);
      return;
    }

    let prim: UnifiedSubTrack | undefined;
    if (mem?.selectedLabel) {
      prim = list.find((t) => t.label === mem.selectedLabel);
    }
    if (!prim && mem?.selectedLang && mem.selectedLang !== "und") {
      prim = list.find((t) => langBase(t.lang) === langBase(mem.selectedLang) && !t.isForced)
        ?? list.find((t) => langBase(t.lang) === langBase(mem.selectedLang));
    }
    if (!prim) {
      prim = findPreferredSub(list, p);
    }

    let sec: UnifiedSubTrack | undefined;
    if (!manualSecondary.current && prim && list.length > 1) {
      const wantSecLang = mem?.secondaryLang !== undefined ? mem.secondaryLang : p.secondaryLang;
      if (wantSecLang) {
        sec = findSecondaryForLang(list, wantSecLang, p, prim.id);
      }
    }

    applySubPair(prim?.id ?? null, sec?.id ?? null);
  }, [activeCurUrl, trackStructureKey, subMemoryKey, audio, originalLanguage, applySubPair, chooseSub, chooseSecondary, findPreferredSub, findSecondaryForLang]);

  // Reset user-dropped files when moving to another title or episode, while keeping them across server switches.
  useEffect(() => {
    setAddedSubs([]);
  }, [subMemoryKey]);

  const toggleSub = useCallback(() => {
    const list = subTracksRef.current;
    if (!list.length) {
      flash("No subtitles loaded — open Subtitles to search or drop a file");
      return;
    }
    if (selectedSubRef.current || secondarySubRef.current) {
      if (selectedSubRef.current) {
        lastActiveSubRef.current = { prim: selectedSubRef.current, sec: secondarySubRef.current };
      }
      chooseSub(null);
      return;
    }
    const last = lastActiveSubRef.current;
    if (last && list.some((t) => t.id === last.prim)) {
      manualSub.current = true;
      const sec = last.sec && list.some((t) => t.id === last.sec && t.id !== last.prim) ? last.sec : null;
      applySubPair(last.prim, sec);
      const t = list.find((x) => x.id === last.prim);
      const baseLang = t ? langBase(t.lang) : undefined;
      persistTrackMemory({ enabled: true, selectedLang: baseLang, selectedLabel: t?.label });
      flash(`Subtitles: ${t?.label ?? "On"}`);
      return;
    }
    chooseSub(findPreferredSub(list, prefRef.current)?.id ?? null);
  }, [applySubPair, chooseSub, findPreferredSub, persistTrackMemory]);

  const cycleSub = useCallback(() => {
    const list = subTracksRef.current;
    if (!list.length) {
      flash("No subtitle tracks loaded");
      return;
    }
    const curId = selectedSubRef.current;
    if (!curId) {
      chooseSub(list[0].id);
      return;
    }
    const i = list.findIndex((t) => t.id === curId);
    const next = i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
    chooseSub(next);
  }, [chooseSub]);

  const addSubtitleFiles = useCallback(async (files: FileList | File[]) => {
    const all = Array.from(files);
    const valid = all.filter((f) => SUB_FILE_EXT_RX.test(f.name));
    if (!valid.length) {
      flash("Drop an .srt, .vtt, .ass, or .ssa subtitle file");
      return;
    }
    let firstId: string | null = null;
    const loadedTracks: UnifiedSubTrack[] = [];
    for (const file of valid) {
      try {
        const buf = await file.arrayBuffer();
        const raw = decodeSubtitle(buf);
        const extMatch = file.name.match(SUB_FILE_EXT_RX);
        const hint = extMatch ? (extMatch[1].toLowerCase() as SubtitleFormat) : undefined;
        const parsed = parseSubtitles(raw, hint);
        const id = `added-${crypto.randomUUID()}`;
        const lang = inferUserSubLang(file.name);
        if (!firstId) firstId = id;
        loadedTracks.push({
          id,
          label: file.name,
          lang,
          origin: "user",
          format: hint ?? parsed.format,
          raw,
          cues: parsed.cues,
        });
      } catch (e) {
        flash(`Couldn't load ${file.name}: ${e instanceof Error ? e.message : "invalid file"}`);
      }
    }
    if (loadedTracks.length && mountedRef.current) {
      if (firstId) pendingSub.current = firstId;
      setAddedSubs((curList) => [...curList, ...loadedTracks]);
      flash(loadedTracks.length === 1 ? `Loaded subtitle: ${loadedTracks[0].label}` : `Loaded ${loadedTracks.length} subtitle files`);
    }
  }, []);

  const nudge = useCallback((delta: number) => {
    if (timingShiftUnsupportedRef.current) {
      flash("Timing offset isn't supported on active-cue-only tracks");
      return;
    }
    const n = Math.round((offsetRef.current + delta) * 10) / 10;
    offsetRef.current = n;
    setOffset(n);
    persistTrackMemory({ offsetSec: n });
    flash(`Subtitle timing ${n > 0 ? "+" : ""}${n.toFixed(1)}s`);
  }, [persistTrackMemory]);

  const resetOffset = useCallback(() => {
    if (timingShiftUnsupportedRef.current) {
      flash("Timing offset isn't supported on active-cue-only tracks");
      return;
    }
    offsetRef.current = 0;
    setOffset(0);
    persistTrackMemory({ offsetSec: 0 });
    flash("Subtitle timing reset (0.0s)");
  }, [persistTrackMemory]);

  const readOptionalSubdlApiKey = useCallback((): string | undefined => {
    try {
      const raw = getSettings().subdlApiKey;
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    } catch {
      return undefined;
    }
  }, []);

  const searchOnline = useCallback(async (rawTitle: string, lang: string) => {
    searchCtlRef.current?.abort();
    const ctl = new AbortController();
    searchCtlRef.current = ctl;
    const gen = sourceGenRef.current;

    const qTitle = (rawTitle || media?.title || title || "").trim();
    const qLang = lang || prefRef.current.lang || "en";
    const kind: "movie" | "tv" | "anime" | undefined =
      media?.kind === "tv" || media?.kind === "anime" || media?.kind === "movie"
        ? media.kind
        : epNumber != null
          ? "tv"
          : undefined;

    setOnlineLoading(true);
    setOnlineError(null);
    try {
      const results = await searchOnlineSubtitles(
        {
          tmdbId: media?.tmdbId,
          imdbId: media?.imdbId,
          title: qTitle || undefined,
          year: media?.year,
          kind,
          season: epSeason,
          episode: epNumber,
          languages: [qLang],
          preferHearingImpaired: prefRef.current.preferHearingImpaired,
          localPath: curRef.current?.localPath,
          subdlApiKey: readOptionalSubdlApiKey(),
        },
        ctl.signal,
      );
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      setOnlineResults(results);
      setOnlineSearched(true);
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      if (gen !== sourceGenRef.current || !mountedRef.current) return;
      setOnlineError(e instanceof Error ? e.message : "Failed to search online subtitles");
      setOnlineSearched(true);
    } finally {
      if (!ctl.signal.aborted && gen === sourceGenRef.current && mountedRef.current) {
        setOnlineLoading(false);
      }
    }
  }, [media?.tmdbId, media?.imdbId, media?.title, media?.year, media?.kind, title, epSeason, epNumber, readOptionalSubdlApiKey]);

  const loadOnlineResult = useCallback(async (res: OnlineSubtitleResult, asSecondary: boolean) => {
    const existingTrackId = loadedOnlineMap.get(res.id);
    if (existingTrackId && subTracksRef.current.some((t) => t.id === existingTrackId)) {
      if (asSecondary) chooseSecondary(existingTrackId);
      else chooseSub(existingTrackId);
      return;
    }

    const ctl = new AbortController();
    loadOnlineCtlsRef.current.add(ctl);
    const gen = sourceGenRef.current;
    const activeUrl = activeCurUrlRef.current;
    setLoadingOnlineId(res.id);
    try {
      const parsed = await fetchAndParseSubtitle(res.url, { formatHint: res.format, signal: ctl.signal });
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      const trackId = `online-${res.id}`;
      const label = res.release ? `${res.langName || res.lang} · ${res.release}` : (res.langName || res.lang);
      const track: UnifiedSubTrack = {
        id: trackId,
        label,
        lang: res.lang,
        origin: "online",
        format: res.format,
        url: res.url,
        provider: res.provider,
        release: res.release,
        isHearingImpaired: res.hearingImpaired,
        isForced: res.forced,
      };

      patchTrackData(activeUrl, trackId, { cues: parsed.cues, raw: parsed.raw, format: res.format ?? parsed.format, loading: false });
      setLoadedOnlineMap((prev) => {
        const next = new Map(prev);
        next.set(res.id, trackId);
        return next;
      });
      if (asSecondary) pendingSecondary.current = trackId;
      else pendingSub.current = trackId;
      appendOnlineSub(activeUrl, track);
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      if (mountedRef.current) {
        flash(`Online subtitle failed: ${e instanceof Error ? e.message : "download error"}`);
      }
    } finally {
      loadOnlineCtlsRef.current.delete(ctl);
      if (!ctl.signal.aborted && gen === sourceGenRef.current && mountedRef.current) {
        setLoadingOnlineId((curId) => (curId === res.id ? null : curId));
      }
    }
  }, [loadedOnlineMap, chooseSub, chooseSecondary, patchTrackData, appendOnlineSub]);

  const canSaveSidecar = Boolean(!isEmbed && cur?.localPath && isTauri());

  const saveSidecar = useCallback(async (track: UnifiedSubTrack) => {
    const videoPath = curRef.current?.localPath;
    if (!videoPath || savingTrackId) return;
    setSavingTrackId(track.id);
    try {
      const cached = trackDataRef.current[track.id];
      let content = cached?.raw ?? track.raw;
      let ext: SubtitleFormat | undefined = cached?.format ?? track.format;
      if (!content && (cached?.cues?.length || track.cues?.length)) {
        content = cuesToVtt(cached?.cues ?? track.cues ?? []);
        ext = "vtt";
      }
      if (!content && track.url) {
        const parsed = await fetchAndParseSubtitle(track.url, { formatHint: track.format });
        content = parsed.raw;
        ext = parsed.format;
      }
      if (!content) {
        flash("No subtitle content available to save");
        return;
      }
      const safeExt = ext === "ass" || ext === "ssa" || ext === "vtt" ? ext : "srt";
      const baseName = videoPath.split(/[\\/]/).pop() ?? "video";
      const stem =
        baseName
          .replace(/\.[^.]+$/, "")
          .replace(/[\/\\:*?"<>|\x00]/g, "_")
          .replace(/\.{2,}/g, ".") || "subtitle";
      const lang = langBase(track.lang);
      const filename = lang && lang !== "und" ? `${stem}.${lang}.${safeExt}` : `${stem}.${safeExt}`;
      await invoke<string>("save_sidecar_subtitle", {
        videoPath,
        filename,
        content,
      });
      if (!mountedRef.current) return;
      setSavedTrackIds((prev) => {
        const next = new Set(prev);
        next.add(track.id);
        return next;
      });
      flash(`Saved ${filename} next to video`);
    } catch (e) {
      if (mountedRef.current) {
        flash(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (mountedRef.current) setSavingTrackId(null);
    }
  }, [savingTrackId]);

  // Optional auto-fetch online subtitles when enabled, subtitles aren't off, and candidate lacks user's language.
  useEffect(() => {
    const mem = subMemoryKey ? loadSubTrackMemory(subMemoryKey) : null;
    if (!cur || isEmbed || !pref.autoFetchOnline) return;
    if (mem?.enabled === false || (pref.mode === "off" && mem?.enabled !== true)) return;
    if ((cur.kind === "hls" || cur.kind === "dash") && !hlsReady) return;
    const wantLang = langBase(pref.lang || "en");
    const fetchKey = `${cur.url}::${wantLang}`;
    if (autoFetchedRef.current.has(fetchKey)) return;
    if (manualSub.current) return;

    const ctl = new AbortController();
    const gen = sourceGenRef.current;
    const activeUrl = activeCurUrlRef.current;
    const timer = window.setTimeout(async () => {
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      if (manualSub.current) return;
      const list = subTracksRef.current;
      const hasMatchingLang = list.some((t) => langBase(t.lang) === wantLang && !t.isForced);
      if (hasMatchingLang) {
        autoFetchedRef.current.add(fetchKey);
        return;
      }
      const qTitle = (media?.title || title || "").trim();
      const localPath = curRef.current?.localPath;
      if (!qTitle && !media?.tmdbId && !media?.imdbId && !localPath) return;
      autoFetchedRef.current.add(fetchKey);
      const kind: "movie" | "tv" | "anime" | undefined =
        media?.kind === "tv" || media?.kind === "anime" || media?.kind === "movie"
          ? media.kind
          : epNumber != null
            ? "tv"
            : undefined;
      try {
        const results = await searchOnlineSubtitles(
          {
            tmdbId: media?.tmdbId,
            imdbId: media?.imdbId,
            title: qTitle || undefined,
            year: media?.year,
            kind,
            season: epSeason,
            episode: epNumber,
            languages: [wantLang],
            preferHearingImpaired: prefRef.current.preferHearingImpaired,
            localPath,
            subdlApiKey: readOptionalSubdlApiKey(),
          },
          ctl.signal,
        );
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current || !results.length) return;
        setOnlineResults(results);
        setOnlineSearched(true);
        const top = results[0];
        const parsed = await fetchAndParseSubtitle(top.url, { formatHint: top.format, signal: ctl.signal });
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current || manualSub.current) return;
        const trackId = `online-${top.id}`;
        const label = top.release ? `${top.langName || top.lang} · ${top.release}` : (top.langName || top.lang);
        const track: UnifiedSubTrack = {
          id: trackId,
          label,
          lang: top.lang,
          origin: "online",
          format: top.format,
          url: top.url,
          provider: top.provider,
          release: top.release,
          isHearingImpaired: top.hearingImpaired,
          isForced: top.forced,
        };
        patchTrackData(activeUrl, trackId, { cues: parsed.cues, raw: parsed.raw, format: top.format ?? parsed.format, loading: false });
        setLoadedOnlineMap((prev) => {
          const next = new Map(prev);
          next.set(top.id, trackId);
          return next;
        });
        pendingSub.current = trackId;
        appendOnlineSub(activeUrl, track);
        flash(`Auto-loaded ${top.langName || wantLang} subtitle`);
      } catch {
        /* ignore background auto-fetch errors */
      }
    }, 650);

    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [cur?.url, cur?.localPath, cur?.kind, isEmbed, hlsReady, subMemoryKey, pref.autoFetchOnline, pref.mode, pref.lang, media?.tmdbId, media?.imdbId, media?.title, media?.year, media?.kind, title, epSeason, epNumber, patchTrackData, appendOnlineSub, readOptionalSubdlApiKey]);

  const findHlsTextTrack = useCallback((v: HTMLVideoElement, track: UnifiedSubTrack, activeHlsIndex: number): TextTrack | null => {
    const vTracks = Array.from(v.textTracks).filter((t) => t.kind === "subtitles" || t.kind === "captions");
    if (!vTracks.length) return null;
    const base = langBase(track.lang);
    return (
      vTracks.find((t) => t.label === track.label && (base === "und" || langBase(t.language) === base)) ??
      vTracks.find((t) => track.hlsIndex === activeHlsIndex && (t.mode === "hidden" || t.mode === "showing")) ??
      vTracks.find((t) => t.label === track.label) ??
      (track.hlsIndex != null && vTracks.length === hlsSubs.length ? vTracks[track.hlsIndex] : null) ??
      null
    );
  }, [hlsSubs.length]);

  const evaluateCues = useCallback(() => {
    const v = video.current;
    if (!v || isEmbed) {
      if (lastSigRef.current.prim || lastSigRef.current.sec) {
        lastSigRef.current = { prim: "", sec: "" };
        setActivePrimaryCues([]);
        setActiveSecondaryCues([]);
      }
      if (timingShiftUnsupportedRef.current) {
        timingShiftUnsupportedRef.current = false;
        setTimingShiftUnsupported(false);
      }
      return;
    }

    const list = subTracksRef.current;
    const primTrack = selectedSubRef.current ? list.find((t) => t.id === selectedSubRef.current) : undefined;
    const secTrack = secondarySubRef.current ? list.find((t) => t.id === secondarySubRef.current) : undefined;
    const tSec = v.currentTime || 0;
    const offSec = offsetRef.current;
    const hls = hlsRef.current;

    const resolve = (track: UnifiedSubTrack | undefined): { cues: SubtitleCue[]; activeFallback: boolean } => {
      if (!track) return { cues: [], activeFallback: false };
      const cached = trackDataRef.current[track.id]?.cues ?? track.cues;
      if (cached) return { cues: activeCuesAt(cached, tSec, offSec), activeFallback: false };
      if (track.origin === "native" && track.nativeTrack) {
        if (track.nativeTrack.mode !== "hidden") track.nativeTrack.mode = "hidden";
        const { cues, usingActiveFallback } = textTrackToCues(track.nativeTrack, track.id);
        return { cues: usingActiveFallback ? cues : activeCuesAt(cues, tSec, offSec), activeFallback: usingActiveFallback };
      }
      if (track.origin === "hls" && hls) {
        const tt = findHlsTextTrack(v, track, hls.subtitleTrack);
        if (!tt) return { cues: [], activeFallback: false };
        if (tt.mode === "disabled" && track.hlsIndex === hls.subtitleTrack) tt.mode = "hidden";
        if (tt.mode === "showing") tt.mode = "hidden";
        const { cues, usingActiveFallback } = textTrackToCues(tt, track.id);
        return { cues: usingActiveFallback ? cues : activeCuesAt(cues, tSec, offSec), activeFallback: usingActiveFallback };
      }
      return { cues: [], activeFallback: false };
    };

    const primRes = resolve(primTrack);
    const secRes = resolve(secTrack);
    const nextPrim = primRes.cues;
    const nextSec = secRes.cues;
    const nextUnsupported = primTrack ? primRes.activeFallback : secTrack ? secRes.activeFallback : false;
    if (nextUnsupported !== timingShiftUnsupportedRef.current) {
      timingShiftUnsupportedRef.current = nextUnsupported;
      setTimingShiftUnsupported(nextUnsupported);
    }

    const primSig = cueSignature(nextPrim);
    const secSig = cueSignature(nextSec);

    if (primSig !== lastSigRef.current.prim) {
      lastSigRef.current.prim = primSig;
      setActivePrimaryCues(nextPrim);
    }
    if (secSig !== lastSigRef.current.sec) {
      lastSigRef.current.sec = secSig;
      setActiveSecondaryCues(nextSec);
    }
  }, [isEmbed, findHlsTextTrack]);
  const evaluateCuesRef = useRef(evaluateCues);
  evaluateCuesRef.current = evaluateCues;

  // Unified Cue Engine: syncs <video>.textTracks, cuechange events, seeked, and active playback cadence.
  useEffect(() => {
    const v = video.current;
    if (!v || isEmbed) return;
    let boundPrimary: TextTrack | null = null;
    let boundSecondary: TextTrack | null = null;
    const run = () => evaluateCuesRef.current();

    const syncTextTrackBindings = () => {
      const primTrack = selectedSubRef.current ? subTracksRef.current.find((t) => t.id === selectedSubRef.current) : undefined;
      const secTrack = secondarySubRef.current ? subTracksRef.current.find((t) => t.id === secondarySubRef.current) : undefined;
      const hls = hlsRef.current;

      const resolveTt = (t: UnifiedSubTrack | undefined): TextTrack | null => {
        if (!t) return null;
        if (t.origin === "native" && t.nativeTrack) return t.nativeTrack;
        if (t.origin === "hls" && hls) return findHlsTextTrack(v, t, hls.subtitleTrack);
        return null;
      };

      const nextP = resolveTt(primTrack);
      const nextS = resolveTt(secTrack);
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        const isActive = tt === nextP || tt === nextS;
        if (tt.mode === "showing") {
          tt.mode = isActive || hls ? "hidden" : "disabled";
        } else if (!hls && !isActive && tt.mode !== "disabled") {
          tt.mode = "disabled";
        } else if (!hls && isActive && tt.mode !== "hidden") {
          tt.mode = "hidden";
        }
      }
      if (nextP !== boundPrimary) {
        boundPrimary?.removeEventListener("cuechange", run);
        boundPrimary = nextP;
        boundPrimary?.addEventListener("cuechange", run);
      }
      if (nextS !== boundSecondary) {
        boundSecondary?.removeEventListener("cuechange", run);
        boundSecondary = nextS;
        boundSecondary?.addEventListener("cuechange", run);
      }
      run();
    };

    v.textTracks.addEventListener("change", syncTextTrackBindings);
    v.textTracks.addEventListener("addtrack", syncTextTrackBindings);
    v.addEventListener("timeupdate", run);
    v.addEventListener("seeked", run);
    v.addEventListener("playing", run);
    v.addEventListener("pause", run);
    syncTextTrackBindings();

    return () => {
      v.textTracks.removeEventListener("change", syncTextTrackBindings);
      v.textTracks.removeEventListener("addtrack", syncTextTrackBindings);
      v.removeEventListener("timeupdate", run);
      v.removeEventListener("seeked", run);
      v.removeEventListener("playing", run);
      v.removeEventListener("pause", run);
      boundPrimary?.removeEventListener("cuechange", run);
      boundSecondary?.removeEventListener("cuechange", run);
    };
  }, [cur?.url, isEmbed, selectedSub, secondarySub, findHlsTextTrack]);

  // High-precision 60ms cue sync while playing with an active subtitle track.
  useEffect(() => {
    if (isEmbed || !playing || (!selectedSub && !secondarySub)) return;
    evaluateCues();
    const timer = window.setInterval(evaluateCues, 60);
    return () => window.clearInterval(timer);
  }, [isEmbed, playing, selectedSub, secondarySub, evaluateCues]);

  // Re-evaluate immediately when offset, selection, or cached parsed cues change (even while paused).
  useEffect(() => {
    evaluateCues();
  }, [selectedSub, secondarySub, offset, trackData, evaluateCues]);

  // Cleanup any in-flight subtitle requests on unmount.
  useEffect(() => () => {
    sourceGenRef.current++;
    searchCtlRef.current?.abort();
    loadOnlineCtlsRef.current.forEach((c) => c.abort());
    loadOnlineCtlsRef.current.clear();
    trackCtlsRef.current.forEach((c) => c.abort());
    trackCtlsRef.current.clear();
  }, []);

  /* ----------------------------------------------------------------- audio */

  const destroyAttachedPlayers = () => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const sp = shakaRef.current;
    shakaRef.current = null;
    dashHeightsRef.current = [];
    if (sp) void sp.destroy().catch(() => {});
  };

  /** On a dual-audio stream, play the track that matches sub (Japanese) or dub (English). */
  const pickAudioTrack = () => {
    if (manualAudio.current) return;
    const hls = hlsRef.current;
    if (hls && hls.audioTracks.length > 1) {
      const i = preferredAudioTrackIndex(hls.audioTracks, audio, originalLanguage);
      if (i >= 0) {
        if (i !== hls.audioTrack) hls.audioTrack = i;
        setSelectedAudioTrack(i);
      }
      return;
    }
    const sp = shakaRef.current;
    if (sp) {
      const dashAudio = sp.getAudioTracks();
      if (dashAudio.length > 1) {
        const i = preferredAudioTrackIndex(
          dashAudio.map((t) => ({ name: t.label ?? undefined, lang: t.language })),
          audio,
          originalLanguage,
        );
        if (i >= 0 && dashAudio[i]) {
          if (!dashAudio[i].active) sp.selectAudioTrack(dashAudio[i]);
          setSelectedAudioTrack(i);
        }
      }
      return;
    }
    const tracks = (video.current as (HTMLVideoElement & { audioTracks?: ArrayLike<{ language?: string; enabled: boolean }> }) | null)?.audioTracks;
    if (tracks && tracks.length > 1) {
      const found = preferredAudioTrackIndex(Array.from(tracks, (track) => ({ lang: track.language })), audio, originalLanguage);
      if (found >= 0) {
        for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === found;
        setSelectedAudioTrack(found);
      } else {
        setSelectedAudioTrack(Array.from(tracks).findIndex((track) => track.enabled));
      }
    }
  };
  const chooseAudioTrack = (id: number) => {
    const hls = hlsRef.current;
    const sp = shakaRef.current;
    if (hls?.audioTracks[id]) {
      manualAudio.current = true;
      hls.audioTrack = id;
    } else if (sp) {
      const dashAudio = sp.getAudioTracks();
      if (!dashAudio[id]) return;
      manualAudio.current = true;
      sp.selectAudioTrack(dashAudio[id]);
    } else {
      const tracks = (video.current as (HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }) | null)?.audioTracks;
      if (!tracks?.[id]) return;
      manualAudio.current = true;
      for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === id;
    }
    setSelectedAudioTrack(id);
    flash(`Audio: ${audioTracks.find((t) => t.id === id)?.label ?? `Track ${id + 1}`}`);
  };

  // WebViews that expose embedded tracks can switch them directly; HLS tracks are handled above.
  useEffect(() => {
    const v = video.current;
    if (!v || cur?.kind !== "file") return;

    type NativeAudioTrack = { label?: string; language?: string; enabled: boolean };
    type NativeAudioTrackList = ArrayLike<NativeAudioTrack> & EventTarget;
    const nativeVideo = v as HTMLVideoElement & { audioTracks?: NativeAudioTrackList };
    let audioList: NativeAudioTrackList | undefined;

    const refreshAudio = () => {
      const next = nativeVideo.audioTracks;
      if (next !== audioList) {
        audioList?.removeEventListener("addtrack", refreshAudio);
        audioList?.removeEventListener("removetrack", refreshAudio);
        audioList?.removeEventListener("change", refreshAudio);
        audioList = next;
        audioList?.addEventListener("addtrack", refreshAudio);
        audioList?.addEventListener("removetrack", refreshAudio);
        audioList?.addEventListener("change", refreshAudio);
      }
      const tracks = Array.from(audioList ?? []);
      setAudioTracks(tracks.map((track, i) => ({
        id: i,
        label: track.label || track.language || `Track ${i + 1}`,
        lang: track.language || "und",
      })));
      const enabled = tracks.findIndex((track) => track.enabled);
      setSelectedAudioTrack(enabled);
      if (!manualAudio.current && tracks.length > 1) pickAudioTrack();
    };

    const refreshSubtitles = () => {
      if (hlsRef.current) {
        for (let i = 0; i < v.textTracks.length; i++) {
          if (v.textTracks[i].mode === "showing") v.textTracks[i].mode = "hidden";
        }
        return;
      }
      const activeCur = curRef.current;
      const hasEmbeddedCandidate =
        activeCur?.providerId === "local" &&
        Boolean(activeCur.subtitles?.some((t) => t.source === "embedded" || t.streamIndex != null || t.url.startsWith("embedded://")));
      if (hasEmbeddedCandidate) {
        for (let i = 0; i < v.textTracks.length; i++) {
          if (v.textTracks[i].mode !== "disabled") v.textTracks[i].mode = "disabled";
        }
        setNativeSubs([]);
        return;
      }
      const currentPrim = selectedSubRef.current;
      const currentSec = secondarySubRef.current;
      const tracks: UnifiedSubTrack[] = [];
      for (let i = 0; i < v.textTracks.length; i++) {
        const track = v.textTracks[i];
        if (track.kind !== "subtitles" && track.kind !== "captions") continue;
        const id = `native-sub-${i}`;
        const isSelected = id === currentPrim || id === currentSec;
        if (track.mode === "showing") {
          track.mode = isSelected ? "hidden" : "disabled";
        } else if (!isSelected && track.mode !== "disabled") {
          track.mode = "disabled";
        }
        tracks.push({
          id,
          label: track.label || track.language || `Track ${i + 1}`,
          lang: track.language || "und",
          origin: "native" as const,
          nativeTrack: track,
        });
      }
      setNativeSubs(tracks);
    };

    v.addEventListener("loadedmetadata", refreshAudio);
    v.textTracks.addEventListener("addtrack", refreshSubtitles);
    v.textTracks.addEventListener("removetrack", refreshSubtitles);
    v.textTracks.addEventListener("change", refreshSubtitles);
    refreshAudio();
    refreshSubtitles();
    return () => {
      v.removeEventListener("loadedmetadata", refreshAudio);
      v.textTracks.removeEventListener("addtrack", refreshSubtitles);
      v.textTracks.removeEventListener("removetrack", refreshSubtitles);
      v.textTracks.removeEventListener("change", refreshSubtitles);
      audioList?.removeEventListener("addtrack", refreshAudio);
      audioList?.removeEventListener("removetrack", refreshAudio);
      audioList?.removeEventListener("change", refreshAudio);
    };
  }, [cur?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------------------------------------------- watchdog */

  // A server that passed its checks can still fail to start or stall for good mid-episode.
  // Then move on to the next one at the same spot instead of spinning forever.
  const START_TIMEOUT = 20_000;
  const STALL_TIMEOUT = 15_000;
  const armStall = useCallback(() => {
    clearStall();
    const v = video.current;
    if (!v || (v.paused && started.current)) return;
    stallTimer.current = window.setTimeout(() => {
      const vv = video.current;
      // Still not playing, not paused by the viewer, and no data arriving.
      if (vv && !(vv.paused && started.current) && vv.readyState < 3) failover(started.current ? "stalled" : "didn't start");
    }, started.current ? STALL_TIMEOUT : START_TIMEOUT);
  }, [clearStall, failover]);
  const armStallRef = useRef(armStall);
  armStallRef.current = armStall;
  useEffect(() => {
    if (!cur || cur.kind === "embed" || preparingLocal || preparingTorrent) return;
    started.current = false;
    setHasStarted(false);
    armStall();
    return clearStall;
  }, [cur?.url, cur?.kind, preparingLocal, preparingTorrent, retrySeq, armStall, clearStall]);

  /* ---------------------------------------------------------- attach source */

  const lastRefreshedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    const c = curRef.current;
    if (!c) return;
    activeSessionRef.current += 1;
    attachStartRef.current = performance.now();
    started.current = false;
    setHasStarted(false);
    setPlaying(false);
    setLiveStreamId(null);
    setPreparingLocal(false);
    setPreparingTorrent(false);
    stopActiveTorrent();
    setAudioTracks([]);
    setSelectedAudioTrack(-1);
    manualAudio.current = false;
    setLevels([]);
    setLevel(-1);
    setActiveLevel(-1);
    setVideoHeight(undefined);
    setTime(0);
    setDur(0);
    destroyAttachedPlayers();
    refreshCtlRef.current?.abort();
    refreshCtlRef.current = null;
    if (c.kind === "embed") {
      setWaiting(true);
      embedPos.current = { time: resumeAt.current, duration: 0 };
      setEmbedClock({ time: 0, duration: 0 });
      return;
    }
    const v = video.current;
    if (!v) return;
    setWaiting(true);
    // Reset any previous stream immediately so the upscaler never reads stale readyState/dimensions
    // while hls.js or local media preparation loads asynchronously, and enforce anonymous CORS.
    v.pause();
    v.removeAttribute("src");
    v.crossOrigin = "anonymous";
    v.load();

    const seekAndPlay = () => {
      if (resumeAt.current > 0 && resumeAt.current < (v.duration || Infinity) - 5) v.currentTime = resumeAt.current;
      pickAudioTrack();
      v.play().catch(() => {});
    };
    let cancelled = false;
    const refreshExpiredStream = (
      target: StreamCandidate,
      fallbackMsg: string,
      httpCode: number | undefined,
      disposeCurrent: () => void,
    ) => {
      const targetId = candKey(target);
      lastRefreshedAtRef.current.set(targetId, Date.now());
      if (v.currentTime > 1) resumeAt.current = v.currentTime;
      saveNowRef.current();
      clearStall();
      setWaiting(true);
      flash(`Refreshing ${target.providerName} stream link…`);

      disposeCurrent();

      refreshCtlRef.current?.abort();
      const refreshCtl = new AbortController();
      refreshCtlRef.current = refreshCtl;

      void session
        .refresh(targetId, refreshCtl.signal)
        .then((refreshed) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          if (!refreshed?.probe?.ok) {
            failover(refreshed?.probe?.error ?? (httpCode ? `HTTP ${httpCode}` : fallbackMsg));
            return;
          }
          if (refreshed.url === target.url) {
            attachStream(refreshed);
            armStallRef.current();
          }
        })
        .catch((err: unknown) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          failover(err instanceof Error ? err.message : "stream token refresh failed");
        });
    };
    const loadFile = (url: string) => {
      if (cancelled) return;
      v.crossOrigin = "anonymous";
      v.src = url;
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    };
    const attachHls = (H: typeof Hls, streamUrl: string, target: StreamCandidate) => {
      if (cancelled) return;
      v.crossOrigin = "anonymous";
      if (!H.isSupported()) {
        v.src = streamUrl;
        v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        return;
      }
      const hls = new H({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 60,
        backBufferLength: 30,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      hlsRef.current = hls;
      hls.subtitleDisplay = false;
      let recoveries = 0;
      let midStreamRefreshing = false;
      let lastNetErrCode: number | undefined;
      hls.on(H.Events.MANIFEST_PARSED, (_, d) => {
        if (cancelled) return;
        lastNetErrCode = undefined;
        setHlsReady(true);
        setLevels(d.levels.map((l) => ({ height: l.height })));
        seekAndPlay();
      });
      hls.on(H.Events.FRAG_LOADED, () => {
        lastNetErrCode = undefined;
      });
      hls.on(H.Events.LEVEL_SWITCHED, (_, d) => {
        setActiveLevel(d.level);
      });
      hls.on(H.Events.AUDIO_TRACKS_UPDATED, (_, d) => {
        setAudioTracks((d.audioTracks ?? []).map((t, i) => ({
          id: i,
          label: t.name || t.lang || `Track ${i + 1}`,
          lang: t.lang ?? "und",
        })));
        setSelectedAudioTrack(hls.audioTrack);
        pickAudioTrack();
      });
      hls.on(H.Events.AUDIO_TRACK_SWITCHED, (_, d) => setSelectedAudioTrack(d.id));
      hls.on(H.Events.SUBTITLE_TRACKS_UPDATED, (_, d) => {
        setHlsSubs(
          (d.subtitleTracks ?? []).map((t, i) => ({
            id: `hls-${i}`,
            label: t.name || t.lang || `Track ${i + 1}`,
            lang: t.lang ?? "und",
            origin: "hls" as const,
            isDefault: Boolean(t.default),
            isForced: Boolean(t.forced),
            hlsIndex: i,
          })),
        );
      });
      hls.on(H.Events.SUBTITLE_FRAG_PROCESSED, () => {
        evaluateCuesRef.current();
      });
      hls.on(H.Events.ERROR, (_, d) => {
        if (cancelled) return;
        const netStatus =
          d.networkDetails && typeof d.networkDetails === "object" && "status" in d.networkDetails
            ? Number((d.networkDetails as { status?: number }).status)
            : undefined;
        const code = d.response?.code ?? (netStatus && Number.isFinite(netStatus) && netStatus > 0 ? netStatus : undefined);
        if (d.type === H.ErrorTypes.NETWORK_ERROR && code) {
          lastNetErrCode = code;
        }
        if (!d.fatal) return;

        // Media errors get two local repair attempts (the second also swaps the audio codec), then the next source.
        if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
          if (recoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        }

        const httpCode = code ?? (d.type === H.ErrorTypes.NETWORK_ERROR ? lastNetErrCode : undefined);
        const isAuthOrExpired =
          httpCode === 401 ||
          httpCode === 403 ||
          httpCode === 410 ||
          isUrlTokenExpired(target.url) ||
          (typeof d.url === "string" && isUrlTokenExpired(d.url));
        const targetId = candKey(target);
        const lastRefresh = lastRefreshedAtRef.current.get(targetId) ?? 0;

        if (
          d.type === H.ErrorTypes.NETWORK_ERROR &&
          isAuthOrExpired &&
          target.pageUrl &&
          !midStreamRefreshing &&
          Date.now() - lastRefresh >= 60_000
        ) {
          midStreamRefreshing = true;
          refreshExpiredStream(target, d.details, httpCode, () => {
            if (hlsRef.current === hls) hlsRef.current = null;
            hls.destroy();
          });
          return;
        }

        failover(httpCode ? `${d.details} (${httpCode})` : d.details);
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(v);
    };
    const attachDash = (shakaMod: typeof shaka, streamUrl: string, target: StreamCandidate) => {
      if (cancelled) return;
      v.crossOrigin = "anonymous";
      shakaMod.polyfill?.installAll?.();
      if (!shakaMod.Player.isBrowserSupported()) {
        failover("DASH playback is not supported in this browser");
        return;
      }
      const player = new shakaMod.Player();
      shakaRef.current = player;
      player.configure({
        streaming: {
          bufferingGoal: 60,
          rebufferingGoal: 2,
          bufferBehind: 30,
        },
        abr: { enabled: true },
        textDisplayFactory: () => new shakaMod.text.StubTextDisplayer(),
      });

      const syncDashTracks = () => {
        if (cancelled || shakaRef.current !== player) return;
        const variants = player.getVariantTracks();
        const heights = Array.from(
          new Set(variants.map((t) => t.height ?? 0).filter((h) => h > 0)),
        ).sort((a, b) => a - b);
        dashHeightsRef.current = heights;
        setLevels(heights.map((height) => ({ height })));
        const activeVar = variants.find((t) => t.active);
        setActiveLevel(activeVar?.height ? heights.indexOf(activeVar.height) : -1);

        const dashAudio = player.getAudioTracks();
        setAudioTracks(
          dashAudio.map((t, i) => ({
            id: i,
            label: t.label || t.language || `Track ${i + 1}`,
            lang: t.language || "und",
          })),
        );
        const activeAudioIdx = dashAudio.findIndex((t) => t.active);
        if (activeAudioIdx >= 0) setSelectedAudioTrack(activeAudioIdx);
      };

      player.addEventListener("trackschanged", () => {
        syncDashTracks();
        pickAudioTrack();
      });
      player.addEventListener("adaptation", () => {
        if (cancelled || shakaRef.current !== player) return;
        const activeVar = player.getVariantTracks().find((t) => t.active);
        const heights = dashHeightsRef.current;
        setActiveLevel(activeVar?.height ? heights.indexOf(activeVar.height) : -1);
      });

      let dashDead = false;
      const handleDashError = (rawErr: unknown, fromEvent: boolean) => {
        if (cancelled || dashDead) return;
        const err = rawErr as Partial<shaka.util.Error> | undefined;
        const code = typeof err?.code === "number" ? err.code : undefined;
        if (code === shakaMod.util.Error.Code.LOAD_INTERRUPTED) return;
        if (fromEvent && err?.severity !== shakaMod.util.Error.Severity.CRITICAL) return;

        const errData = Array.isArray(err?.data) ? (err.data as unknown[]) : undefined;
        const httpCode =
          code === shakaMod.util.Error.Code.BAD_HTTP_STATUS && errData && typeof errData[1] === "number"
            ? errData[1]
            : undefined;
        const errUrl = errData && typeof errData[0] === "string" ? errData[0] : undefined;
        const isAuthOrExpired =
          httpCode === 401 ||
          httpCode === 403 ||
          httpCode === 410 ||
          isUrlTokenExpired(target.url) ||
          (errUrl ? isUrlTokenExpired(errUrl) : false);
        const targetId = candKey(target);
        const lastRefresh = lastRefreshedAtRef.current.get(targetId) ?? 0;

        dashDead = true;
        if (
          isAuthOrExpired &&
          target.pageUrl &&
          Date.now() - lastRefresh >= 60_000
        ) {
          refreshExpiredStream(target, `DASH error ${code ?? "unknown"}`, httpCode, () => {
            if (shakaRef.current === player) {
              shakaRef.current = null;
              dashHeightsRef.current = [];
            }
            void player.destroy().catch(() => {});
          });
          return;
        }
        failover(httpCode ? `DASH error ${code ?? "network"} (${httpCode})` : `DASH error ${code ?? "playback"}`);
      };

      player.addEventListener("error", (ev) => {
        handleDashError((ev as Event & { detail?: unknown }).detail, true);
      });

      void (async () => {
        try {
          await player.attach(v);
          if (cancelled || shakaRef.current !== player) {
            await player.destroy().catch(() => {});
            return;
          }
          await player.load(streamUrl);
          if (cancelled || shakaRef.current !== player) return;
          setHlsReady(true);
          syncDashTracks();
          seekAndPlay();
        } catch (err: unknown) {
          handleDashError(err, false);
        }
      })();
    };
    const attachStream = (target: StreamCandidate) => {
      // hls.js (~600 kB) and shaka-player are dynamically loaded only for HLS / DASH streams.
      if (target.kind === "hls") {
        import("hls.js").then((m) => attachHls(m.default, target.url, target), () => !cancelled && failover("player failed to load"));
      } else if (target.kind === "dash") {
        const isAlreadyProxied = unwrapProxyUrl(target.url).proxied;
        const isLocalProxy = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(target.url);
        const dashUrl =
          native && !isAlreadyProxied && !isLocalProxy && /^https?:/i.test(target.url) && (target.headers || target.pageUrl)
            ? proxyUrl(target.url, target.headers, target.pageUrl)
            : target.url;
        import("shaka-player").then(
          (m) => attachDash(((m as { default?: typeof shaka }).default ?? m) as typeof shaka, dashUrl, target),
          () => !cancelled && failover("DASH player failed to load"),
        );
      } else if (/^magnet:/i.test(target.url.trim())) {
        const magnetUri = target.url.trim();
        if (!isTauri()) {
          setWaiting(false);
          failover("torrent playback requires the desktop app");
          return;
        }
        setPreparingTorrent(true);
        const rawFileIdx = (target as { fileIdx?: unknown }).fileIdx;
        const fileIdx = typeof rawFileIdx === "number" && Number.isFinite(rawFileIdx) ? rawFileIdx : null;
        void (async () => {
          try {
            const supported = await invoke<boolean>("torrent_is_supported").catch(() => false);
            if (cancelled) return;
            if (!supported) {
              setPreparingTorrent(false);
              setWaiting(false);
              failover("torrent streaming is not enabled in this build");
              return;
            }
            const info = await invoke<unknown>("torrent_start_stream", {
              magnetOrHash: magnetUri,
              fileIdx,
            });
            const rec = info && typeof info === "object" ? (info as Record<string, unknown>) : null;
            const streamId = rec && typeof rec.id === "number" && Number.isFinite(rec.id) ? rec.id : null;
            const streamUrl =
              typeof info === "string"
                ? info.trim()
                : typeof rec?.url === "string"
                  ? rec.url.trim()
                  : typeof rec?.streamUrl === "string"
                    ? rec.streamUrl.trim()
                    : typeof rec?.stream_url === "string"
                      ? rec.stream_url.trim()
                      : "";
            if (cancelled) {
              if (streamId != null) {
                void invoke("torrent_stop", { id: streamId }).catch(() => {});
              }
              return;
            }
            if (!/^https?:\/\//i.test(streamUrl)) {
              if (streamId != null) {
                void invoke("torrent_stop", { id: streamId }).catch(() => {});
              }
              setPreparingTorrent(false);
              setWaiting(false);
              failover("torrent stream returned an invalid URL");
              return;
            }
            activeTorrentIdRef.current = streamId;
            setPreparingTorrent(false);
            loadFile(streamUrl);
          } catch (error: unknown) {
            if (cancelled) return;
            setPreparingTorrent(false);
            setWaiting(false);
            failover(`torrent stream failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      } else if (target.localPath) {
        setPreparingLocal(true);
        invoke<string>("prepare_local_media", { path: target.localPath })
          .then((path) => {
            if (cancelled) return;
            setPreparingLocal(false);
            loadFile(convertFileSrc(path));
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setPreparingLocal(false);
            setWaiting(false);
            failover(`audio conversion failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      } else {
        loadFile(target.url);
      }
    };
    // Re-validate and refresh stale/expired stream URLs before playback.
    const candidateId = candKey(c);
    const lastPreRefresh = lastRefreshedAtRef.current.get(candidateId) ?? 0;
    if (c.pageUrl && isUrlTokenExpired(c.url) && Date.now() - lastPreRefresh >= 60_000) {
      lastRefreshedAtRef.current.set(candidateId, Date.now());
      const refreshCtl = new AbortController();
      refreshCtlRef.current = refreshCtl;
      // The session swaps in the fresh link, which re-runs this effect with the new URL.
      void session
        .refresh(candidateId, refreshCtl.signal)
        .then((refreshed) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          if (!refreshed?.probe?.ok) {
            failover(refreshed?.probe?.error ?? "expired stream");
            return;
          }
          if (refreshed.url === c.url) {
            attachStream(refreshed);
          }
        })
        .catch((err: unknown) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          failover(err instanceof Error ? err.message : "expired stream refresh failed");
        });
      return () => {
        cancelled = true;
        refreshCtl.abort();
        if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
        v.removeEventListener("loadedmetadata", seekAndPlay);
        if (v.currentTime > 1) resumeAt.current = v.currentTime;
        stopActiveTorrent();
        destroyAttachedPlayers();
      };
    }
    attachStream(c);
    return () => {
      cancelled = true;
      refreshCtlRef.current?.abort();
      refreshCtlRef.current = null;
      v.removeEventListener("loadedmetadata", seekAndPlay);
      if (v.currentTime > 1) resumeAt.current = v.currentTime;
      stopActiveTorrent();
      destroyAttachedPlayers();
    };
  }, [cur?.url, cur?.kind, cur?.localPath, retrySeq, failover, clearStall, stopActiveTorrent]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------------ embeds */

  // Built once per source so later playhead updates don't reload the iframe.
  const embedSrc = useMemo(
    () => (cur?.kind === "embed" ? withStart(cur.url, cur.startParam, resumeAt.current) : ""),
    [cur?.url, cur?.kind, cur?.startParam, retrySeq], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Embeds can't be watched directly, but most post their playhead to the parent window.
  useEffect(() => {
    if (!isEmbed) return;
    const onMsg = (e: MessageEvent) => {
      const m = readEmbedMessage(e.data);
      if (!m) return;
      if (m.time != null && m.duration) {
        embedPos.current = { time: m.time, duration: m.duration };
        setEmbedClock(embedPos.current);
        if (m.time > 0) {
          setWaiting(false);
          started.current = true;
          setHasStarted(true);
          setPlaying(true);
          onPlaying();
        }
      }
      if (m.ended) {
        const p = embedPos.current;
        if (p.duration) onProgress?.(p.duration, p.duration);
        onEnded?.();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [isEmbed, cur?.url, onProgress, onEnded, onPlaying]);

  /* ------------------------------------------------------------ enhancement */

  const [enhance, setEnhance] = useState<EnhanceMode>(loadEnhance);
  const [enhancing, setEnhancing] = useState<"idle" | "starting" | "on" | "error">("idle");
  const [enhError, setEnhError] = useState<string | null>(null);
  const [enhStats, setEnhStats] = useState<EnhancerStats | null>(null);
  /** Embeds get a CSS colour/contrast lift instead: their pixels are cross-origin. */
  const [vivid, setVivid] = useState(() => localStorage.getItem("abx.vivid") === "1");
  const pickEnhance = (m: EnhanceMode) => {
    setEnhError(null);
    setEnhance(m);
    try { localStorage.setItem(ENHANCE_KEY, m); } catch { /* ignore */ }
  };
  useEffect(() => {
    try { localStorage.setItem("abx.vivid", vivid ? "1" : "0"); } catch { /* ignore */ }
  }, [vivid]);

  useEffect(() => {
    const v = video.current, c = canvas.current;
    if (enhance === "off" || isEmbed || preparingLocal || !v || !c) {
      setEnhancing("idle");
      setEnhError(null);
      setEnhStats(null);
      return;
    }
    const ac = new AbortController();
    let stopped = false;
    let eng: Enhancer | null = null;
    setEnhancing("starting");
    setEnhError(null);
    startEnhancer(v, c, enhance, {
      signal: ac.signal,
      // The governor stepped down because the GPU couldn't keep up: say so, and stop if it reached "off".
      onDowngrade: (to, why) => {
        if (stopped) return;
        if (to === "off") {
          eng?.stop();
          eng = null;
          setEnhancing("error");
          setEnhError("GPU couldn't keep up at this resolution — switched to native video");
          setEnhStats(null);
          flash("Enhancement turned off: this GPU can't keep up at this size");
          return;
        }
        flash(`Enhancement eased to ${ENHANCE_MODES.find((m) => m.id === to)?.name} (${why})`);
      },
      // Hardware context loss, uncaptured shader error, or CORS taint: fall back to native <video>.
      onFallback: (why) => {
        if (stopped) return;
        eng?.stop();
        eng = null;
        setEnhancing("error");
        setEnhError(why);
        setEnhStats(null);
        flash(why);
      },
    })
      .then((e) => {
        if (stopped || ac.signal.aborted) return e.stop();
        eng = e;
        setEnhancing("on");
        setEnhStats(e.stats());
      })
      .catch((err) => {
        if (stopped || ac.signal.aborted) return;
        const msg = err?.message ?? String(err);
        setEnhancing("error");
        setEnhError(msg);
        setEnhStats(null);
        flash(`Enhancement fallback (native video): ${msg}`);
      });
    // Live stats for the Picture panel (GPU time per frame, chain, skipped frames).
    const statTimer = window.setInterval(() => eng && setEnhStats(eng.stats()), 1000);
    return () => {
      stopped = true;
      ac.abort();
      clearInterval(statTimer);
      eng?.stop();
      setEnhStats(null);
    };
  }, [enhance, cur?.url, isEmbed, preparingLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------- the rest */

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = vol;
    v.muted = muted;
    v.playbackRate = speed;
    try { localStorage.setItem("abx.vol", String(vol)); } catch { /* ignore */ }
  }, [vol, muted, speed, cur?.url]);

  // Report progress every 5s (video element or the embed's last report).
  useEffect(() => {
    const t = setInterval(() => {
      const v = video.current;
      if (curRef.current?.kind === "embed") {
        const p = embedPos.current;
        if (p.duration && p.time > 0) onProgress?.(p.time, p.duration);
      } else if (v && v.duration && !v.paused) onProgress?.(v.currentTime, v.duration);
    }, 5000);
    return () => clearInterval(t);
  }, [onProgress]);

  // Auto-hide controls.
  const idleTimer = useRef<number>();
  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  };
  useEffect(() => {
    poke();
    return () => clearTimeout(idleTimer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const v = video.current;
    if (!v || curRef.current?.kind === "embed") return;
    v.paused ? v.play().catch(() => {}) : v.pause();
  };
  const seekTo = (t: number) => {
    const v = video.current;
    if (!v || curRef.current?.kind === "embed" || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.25, t));
    // Move the playhead on screen now, not at the next timeupdate.
    setTime(v.currentTime);
  };
  const seek = (d: number) => {
    const v = video.current;
    if (!v || curRef.current?.kind === "embed" || !v.duration) return;
    seekTo(v.currentTime + d);
    setBump((b) => ({ total: b && Math.sign(b.total) === Math.sign(d) ? b.total + d : d, n: (b?.n ?? 0) + 1 }));
    clearTimeout(bumpTimer.current);
    bumpTimer.current = window.setTimeout(() => setBump(null), 750);
  };
  const changeVol = (d: number) => {
    setMuted(false);
    setVol((x) => {
      const n = Math.max(0, Math.min(1, +(x + d).toFixed(2)));
      flash(`Volume ${Math.round(n * 100)}%`);
      return n;
    });
  };
  const changeSpeed = (dir: 1 | -1) => {
    const i = SPEEDS.indexOf(speed);
    const n = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))];
    setSpeed(n);
    flash(n === 1 ? "Normal speed" : `Speed ${n}×`);
  };
  const pipOk = typeof document !== "undefined" && document.pictureInPictureEnabled;
  const togglePip = async () => {
    const v = video.current;
    if (!v || curRef.current?.kind === "embed") return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      flash("Picture-in-picture isn't available for this stream");
    }
  };

  // Fullscreen: in the desktop app the window itself goes fullscreen (WebView2's element
  // fullscreen only fills the webview); in a browser, the player element does.
  const win = isTauri() ? getCurrentWindow() : null;
  const setFull = async (on: boolean) => {
    try {
      if (win) {
        await win.setFullscreen(on);
        setIsFull(on);
      } else if (on) await wrap.current?.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
  };
  const toggleFull = () => setFull(!isFull);
  useEffect(() => {
    if (win) return;
    const f = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The player remounts on every episode; pick up the window's state so fullscreen carries over.
  // (Leaving the watch screen altogether exits fullscreen: see the app shell.)
  useEffect(() => {
    win?.isFullscreen().then(setIsFull).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const leave = () => {
    // The 5-second progress timer may not have fired yet: save where you actually stopped.
    saveNow();
    if (isFull) void setFull(false);
    onBack();
  };

  /**
   * Play from another server. One the viewer picked by hand is remembered as this show's server
   * once it plays; `auto` is for moves the viewer didn't choose a server for.
   */
  const switchTo = async (id: string, opts?: { demoteCurrent?: boolean; auto?: boolean }) => {
    let c = session.get(id);
    if (!c) return;
    const prevId = activeIdRef.current;
    if (id === prevId && c.probe?.ok !== false) return;

    verifyCtlRef.current?.abort();
    verifyCtlRef.current = null;
    refreshCtlRef.current?.abort();
    refreshCtlRef.current = null;
    const gen = ++verifyGenRef.current;
    if (!opts?.auto) session.choose(id);

    // A server on standby, or one from a page whose check failed earlier, is checked first.
    if ((!c.probe || !c.probe.ok) && (c.kind === "embed" || Boolean(c.pageUrl))) {
      const ctl = new AbortController();
      verifyCtlRef.current = ctl;
      setChecking(id);
      const r = await session.verify(id, ctl.signal);
      if (!mountedRef.current || ctl.signal.aborted || gen !== verifyGenRef.current) return;
      if (verifyCtlRef.current === ctl) verifyCtlRef.current = null;
      setChecking(null);
      if (!r?.probe?.ok) {
        flash(
          r?.probe?.error && r.probe.error !== "no stream"
            ? `${c.providerName}: ${r.probe.error}`
            : `${c.providerName} doesn't have this one`,
        );
        return;
      }
      c = r;
    } else {
      setChecking(null);
    }
    if (!mountedRef.current || gen !== verifyGenRef.current) return;

    if (opts?.demoteCurrent && prevId && prevId !== id) {
      reported.current.delete(prevId);
      session.report(prevId, false, { error: "wasn't playing right" });
    }

    saveNowRef.current();
    failedSessionRef.current = -1;
    started.current = false;
    setHasStarted(false);
    setPlaying(false);
    setLiveStreamId(null);

    if (id === activeIdRef.current) {
      setRetrySeq((n) => n + 1);
    } else {
      activeIdRef.current = id;
      setActiveId(id);
    }
    flash(`Now playing from ${c.providerName}${resumeAt.current > 5 ? ` at ${fmtTime(resumeAt.current)}` : ""}`);
  };

  const refreshServerList = useCallback(() => {
    if (!onRetry) return;
    saveNowRef.current();
    setSheet(null);
    onRetry();
  }, [onRetry]);

  /** "Not playing right?": move to the next server (ready first, then standby, then any other). */
  const nextServer = () => {
    const others = candidates.filter((c) => candKey(c) !== activeKey);
    const to = others.find((c) => c.probe?.ok) ?? others.find((c) => !c.probe) ?? others[0];
    if (!to) return flash("No other server available");
    void switchTo(candKey(to), { demoteCurrent: true, auto: true });
  };
  const changeAudio = (a: Audio) => {
    saveNow();
    onAudio?.(a);
  };

  /* ---------------------------------------------------------------- up next */

  const clock = isEmbed ? embedClock : { time, duration: dur };
  const remaining = clock.duration ? clock.duration - clock.time : Infinity;
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const showUpNext = !!onNext && !upNextDismissed && remaining <= UP_NEXT_AT && remaining > 0.5 && clock.duration > 120;

  // Keyboard shortcuts (bound once via ref so timeupdate ticks don't re-bind the window listener).
  const onKeyRef = useRef<(e: KeyboardEvent) => void>();
  onKeyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (
      el?.tagName === "INPUT" ||
      el?.tagName === "TEXTAREA" ||
      el?.tagName === "SELECT" ||
      el?.isContentEditable
    ) return;
    // Ctrl+K and friends belong to the app, not the player (Ctrl+K used to pause as well).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    poke();
    // Letters work with Caps Lock on.
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keysOpen && k !== "?") {
      setKeysOpen(false);
      if (k === "Escape") return;
    }
    if (k >= "0" && k <= "9" && k.length === 1) {
      const v = video.current;
      if (v?.duration) seekTo((Number(k) / 10) * v.duration);
      return;
    }
    switch (k) {
      case " ": case "k": e.preventDefault(); toggle(); break;
      case "ArrowLeft": seek(e.shiftKey ? -30 : -5); break;
      case "ArrowRight": seek(e.shiftKey ? 30 : 5); break;
      case "j": seek(-10); break;
      case "l": seek(10); break;
      case "ArrowUp": e.preventDefault(); changeVol(0.1); break;
      case "ArrowDown": e.preventDefault(); changeVol(-0.1); break;
      case "m": setMuted((x) => !x); break;
      case "c":
        if (e.shiftKey) cycleSub();
        else toggleSub();
        break;
      case "s": setSheet((x) => (x === "servers" ? null : "servers")); break;
      case "e": if (episodes) setSheet((x) => (x === "episodes" ? null : "episodes")); break;
      case "[": case "{":
        if (selectedSubRef.current || secondarySubRef.current) nudge(e.shiftKey || k === "{" ? -0.1 : -0.5);
        break;
      case "]": case "}":
        if (selectedSubRef.current || secondarySubRef.current) nudge(e.shiftKey || k === "}" ? 0.1 : 0.5);
        break;
      case "<": changeSpeed(-1); break;
      case ">": changeSpeed(1); break;
      case ",": case ".": {
        // Frame step, the way editors do it: only while paused.
        const v = video.current;
        if (v && v.paused && !isEmbed) seekTo(v.currentTime + (k === "." ? 1 : -1) / 24);
        break;
      }
      case "f": toggleFull(); break;
      case "p": void togglePip(); break;
      case "n": onNext?.(); break;
      case "?": setKeysOpen((x) => !x); break;
      case "Escape":
        if (sheet) setSheet(null);
        else if (isFull) void setFull(false);
        else leave();
        break;
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current?.(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hardware media keys, headset buttons and the Windows media flyout.
  const nextRef = useRef(onNext);
  nextRef.current = onNext;
  const hasNext = !!onNext;
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === "undefined") return;
    ms.metadata = new MediaMetadata({
      title: subtitle ? `${title} · ${subtitle}` : title,
      artist: "AbixCine",
      artwork: media?.backdrop ? [{ src: media.backdrop }] : [],
    });
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, h);
      } catch {
        /* action not supported here */
      }
    };
    set("play", () => void video.current?.play().catch(() => {}));
    set("pause", () => video.current?.pause());
    set("seekbackward", () => seek(-10));
    set("seekforward", () => seek(10));
    set("nexttrack", hasNext ? () => nextRef.current?.() : null);
    return () => {
      (["play", "pause", "seekbackward", "seekforward", "nexttrack"] as MediaSessionAction[]).forEach((a) => set(a, null));
      ms.metadata = null;
    };
  }, [title, subtitle, media?.backdrop, hasNext]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable callbacks for the side sheet, so its lists don't re-render with every playhead tick.
  const latest = useRef({ switchTo, saveNow, episodes });
  latest.current = { switchTo, saveNow, episodes };
  const pickServer = useCallback((c: StreamCandidate) => void latest.current.switchTo(candKey(c)), []);
  const triggerCheckStandbys = useCallback(() => void session.checkAll(), [session]);
  const stopChecking = useCallback(() => session.stopBackground(), [session]);
  const pickEpisode = useCallback((s: number | undefined, e: number) => {
    latest.current.saveNow();
    latest.current.episodes?.go(s, e);
  }, []);

  /* ---------------------------------------------------------------- scrubber */

  const scrubRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const atX = (clientX: number) => {
    const r = scrubRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return { x: 0, t: 0, w: 0 };
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { x: f * r.width, t: f * dur, w: r.width };
  };
  const onScrubDown = (e: React.PointerEvent) => {
    if (!dur) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const p = atX(e.clientX);
    setTime(p.t);
    setHover(p);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    if (!dur) return;
    const p = atX(e.clientX);
    setHover(p);
    if (dragging) setTime(p.t);
  };
  const onScrubUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    seekTo(atX(e.clientX).t);
  };
  /** What the scrubber tooltip calls the stretch you're pointing at. */
  const partAt = (t: number) => (sk?.intro && t >= sk.intro[0] && t < sk.intro[1] ? "Intro" : sk?.outro && t >= sk.outro[0] && t < sk.outro[1] ? "Credits" : null);

  const pct = dur ? (time / dur) * 100 : 0;
  const hide = idle && playing && !sheet && !showUpNext && !dragging;
  const embedHide = isEmbed && idle && !sheet;
  const q = cur?.probe?.quality ?? cur?.quality;
  const curLevel = level >= 0 ? levels[level]?.height : activeLevel >= 0 ? levels[activeLevel]?.height : undefined;
  const shownQ = curLevel ?? videoHeight ?? q;
  const primTrack = selectedSub ? subTracks.find((t) => t.id === selectedSub) : undefined;
  const secTrack = secondarySub ? subTracks.find((t) => t.id === secondarySub) : undefined;
  const primLangCode = primTrack ? langBase(primTrack.lang) : "";
  const subPillText = primTrack
    ? secTrack
      ? `${primLangCode && primLangCode !== "und" ? primLangCode.toUpperCase() : "SUB"}×2`
      : primLangCode && primLangCode !== "und"
        ? primLangCode.toUpperCase()
        : "ON"
    : secTrack
      ? "DUAL"
      : null;
  const isActivelyStreaming = Boolean(
    cur && (playing || hasStarted || (liveStreamId !== null && liveStreamId === activeKey)),
  );
  const isConnecting = Boolean(cur && !isActivelyStreaming && waiting);
  const playableCount = candidates.filter((c) => c.probe?.ok).length;
  const playable = Math.max(playableCount, cur && isActivelyStreaming ? 1 : 0);
  const curLatency = cur?.probe?.ok && typeof cur.probe.latencyMs === "number" && cur.probe.latencyMs > 0 ? cur.probe.latencyMs : undefined;
  const spDotClass = isActivelyStreaming
    ? "live"
    : isConnecting
      ? "wait"
      : checking
        ? "busy"
        : !cur || cur.probe?.ok === false
          ? "off"
          : "";
  const spMeta = [
    isActivelyStreaming ? "Playing" : isConnecting ? "Connecting" : null,
    shownQ ? (shownQ >= 2160 ? "4K" : `${shownQ}p`) : null,
    curLatency ? `${curLatency} ms` : null,
  ].filter(Boolean).join(" · ");

  // Universal intro/outro skip segments: merge candidate-provided ranges with TheIntroDB v4 / AniSkip v2.
  const [fetchedSkip, setFetchedSkip] = useState<SkipSegments | null>(null);
  const durRef = useRef(dur);
  durRef.current = dur;
  useEffect(() => {
    setFetchedSkip(null);
    if (!cur || isEmbed) return;
    if (cur.skip?.intro && cur.skip?.outro) return;
    if (!media?.tmdbId && !media?.imdbId && !media?.malId) return;
    const ctl = new AbortController();
    fetchSkipSegments(
      {
        kind: media?.kind,
        tmdbId: media?.tmdbId,
        imdbId: media?.imdbId,
        malId: media?.malId,
        season: epSeason,
        episode: epNumber,
        durationSec: durRef.current > 0 ? durRef.current : undefined,
      },
      { signal: ctl.signal },
    )
      .then((res) => {
        if (!ctl.signal.aborted && mountedRef.current) setFetchedSkip(res);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [cur?.url, isEmbed, cur?.skip?.intro, cur?.skip?.outro, media?.kind, media?.tmdbId, media?.imdbId, media?.malId, epSeason, epNumber]);

  const sk = useMemo(() => mergeSkipRanges(cur?.skip, fetchedSkip), [cur?.skip, fetchedSkip]);
  const outroEnd = sk?.outro ? (Number.isFinite(sk.outro[1]) ? sk.outro[1] : (dur > 0 ? dur : Infinity)) : undefined;
  const inIntro = !!sk?.intro && time >= sk.intro[0] && time < sk.intro[1] - 1.5;
  const inOutro = !!sk?.outro && outroEnd != null && time >= sk.outro[0] && time < outroEnd - 1.5;
  const isPrimAss = Boolean(primTrack && (primTrack.format === "ass" || primTrack.format === "ssa") && primTrack.raw);
  const enhMode = ENHANCE_MODES.find((m) => m.id === enhance) ?? ENHANCE_MODES[0];
  const openSheet = (s: Sheet) => setSheet((x) => (x === s ? null : s));

  return (
    <div
      ref={wrap}
      className={`player ${isEmbed ? "is-embed" : ""} ${hide || embedHide ? "idle" : ""} ${isFull ? "is-full" : ""} ${sheet ? "has-sheet" : ""}`}
      onMouseMove={poke}
      onDragEnter={(e) => {
        if (isEmbed || !e.dataTransfer?.types?.includes("Files")) return;
        dragDepthRef.current += 1;
        setDragOverSub(true);
      }}
      onDragOver={(e) => {
        if (isEmbed || !e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (isEmbed) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragOverSub(false);
      }}
      onDrop={(e) => {
        if (isEmbed) return;
        dragDepthRef.current = 0;
        setDragOverSub(false);
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        void addSubtitleFiles(e.dataTransfer.files);
      }}
    >
      <div
        className="screen"
        onClick={() => (sheet ? setSheet(null) : toggle())}
        onDoubleClick={() => !isEmbed && toggleFull()}
        onWheel={(e) => {
          if (isEmbed || !e.deltaY) return;
          poke();
          changeVol(e.deltaY < 0 ? 0.05 : -0.05);
        }}
      >
        {isEmbed ? (
          <iframe
            key={`${cur.url}:${retrySeq}`}
            src={embedSrc}
            className={`embed-frame ${vivid ? "vivid" : ""}`}
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media; gyroscope; accelerometer"
            allowFullScreen
            referrerPolicy="origin"
            onLoad={() => {
              setWaiting(false);
              started.current = true;
              setHasStarted(true);
              setPlaying(true);
              onPlaying();
            }}
          />
        ) : (
          <>
            <video
              ref={video}
              playsInline
              crossOrigin="anonymous"
              className={enhancing === "on" ? "under" : ""}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                setPlaying(false);
                // Pausing is often the last thing you do before closing the app.
                if (started.current) saveNow();
              }}
              onWaiting={() => {
                setWaiting(true);
                armStall();
              }}
              onPlaying={() => {
                setWaiting(false);
                clearStall();
                started.current = true;
                setHasStarted(true);
                onPlaying();
              }}
              onCanPlay={() => {
                setWaiting(false);
                if (started.current) clearStall();
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (!dragging) setTime(v.currentTime);
                setBuffered(bufferedAhead(v));
              }}
              onLoadedMetadata={(e) => {
                const h = e.currentTarget.videoHeight || undefined;
                videoHeightRef.current = h;
                setVideoHeight(h);
              }}
              onResize={(e) => {
                const h = e.currentTarget.videoHeight || undefined;
                videoHeightRef.current = h;
                setVideoHeight(h);
              }}
              onProgress={(e) => setBuffered(bufferedAhead(e.currentTarget))}
              onDurationChange={(e) => setDur(e.currentTarget.duration)}
              onEnded={() => { const v = video.current; if (v) onProgress?.(v.duration, v.duration); onEnded?.(); }}
              onError={() => cur?.kind === "file" && failover("unsupported or unreachable file")}
            />
            <canvas key={`${enhance}:${cur?.url ?? ""}`} ref={canvas} className={`enhance-canvas ${enhancing === "on" ? "on" : ""}`} aria-hidden />
            <SubtitleOverlay
              cues={activePrimaryCues}
              secondaryCues={activeSecondaryCues}
              subPref={pref}
              controlsVisible={!(hide || embedHide)}
              videoRef={video}
              assRaw={isPrimAss ? primTrack?.raw : undefined}
              assFormat={isPrimAss ? primTrack?.format : undefined}
              offsetSec={offset}
              subEnabled={Boolean(primTrack)}
            />
          </>
        )}
        {waiting && (
          <div className="pload" aria-label="Loading">
            <span className="pload-ring" />
            <span className="pload-txt">
              {preparingTorrent
                ? "Starting torrent stream"
                : preparingLocal
                  ? "Preparing local audio"
                  : hasStarted
                    ? "Buffering"
                    : `Connecting to ${cur?.providerName ?? "server"}`}
            </span>
          </div>
        )}
      </div>

      {/* Sits under the chrome but over the iframe, so moving to the top edge wakes the controls. */}
      <div className="ptop-hover-zone" onMouseEnter={poke} onMouseMove={poke} />

      <div className="chrome">
        <header className="ptop">
          <button className="pbtn round" onClick={leave} aria-label="Back" title="Back (Esc)"><Icon name="back" size={20} /></button>
          <div className="ptitle">
            {media?.logo ? <img className="plogo" src={media.logo} alt={title} /> : <div className="pt">{title}</div>}
            <div className="ps">{[subtitle, media?.year].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="ptop-actions">
            {isEmbed && audio && onAudio && <AudioToggle compact value={audio} onChange={changeAudio} />}
            <button className={`server-pill ${sheet === "servers" ? "on" : ""}`} onClick={() => openSheet("servers")} title="Servers (S)">
              <span className={`sp-dot ${spDotClass}`} />
              <span className="sp-name">{cur?.providerName ?? "No server"}</span>
              <span className="sp-meta">{spMeta}</span>
              <span className="sp-count" title={`${playable} ready server${playable === 1 ? "" : "s"}`}>{playable}</span>
            </button>
            {candidates.length > 1 && (
              <button className="pbtn" onClick={nextServer} title="Not playing? Try the next server">
                <Icon name="refresh" size={17} /><span>Next server</span>
              </button>
            )}
            {episodes && (
              <button className={`pbtn ${sheet === "episodes" ? "on" : ""}`} onClick={() => openSheet("episodes")} title="Episodes (E)">
                <Icon name="tv" size={17} /><span>Episodes</span>
              </button>
            )}
            {isEmbed && (
              <button className={`pbtn icon ${sheet === "picture" ? "on" : ""}`} onClick={() => openSheet("picture")} title="Picture">
                <Icon name="spark" size={17} />
              </button>
            )}
            {!isEmbed && <button className={`pbtn icon ${keysOpen ? "on" : ""}`} onClick={() => setKeysOpen((x) => !x)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Icon name="keys" size={18} /></button>}
            <button className="pbtn icon" onClick={toggleFull} aria-label="Fullscreen" title="Fullscreen (F)"><Icon name={isFull ? "unfull" : "full"} size={18} /></button>
          </div>
        </header>

        {!isEmbed && (
          <div className={`center-controls ${!playing && !waiting ? "show" : ""}`} onClick={(e) => e.stopPropagation()}>
            <button className="cc-btn" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={26} /></button>
            <button className="cc-btn main" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={34} /></button>
            <button className="cc-btn" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={26} /></button>
          </div>
        )}

        {!isEmbed && (
          <footer className="pbot" onClick={(e) => e.stopPropagation()} onMouseMove={poke}>
            <div
              ref={scrubRef}
              className={`scrub ${dragging ? "drag" : ""}`}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(dur)}
              aria-valuenow={Math.round(time)}
              aria-valuetext={`${fmtTime(time)} of ${fmtTime(dur)}`}
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              onPointerLeave={() => !dragging && setHover(null)}
            >
              <div className="c">
                <span className="buf" style={{ width: `${dur ? (buffered / dur) * 100 : 0}%` }} />
                {hover && <span className="ghost" style={{ width: hover.x }} />}
                <i style={{ width: `${pct}%` }} />
                {dur > 0 && sk?.intro && <span className="part" style={{ left: `${(sk.intro[0] / dur) * 100}%`, width: `${((sk.intro[1] - sk.intro[0]) / dur) * 100}%` }} />}
                {dur > 0 && sk?.outro && <span className="part" style={{ left: `${(sk.outro[0] / dur) * 100}%`, width: `${((Math.min(dur, sk.outro[1]) - sk.outro[0]) / dur) * 100}%` }} />}
              </div>
              <span className="knob" style={{ left: `${pct}%` }} />
              {hover && dur > 0 && (
                <span className="scrub-tip" style={{ left: Math.max(34, Math.min(hover.w - 34, hover.x)) }}>
                  {partAt(hover.t) && <em>{partAt(hover.t)}</em>}
                  {fmtTime(hover.t)}
                </span>
              )}
            </div>
            <div className="prow">
              <div className="pc">
                <button className="pbtn round big" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={20} /></button>
                <button className="pbtn icon" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={20} /></button>
                <button className="pbtn icon" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={20} /></button>
                {onNext && <button className="pbtn icon" onClick={onNext} aria-label="Next episode" title="Next episode (N)"><Icon name="next" size={20} /></button>}
                <div className="vol">
                  <button className="pbtn icon" onClick={() => setMuted((m) => !m)} aria-label="Mute"><Icon name={muted || vol === 0 ? "mute" : "vol"} size={20} /></button>
                  <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : vol} style={{ ["--v" as any]: `${(muted ? 0 : vol) * 100}%` }} onChange={(e) => { setMuted(false); setVol(Number(e.target.value)); }} aria-label="Volume" />
                </div>
                <button
                  className="time"
                  title={timeLeft ? "Show total length" : "Show time left"}
                  onClick={() => setTimeLeft((x) => {
                    try { localStorage.setItem(TIME_LEFT_KEY, x ? "0" : "1"); } catch { /* ignore */ }
                    return !x;
                  })}
                >
                  {fmtTime(time)}<em> / {timeLeft ? `-${fmtTime(Math.max(0, dur - time))}` : fmtTime(dur)}</em>
                </button>
              </div>
              <div className="pc">
                {audio && onAudio && <AudioToggle compact value={audio} onChange={changeAudio} />}
                <button
                  className={`pbtn icon sub-pill-btn ${primTrack || secTrack ? "lit" : ""} ${sheet === "subtitles" ? "on" : ""}`}
                  onClick={() => openSheet("subtitles")}
                  title="Subtitles (C toggles · Shift+C cycles)"
                  aria-label="Subtitles"
                >
                  <Icon name="subtitles" size={20} />
                  {subPillText && <span className={`sub-pill-badge ${secTrack ? "dual" : ""}`}>{subPillText}</span>}
                </button>
                <button
                  className={`pbtn chipbtn ${sheet === "picture" ? "on" : ""}`}
                  onClick={() => openSheet("picture")}
                  title={enhancing === "error" && enhError ? `Native fallback: ${enhError}` : "Picture & playback"}
                >
                  {shownQ ? <span className={`q ${shownQ >= 2160 ? "" : "hd"}`}>{shownQ >= 2160 ? "4K" : shownQ >= 720 ? "HD" : "SD"}</span> : null}
                  {enhance !== "off" && <span className={`enh-dot ${enhancing}`} title={enhancing === "error" ? enhError ?? "Native playback fallback" : enhMode.name} />}
                  <span>
                    {shownQ ? `${shownQ}p` : "Auto"}
                    {enhance !== "off" && enhancing === "error" ? " · Native" : ""}
                    {speed !== 1 ? ` · ${speed}×` : ""}
                  </span>
                </button>
                {pipOk && <button className="pbtn icon" onClick={() => void togglePip()} aria-label="Picture-in-picture" title="Picture-in-picture (P)"><Icon name="pip" size={20} /></button>}
                <button className="pbtn icon" onClick={toggleFull} aria-label="Fullscreen" title="Fullscreen (F)"><Icon name={isFull ? "unfull" : "full"} size={20} /></button>
              </div>
            </div>
          </footer>
        )}
      </div>

      {!isEmbed && (inIntro || (inOutro && !showUpNext)) && (
        <button
          className="skip-btn"
          onClick={(e) => {
            e.stopPropagation();
            const v = video.current;
            const target = inIntro ? sk?.intro?.[1] : sk?.outro?.[1];
            if (v && target != null) {
              const clamped = Number.isFinite(target)
                ? (v.duration ? Math.min(v.duration - 0.25, target) : target)
                : (v.duration ? Math.max(0, v.duration - 0.25) : undefined);
              if (clamped != null && Number.isFinite(clamped)) {
                v.currentTime = clamped;
                setTime(clamped);
              }
            }
          }}
        >
          {inIntro ? "Skip intro" : "Skip credits"} <Icon name="next" size={16} />
        </button>
      )}

      {showUpNext && (
        <UpNext
          label={episodes?.nextLabel ?? nextLabel ?? "Next episode"}
          still={media?.backdrop}
          seconds={Math.ceil(remaining)}
          auto={!!autoNext}
          onPlay={() => onNext?.()}
          onDismiss={() => setUpNextDismissed(true)}
        />
      )}

      <aside className={`psheet ${sheet ? "open" : ""}`} aria-hidden={!sheet} onMouseMove={poke}>
        <div className="ps-head">
          <div className="ps-tabs" role="tablist">
            <button role="tab" className={sheet === "servers" ? "on" : ""} onClick={() => setSheet("servers")}>Servers</button>
            {episodes && <button role="tab" className={sheet === "episodes" ? "on" : ""} onClick={() => setSheet("episodes")}>Episodes</button>}
            <button role="tab" className={sheet === "subtitles" ? "on" : ""} onClick={() => setSheet("subtitles")}>Subtitles</button>
            <button role="tab" className={sheet === "audio" ? "on" : ""} onClick={() => setSheet("audio")}>Audio</button>
            <button role="tab" className={sheet === "picture" ? "on" : ""} onClick={() => setSheet("picture")}>Picture</button>
          </div>
          <button className="pbtn icon" onClick={() => setSheet(null)} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="ps-body" key={sheet ?? "none"}>
          {sheet === "servers" && (
            <ServerSheet
              snap={snap}
              playingKey={isActivelyStreaming ? activeKey : undefined}
              busyKey={checking ?? (isConnecting ? activeKey : null)}
              busyNote={checking ? "Checking…" : "Connecting…"}
              onPick={pickServer}
              onCheckAll={triggerCheckStandbys}
              onStop={stopChecking}
              onRefreshList={onRetry ? refreshServerList : undefined}
            />
          )}

          {sheet === "episodes" && episodes && <EpisodeSheet nav={episodes} onPick={pickEpisode} />}

          {sheet === "subtitles" && (
            <SubtitleSheet
              isEmbed={isEmbed}
              tracks={subTracks}
              selectedId={selectedSub}
              secondaryId={secondarySub}
              onSelectPrimary={chooseSub}
              onSelectSecondary={chooseSecondary}
              offset={offset}
              timingUnsupported={timingShiftUnsupported}
              onNudge={nudge}
              onResetOffset={resetOffset}
              onUploadFiles={(files) => void addSubtitleFiles(files)}
              subPref={pref}
              onPatchPref={patchPref}
              media={media}
              season={epSeason}
              episode={epNumber}
              canSaveSidecar={canSaveSidecar}
              onSaveSidecar={(track) => void saveSidecar(track)}
              savingTrackId={savingTrackId}
              savedTrackIds={savedTrackIds}
              onlineResults={onlineResults}
              onlineLoading={onlineLoading}
              onlineSearched={onlineSearched}
              onlineError={onlineError}
              onSearchOnline={(qTitle, qLang) => void searchOnline(qTitle, qLang)}
              onLoadOnline={(res, asDual) => void loadOnlineResult(res, asDual)}
              loadingOnlineId={loadingOnlineId}
              loadedOnlineMap={loadedOnlineMap}
            />
          )}

          {sheet === "audio" && (
            <div className="ps-section">
              {audio && onAudio && (
                <div className="ps-block">
                  <div className="ps-label">Audio</div>
                  <div className="audio-cards">
                    {(["sub", "dub"] as const).map((a) => (
                      <button key={a} className={`audio-card ${audio === a ? "on" : ""}`} onClick={() => audio !== a && changeAudio(a)}>
                        <strong>{a === "sub" ? "Japanese" : "English dub"}</strong>
                        <small>{a === "sub" ? "Original voices, English subtitles" : "English voice cast"}</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {audioTracks.length > 0 && (
                <div className="ps-block">
                  <div className="ps-label">Audio tracks</div>
                  <div className="opt-list">
                    {audioTracks.map((t) => (
                      <button key={t.id} className={`opt ${selectedAudioTrack === t.id ? "on" : ""}`} onClick={() => chooseAudioTrack(t.id)}>
                        <span>{t.label}</span>
                        <small>{langBase(t.lang) !== "und" ? langBase(t.lang).toUpperCase() : ""}</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!audio && audioTracks.length === 0 && (
                <p className="ps-note">
                  {isEmbed
                    ? "Audio tracks are controlled inside this stream's player."
                    : cur?.kind === "file"
                      ? "Audio is selected by the media engine for this file. If it is silent, its audio codec may not be supported."
                      : "This stream provides a single audio track."}
                </p>
              )}
            </div>
          )}

          {sheet === "picture" && (
            <div className="ps-section">
              <div className="ps-block">
                <div className="ps-label">Enhancement <span className="ps-sub">Anime4K</span></div>
                {isEmbed ? (
                  <>
                    <button className={`opt big ${vivid ? "on" : ""}`} onClick={() => setVivid((x) => !x)}>
                      <span>Vivid</span>
                      <small>Richer colour and contrast for this server</small>
                    </button>
                    <p className="ps-note">Anime4K upscaling runs on streams AbixCine decodes itself: your files, Jellyfin and direct links. Online servers play inside their own sealed player, so only the colour lift applies here.</p>
                  </>
                ) : !upscalerAvailable() ? (
                  <p className="ps-note">Your graphics driver doesn't expose WebGPU or WebGL2 shaders, which picture enhancement needs. Playing native video.</p>
                ) : (
                  <>
                    {enhancing === "error" && (
                      <div className="ps-note" role="status">
                        <strong>Playing native video</strong> — {enhError ?? "GPU enhancement unavailable for this stream."}
                      </div>
                    )}
                    <div className="opt-list">
                      {ENHANCE_MODES.map((m) => (
                        <button key={m.id} className={`opt big ${enhance === m.id ? "on" : ""}`} onClick={() => pickEnhance(m.id)}>
                          <span>{m.name}{m.heavy && <em className="heavy">GPU heavy</em>}</span>
                          <small>
                            {enhance === m.id && enhancing === "starting"
                              ? "Compiling shaders…"
                              : enhance === m.id && enhancing === "error"
                                ? `Fallback to native video (${enhError ?? "unavailable on this stream"})`
                                : enhance === m.id && enhStats
                                  ? `${enhStats.mode !== m.id ? `Eased to ${ENHANCE_MODES.find((x) => x.id === enhStats.mode)?.name} · ` : ""}${enhStats.chain} · ${enhStats.gpuMs} ms per frame${enhStats.skipped ? ` · ${enhStats.skipped} frames skipped` : ""}`
                                  : m.hint}
                          </small>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {!isEmbed && (
                <div className="ps-block">
                  <div className="ps-label">Speed</div>
                  <div className="seg3 wrap">
                    {SPEEDS.map((sp) => <button key={sp} className={sp === speed ? "on" : ""} onClick={() => setSpeed(sp)}>{sp}×</button>)}
                  </div>
                </div>
              )}
              {levels.length > 1 && (
                <div className="ps-block">
                  <div className="ps-label">Quality</div>
                  <div className="seg3 wrap">
                    <button
                      className={level === -1 ? "on" : ""}
                      onClick={() => {
                        if (hlsRef.current) {
                          hlsRef.current.currentLevel = -1;
                          setLevel(-1);
                        } else if (shakaRef.current) {
                          shakaRef.current.configure("abr.enabled", true);
                          setLevel(-1);
                        }
                      }}
                    >Auto</button>
                    {levels.map((l, i) => (
                      <button
                        key={i}
                        className={level === i ? "on" : ""}
                        onClick={() => {
                          if (hlsRef.current) {
                            hlsRef.current.currentLevel = i;
                            setLevel(i);
                          } else if (shakaRef.current) {
                            const targetH = dashHeightsRef.current[i] ?? l.height;
                            const match = shakaRef.current
                              .getVariantTracks()
                              .filter((t) => t.height === targetH)
                              .sort((a, b) => b.bandwidth - a.bandwidth)[0];
                            if (match) {
                              shakaRef.current.configure("abr.enabled", false);
                              shakaRef.current.selectVariantTrack(match, true, 2);
                              setLevel(i);
                            }
                          }
                        }}
                      >{l.height}p</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {bump && (
        <div className={`seek-bump ${bump.total > 0 ? "fwd" : "back"}`} key={bump.n} aria-hidden>
          <Icon name={bump.total > 0 ? "fwd" : "rew"} size={22} />
          <span>{bump.total > 0 ? "+" : "−"}{Math.abs(bump.total)}s</span>
        </div>
      )}

      {keysOpen && (
        <div className="pkeys-scrim" onClick={() => setKeysOpen(false)}>
          <div className="pkeys" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <div className="pkeys-h">Keyboard shortcuts <button className="pbtn icon" onClick={() => setKeysOpen(false)} aria-label="Close"><Icon name="x" size={16} /></button></div>
            <dl>
              {SHORTCUTS.map(([k, what]) => (
                <div key={k}><dt>{k}</dt><dd>{what}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {dragOverSub && !isEmbed && (
        <div className="drop-sub-overlay" aria-hidden>
          <div className="drop-sub-card">
            <Icon name="subtitles" size={38} />
            <strong>Drop subtitle file to load</strong>
            <span>Supports .srt, .vtt, .ass, .ssa</span>
          </div>
        </div>
      )}

      {toast && <div className="ptoast" key={toast}><i className="dot" />{toast}</div>}
    </div>
  );
}

/** End of the buffered range the playhead is in (not the last range, which may be far ahead after a seek). */
function bufferedAhead(v: HTMLVideoElement) {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.end(i);
  return t;
}

/* ------------------------------------------------------------------ servers */

const ServerSheet = memo(function ServerSheet({
  snap,
  playingKey,
  busyKey,
  busyNote,
  onPick,
  onCheckAll,
  onStop,
  onRefreshList,
}: {
  snap: SessionSnapshot;
  /** The stream on screen, once it is actually playing. */
  playingKey?: string;
  busyKey: string | null;
  busyNote: string;
  onPick: (c: StreamCandidate) => void;
  onCheckAll: () => void;
  onStop: () => void;
  onRefreshList?: () => void;
}) {
  const checkingMore = snap.busy && snap.checking.size > 0;
  return (
    <div className="ps-section">
      <p className="ps-note">Every server plays in AbixCine's own player, so there are no ads. Switching keeps your place, and a server you pick here stays this show's server.</p>
      {(snap.waiting > 0 || checkingMore || onRefreshList) && (
        <div className="srv-actions">
          {(snap.waiting > 0 || checkingMore) && (
            <button
              type="button"
              className={`srv-act ${checkingMore ? "busy" : ""}`}
              onClick={checkingMore ? onStop : onCheckAll}
              title={checkingMore ? "Stop checking" : "Check the servers on standby without interrupting playback"}
            >
              {checkingMore ? (
                <>
                  <span className="mini-spin" />
                  <span>Checking {snap.checking.size}… stop</span>
                </>
              ) : (
                <>
                  <Icon name="layers" size={14} />
                  <span>Check standby servers ({snap.waiting})</span>
                </>
              )}
            </button>
          )}
          {onRefreshList && (
            <button type="button" className="srv-act" onClick={onRefreshList} title="Throw the list away and look for servers again">
              <Icon name="refresh" size={14} />
              <span>Look again</span>
            </button>
          )}
        </div>
      )}
      <SourceBoard snap={snap} playingKey={playingKey} busyKey={busyKey} busyNote={busyNote} onPick={onPick} />
    </div>
  );
});

/* ----------------------------------------------------------------- episodes */

const PAGE = 50;

const EpisodeSheet = memo(function EpisodeSheet({ nav, onPick }: { nav: EpisodeNav; onPick: (s: number | undefined, e: number) => void }) {
  const validSeasons = useMemo(() => (nav.seasons ?? []).filter((s) => s.episodeCount > 0), [nav.seasons]);
  const initialSeason = useMemo(() => {
    if (!validSeasons.length) return nav.season;
    if (nav.season != null && validSeasons.some((s) => s.number === nav.season)) return nav.season;
    return validSeasons[0].number;
  }, [validSeasons, nav.season]);

  const [season, setSeason] = useState(initialSeason);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const curRef = useRef<HTMLButtonElement>(null);
  const total = nav.count ?? 0;
  const safeNavEp = Number.isFinite(nav.episode) && nav.episode >= 1 ? Math.floor(nav.episode) : 1;
  // Long-running anime (1000+ episodes) is paged in blocks of 50 around the current one.
  const [page, setPage] = useState(() => Math.max(0, Math.floor((safeNavEp - 1) / PAGE)));
  const [known, setKnown] = useState<Map<number, Episode>>(new Map());
  useEffect(() => {
    if (season != null || !nav.loadAll) return;
    let live = true;
    nav.loadAll().then((list) => live && setKnown(new Map(list.map((e) => [e.number, e])))).catch(() => {});
    return () => {
      live = false;
    };
  }, [season, nav.loadAll]);

  useEffect(() => {
    if (season == null || !nav.loadSeason) return setEps(null);
    let live = true;
    setEps(null);
    nav.loadSeason(season).then((r) => live && setEps(r)).catch(() => live && setEps([]));
    return () => {
      live = false;
    };
  }, [season, nav.loadSeason]);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: "center" });
  }, [eps, page]);

  const fullList: Episode[] =
    season != null
      ? eps ?? []
      : Array.from({ length: Math.max(0, total) }, (_, i) => known.get(i + 1) ?? { season: 0, number: i + 1, title: `Episode ${i + 1}` });
  const pages = Math.max(1, Math.ceil(fullList.length / PAGE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const list = fullList.length > PAGE ? fullList.slice(safePage * PAGE, (safePage + 1) * PAGE) : fullList;

  return (
    <div className="ps-section">
      {validSeasons.length > 1 && (
        <div className="season-strip">
          {validSeasons.map((s) => (
            <button
              key={s.number}
              className={s.number === season ? "on" : ""}
              onClick={() => {
                setSeason(s.number);
                setPage(0);
              }}
            >
              {s.number === 0 ? "Specials" : s.name.length <= 10 ? s.name : `S${s.number}`}
            </button>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="season-strip">
          {Array.from({ length: pages }, (_, p) => (
            <button key={p} className={p === safePage ? "on" : ""} onClick={() => setPage(p)}>
              {p * PAGE + 1}–{Math.min(fullList.length, (p + 1) * PAGE)}
            </button>
          ))}
        </div>
      )}
      <div className="ep-list">
        {season != null && !eps && Array.from({ length: 5 }, (_, i) => <div key={i} className="ep-row skeleton" />)}
        {season != null && eps && list.length === 0 && <p className="ps-note">No episodes available for this season.</p>}
        {list.map((e, i) => {
          const isCur = e.number === safeNavEp && (season ?? undefined) === nav.season;
          const still = e.still ?? nav.fallbackStill;
          return (
            <button
              key={e.number}
              ref={isCur ? curRef : undefined}
              className={`ep-row ${isCur ? "cur" : ""}`}
              style={{ ["--i" as any]: Math.min(i, 10) }}
              onClick={() => !isCur && onPick(season, e.number)}
            >
              <span className="ep-th">
                {still ? <img src={still} alt="" loading="lazy" /> : null}
                <b>{e.number}</b>
                {isCur && <span className="eq small" aria-label="Playing"><i /><i /><i /><i /></span>}
              </span>
              <span className="ep-tx">
                <span className="ep-t">{e.title}</span>
                <span className="ep-d">{[e.runtime ? `${e.runtime}m` : null, e.overview].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ up next */

function UpNext({ label, still, seconds, auto, onPlay, onDismiss }: { label: string; still?: string; seconds: number; auto: boolean; onPlay: () => void; onDismiss: () => void }) {
  return (
    <div className="upnext" onClick={(e) => e.stopPropagation()}>
      <div className="un-th" style={still ? { backgroundImage: `url(${still})` } : undefined}>
        <button className="un-play" onClick={onPlay} aria-label="Play next episode">
          <svg viewBox="0 0 36 36" className="un-ring" aria-hidden>
            <circle cx="18" cy="18" r="16" style={{ ["--p" as any]: auto ? Math.max(0, Math.min(1, seconds / UP_NEXT_AT)) : 1 }} />
          </svg>
          <Icon name="play" size={16} />
        </button>
      </div>
      <div className="un-tx">
        <small>{auto ? `Up next in ${seconds}s` : "Up next"}</small>
        <strong>{label}</strong>
        <div className="un-acts">
          <button className="btn play sm" onClick={onPlay}>Play now</button>
          <button className="btn glass sm" onClick={onDismiss}>Keep watching</button>
        </div>
      </div>
    </div>
  );
}
