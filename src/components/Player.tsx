import type Hls from "hls.js";
import type shaka from "shaka-player";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSlidingIndicators } from "../lib/useSlidingIndicator";
import { fmtTime } from "../lib/format";
import { ENHANCE_MODES, upscalerAvailable } from "../lib/enhance";
import { useEnhance } from "./player/useEnhance";
import { usePlayerShortcuts } from "./player/shortcuts";
import { useMediaSession } from "./player/useMediaSession";
import { useTrickplay } from "./player/useTrickplay";
import { useSubtitles } from "./player/useSubtitles";
import { useStreamEngine } from "./player/useStreamEngine";
import { useFullscreen, useIdleChrome, usePip } from "./player/useChrome";
import { fetchSkipSegments, mergeSkipRanges, type SkipSegments } from "../lib/skipSegments";
import { TranscriptSheet } from "./TranscriptSheet";
import { hasAudioFx, loadAudioFx, releaseAudioFx, resumeAudioFx, saveAudioFx, setAudioFx, type AudioFx } from "../lib/audioFx";
import { createHoverStore, createPlayhead, Scrubber, TimeReadout, usePlayhead } from "./Playhead";
import {
  UP_NEXT_AT,
  friendlyFailure,
  inUpNextWindow,
  loadSessionMute,
  loadingStage,
  nextSpeed,
  saveSessionMute,
  scrubPoint,
  showsSpinner,
  upNextVisible,
  wheelVolumeSteps,
  type WheelState,
} from "../lib/playerControls";
import { DashCueCollector } from "../lib/dashCues";
import { langBase } from "../lib/subtitles";
import { type Audio, updateSettings, useSettings } from "../lib/settings";
import type { StreamCandidate } from "../sources/types";
import type { SourceSession } from "../sources/session";
import { AudioToggle } from "./AudioToggle";
import { Icon } from "./Icon";
import { loadShowSpeed, saveShowSpeed, showKeyFor } from "../lib/showSpeed";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { SubtitleSheet } from "./SubtitleSheet";
import { MAX_VOL, SHORTCUTS, SLOW_MS, SPEEDS, TIME_LEFT_KEY, bufferedAhead, candKey, readEmbedMessage, withStart, type Sheet, type EpisodeNav, type PlayerMedia } from "./player/shared";
import { EpisodeSheet, ServerSheet, UpNext } from "./player/sheets";
import { Ambilight } from "./player/Ambilight";

export type { EpisodeNav };

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
  /** Open the title info page directly from the player. */
  onInfo?: () => void;
  /** Re-run the source search when every candidate has died. */
  onRetry?: () => void;
  nextLabel?: string;
  audio?: Audio;
  onAudio?: (a: Audio) => void;
  originalLanguage?: string;
  episodes?: EpisodeNav;
  season?: number;
  episode?: number;
  media?: PlayerMedia;
}

/** The toast's level bar for a volume, notched at 100% on the 0–200% boost range. */
const volMeter = (n: number) => ({ v: n / MAX_VOL, mark: 1 / MAX_VOL });

export function Player({ session, initialSource, title, subtitle, startAt, onProgress, onEnded, onNext, autoNext, nextLabel, onBack, onInfo, onRetry, audio, onAudio, originalLanguage, episodes, media, season, episode }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // The side sheet's tabs and every segmented picker inside it (subtitle sheet included) glide.
  const sheetInd = useSlidingIndicators<HTMLElement>(".ps-tabs, .seg3");
  const cinemaGlow = !!useSettings().cinemaGlow;
  const canvas = useRef<HTMLCanvasElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  /** The HLS stream's first presentation timestamp (s), for aligning side-loaded subtitle segments. */
  const initPtsRef = useRef<number | null>(null);
  /** Night mode / dialogue boost (lib/audioFx), remembered across sessions. */
  const [audioFx, setAudioFxState] = useState<AudioFx>(() => loadAudioFx());
  /**
   * Local files with several audio tracks: WebView2 can't switch them (no audioTracks API), so the
   * chosen track is prepared as its own file. `localAudioMode` marks that the list is ours.
   */
  const localAudioRef = useRef<number | null>(null);
  const localAudioModeRef = useRef(false);
  /** DASH: Shaka's cues for the selected text track are collected here and shown by our renderer. */
  const dashCollectorRef = useRef<DashCueCollector | null>(null);
  const dashSubIdRef = useRef<string | null>(null);
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
  // The playhead is a store, not state: see components/Playhead.tsx.
  const playhead = useMemo(() => createPlayhead(), []);
  const setTime = playhead.set;
  const [dur, setDur] = useState(0);
  const setBuffered = playhead.setBuffered;
  // Never start nearly silent: a saved volume under 15% (or an unreadable one) resets to 100%,
  // preventing accidental trackpad wheel drains from keeping every future launch quiet.
  const [vol, setVol] = useState(() => {
    let v = NaN;
    try {
      v = Number(localStorage.getItem("abx.vol"));
    } catch {
      /* storage blocked */
    }
    return Number.isFinite(v) && v >= 0.15 ? Math.min(MAX_VOL, v) : 1;
  });
  // Muting carries over to the next episode (the player is rebuilt for each), not to the next launch.
  const [muted, setMuted] = useState(loadSessionMute);
  const volRef = useRef(vol);
  volRef.current = vol;
  /** The last volume you could hear, for unmuting a slider that was dragged to zero. */
  const lastAudibleVolRef = useRef(vol > 0.001 ? vol : 1);
  const wheelRef = useRef<WheelState>({ acc: 0, at: 0 });
  // Speed carries over between episodes of the same show, never to other shows or films.
  const showKey = showKeyFor(media, episode);
  const [speed, setSpeed] = useState(() => loadShowSpeed(showKey));
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    // Only write when the viewer changed it, so opening an episode never rewrites the entry.
    if (speed !== loadShowSpeed(showKey)) saveShowSpeed(showKey, speed);
  }, [speed, showKey]);
  const [waiting, setWaiting] = useState(true);
  /** The stream died and the session is looking for another one. */
  const [recovering, setRecovering] = useState(false);
  /** Every server failed: what went wrong, shown with the ways out. */
  const [fatal, setFatal] = useState<{ why: string; server?: string } | null>(null);
  /** The video reached its end (Up next stays up then, with autoplay off). */
  const [ended, setEnded] = useState(false);
  const [preparingLocal, setPreparingLocal] = useState(false);
  const [preparingTorrent, setPreparingTorrent] = useState(false);
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
  /**
   * One toast at a time. A new message while one is up swaps the text in place (keeping its id, so
   * it doesn't re-enter on every wheel notch); `out` plays the exit before it unmounts. Keyed on the
   * text it used to re-run nothing when the same message came twice, and went silent.
   */
  // `meter`: a continuous setting (volume, speed) shows its level as a bar; `mark` notches a reference point.
  const [toast, setToast] = useState<{ msg: string; id: number; out: boolean; meter?: { v: number; mark?: number } } | null>(null);
  const [levels, setLevels] = useState<{ height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [activeLevel, setActiveLevel] = useState(-1);
  const [videoHeight, setVideoHeight] = useState<number | undefined>(undefined);
  // The seek-bar hover point is a store too (components/Playhead.tsx): only the scrubber follows it.
  const hoverStore = useMemo(() => createHoverStore(), []);
  /** The ±seconds badge that appears on the side you skipped towards; repeated presses add up. */
  // `again`: this press added to a running seek (+10s → +20s), so the disc re-pops instead of re-entering.
  const [bump, setBump] = useState<{ total: number; n: number; again?: boolean } | null>(null);
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
  const flash = (msg: string, meter?: { v: number; mark?: number }) => {
    if (!mountedRef.current) return;
    setToast((prev) => ({ msg, meter, id: prev && !prev.out ? prev.id : (prev?.id ?? 0) + 1, out: false }));
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((prev) => (prev ? { ...prev, out: true } : prev));
      toastTimer.current = window.setTimeout(() => setToast(null), 220);
    }, 2400);
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
    setRecovering(true);
    setFatal(null);
    const deadName = curRef.current?.providerName;
    const backupReady = session.getSnapshot().candidates.some((c) => candKey(c) !== deadId && c.probe?.ok && c.kind !== "embed");
    if (!backupReady) flash(`Checking backup servers (${why})…`);
    // A rejected search counts as "nothing found": it must not leave the spinner up for good.
    void session.failover(deadId, ctl.signal).catch(() => null).then((next) => {
      if (!mountedRef.current || ctl.signal.aborted || gen !== verifyGenRef.current) return;
      if (verifyCtlRef.current === ctl) verifyCtlRef.current = null;
      setRecovering(false);
      if (next) {
        const nextId = candKey(next);
        activeIdRef.current = nextId;
        setActiveId(nextId);
        flash(`Switched to ${next.providerName} (${why})`);
        return;
      }
      // Nothing else would play: say so on screen with the ways out, instead of a toast that
      // fades and leaves a black screen behind it.
      setWaiting(false);
      setFatal({ why, server: deadName });
    });
  }, [clearStall, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // First frame from a source is the proof it plays: the session marks it ready and learns from it.
  const onPlaying = useCallback(() => {
    const c = curRef.current;
    if (!c) return;
    const key = candKey(c);
    setLiveStreamId(key);
    setFatal(null);
    if (reported.current.has(key)) return;
    reported.current.add(key);
    session.report(key, true, {
      latencyMs: Math.max(1, Math.round(performance.now() - attachStartRef.current)),
      quality: video.current?.videoHeight || videoHeightRef.current,
      // The element's own length is the strongest evidence of which title is really playing.
      durationSec: video.current?.duration,
    });
  }, [session]);

  // Subtitles (player/useSubtitles.ts), lifted as one block so its hooks keep their order.
  const {
    activeCurUrlRef,
    activePrimaryCues,
    activeSecondaryCues,
    addSubtitleFiles,
    attachIdentityRef,
    audioTracks,
    canSaveSidecar,
    chooseSecondary,
    chooseSub,
    dragDepthRef,
    dragOverSub,
    epNumber,
    epSeason,
    evaluateCuesRef,
    keepPausedRef,
    lastActiveSubRef,
    loadOnlineResult,
    loadedOnlineMap,
    loadingOnlineId,
    manualAudio,
    nudge,
    nudgeSecondary,
    offset,
    offsetRef,
    onlineError,
    onlineLoading,
    onlineResults,
    onlineSearched,
    patchPref,
    patchTrackData,
    pref,
    resetOffset,
    resetSecondaryOffset,
    saveSidecar,
    savedTrackIds,
    savingTrackId,
    searchOnline,
    secOffset,
    secondarySub,
    secondarySubRef,
    selectedAudioTrack,
    selectedSub,
    selectedSubRef,
    setAudioTracks,
    setDragOverSub,
    setHlsReady,
    setHlsSubs,
    setNativeSubs,
    setSelectedAudioTrack,
    streamIdentityRef,
    subTracks,
    timingShiftUnsupported,
    toggleSub,
    trackData,
    cycleSub,
  } = useSubtitles({ media, flash, cur, mountedRef, isEmbed, title, originalLanguage, video, hlsRef, curRef, playing, episodes, dashSubIdRef, audio, shakaRef, season, initPtsRef, episode, dashCollectorRef, activeKey });

  // Scrub previews (player/useTrickplay.ts).
  const thumb = useTrickplay({ video, curRef, hoverStore, sourceUrl: cur?.url, retrySeq, isEmbed });

  // Sound effects and >100% pre-amp boost follow the <video> element, which is replaced per
  // stream: apply them to each new one when needed, and release the old one's nodes when it goes.
  useEffect(() => {
    const v = video.current;
    if (!v || isEmbed) return;
    const boost = muted ? 1 : Math.max(1, vol);
    if (audioFx.night || audioFx.dialogue || boost > 1.001 || hasAudioFx(v)) {
      setAudioFx(v, { ...audioFx, boost });
    }
  }, [audioFx, muted, vol, isEmbed, cur?.url, retrySeq]);
  useEffect(() => {
    const v = video.current;
    return () => {
      if (v) releaseAudioFx(v);
    };
  }, [cur?.url, retrySeq]);

  // Stream engine (player/useStreamEngine.ts): attach, audio tracks, watchdog. One block, same hook order.
  const { armStall, chooseAudioTrack } = useStreamEngine({
    activeCurUrlRef,
    activeSessionRef,
    activeTorrentIdRef,
    attachIdentityRef,
    attachStartRef,
    audio,
    audioTracks,
    clearStall,
    cur,
    curRef,
    dashCollectorRef,
    dashHeightsRef,
    dashSubIdRef,
    embedPos,
    evaluateCuesRef,
    failover,
    flash,
    hlsRef,
    initPtsRef,
    keepPausedRef,
    localAudioModeRef,
    localAudioRef,
    manualAudio,
    mountedRef,
    originalLanguage,
    patchTrackData,
    preparingLocal,
    preparingTorrent,
    refreshCtlRef,
    resumeAt,
    retrySeq,
    saveNowRef,
    secondarySubRef,
    selectedAudioTrack,
    selectedSubRef,
    session,
    setActiveLevel,
    setAudioTracks,
    setDur,
    setEmbedClock,
    setEnded,
    setFatal,
    setHasStarted,
    setHlsReady,
    setHlsSubs,
    setLevel,
    setLevels,
    setLiveStreamId,
    setNativeSubs,
    setPlaying,
    setPreparingLocal,
    setPreparingTorrent,
    setRecovering,
    setRetrySeq,
    setSelectedAudioTrack,
    setTime,
    setVideoHeight,
    setWaiting,
    shakaRef,
    stallTimer,
    started,
    stopActiveTorrent,
    streamIdentityRef,
    video,
  });

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
        setEnded(true);
        // "Keep watching" means stay, here as for our own video.
        if (!upNextDismissedRef.current) onEnded?.();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [isEmbed, cur?.url, onProgress, onEnded, onPlaying]);

  /* ------------------------------------------------------------ enhancement */

  const { enhance, pickEnhance, enhancing, enhError, enhStats, compareAt, setCompareAt, comparing, onCompareDrag, vivid, setVivid } = useEnhance({
    video,
    canvas,
    sourceUrl: cur?.url,
    isEmbed,
    preparingLocal,
    flash,
  });
  const toggleAudioFx = (k: keyof AudioFx) => {
    // Worked out here, not inside the state updater: updaters must be pure (StrictMode runs them
    // twice, which rebuilt the audio graph and fired the toast twice).
    const next = { ...audioFx, [k]: !audioFx[k] };
    setAudioFxState(next);
    saveAudioFx(next);
    const v = video.current;
    const boost = muted ? 1 : Math.max(1, volRef.current);
    // Applied inside the click (a user gesture), so a new AudioContext starts running.
    if (v && !isEmbed && !setAudioFx(v, { ...next, boost })) flash("Sound effects aren't available in this player");
  };

  /* ------------------------------------------------------------- the rest */

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, vol));
    v.muted = muted;
    // The default rate too: every new source (hls.js / Shaka attaching, a retry, a refreshed link)
    // runs the media load algorithm, which resets playbackRate to defaultPlaybackRate. With only
    // playbackRate set, a server switch at 1.5× quietly played at 1× while the chip still said 1.5×.
    v.defaultPlaybackRate = speed;
    v.playbackRate = speed;
    if (!isEmbed) {
      const boost = muted ? 1 : Math.max(1, vol);
      if (audioFx.night || audioFx.dialogue || boost > 1.001 || hasAudioFx(v)) {
        setAudioFx(v, { ...audioFx, boost });
      }
    }
    try { localStorage.setItem("abx.vol", String(vol)); } catch { /* ignore */ }
  }, [vol, muted, speed, isEmbed, audioFx, cur?.url, retrySeq]);
  useEffect(() => saveSessionMute(muted), [muted]);

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

  const { idle, poke, onPointerActivity, overChromeRef } = useIdleChrome(wrap, playing);

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
    setBump((b) => {
      const again = !!b && Math.sign(b.total) === Math.sign(d);
      return { total: again ? b!.total + d : d, n: (b?.n ?? 0) + 1, again };
    });
    clearTimeout(bumpTimer.current);
    bumpTimer.current = window.setTimeout(() => setBump(null), 750);
  };
  const setVolumeLevel = (target: number) => {
    const n = Math.max(0, Math.min(MAX_VOL, +target.toFixed(2)));
    volRef.current = n;
    if (n > 0.001) lastAudibleVolRef.current = n;
    setMuted(false);
    setVol(n);
    const v = video.current;
    if (v && !isEmbed && (n > 1.001 || audioFx.night || audioFx.dialogue || hasAudioFx(v))) {
      setAudioFx(v, { ...audioFx, boost: Math.max(1, n) });
    }
    return n;
  };
  const changeVol = (d: number) => {
    // Worked out here rather than inside the state updater: updaters must be pure (StrictMode
    // runs them twice, which fired the toast twice).
    const n = setVolumeLevel(volRef.current + d);
    flash(`Volume ${Math.round(n * 100)}%${n > 1.001 ? " (Boost)" : ""}`, volMeter(n));
  };
  /**
   * Mute / unmute. Unmuting a slider that was dragged all the way down brings back the last level
   * you could hear: it used to flip the mute flag and stay silent, with no way to tell why.
   */
  const toggleMute = (announce = false) => {
    const audible = volRef.current > 0.001;
    if (muted || !audible) {
      const n = audible ? volRef.current : setVolumeLevel(lastAudibleVolRef.current || 1);
      setMuted(false);
      if (announce) flash(`Sound on · ${Math.round(n * 100)}%`, volMeter(n));
    } else {
      setMuted(true);
      if (announce) flash("Muted", volMeter(0));
    }
  };
  const changeSpeed = (dir: 1 | -1) => {
    const n = nextSpeed(SPEEDS, speed, dir);
    setSpeed(n);
    const last = Math.max(1, SPEEDS.length - 1);
    flash(n === 1 ? "Normal speed" : `Speed ${n}×`, { v: SPEEDS.indexOf(n) / last, mark: SPEEDS.indexOf(1) / last });
  };
  // Volume from the mouse wheel, over the picture or the volume control.
  const onWheelVolume = (e: React.WheelEvent) => {
    if (isEmbed || sheet || !e.deltaY) return;
    poke();
    const steps = wheelVolumeSteps(wheelRef.current, e.deltaY, e.deltaMode, performance.now());
    if (steps) changeVol(steps * 0.05);
  };
  const { pipOk, pipOn, togglePip } = usePip(video, isEmbed, flash);

  const { isFull, setFull, toggleFull } = useFullscreen(wrap, mountedRef);
  const leave = () => {
    // The 5-second progress timer may not have fired yet: save where you actually stopped.
    saveNow();
    if (isFull) void setFull(false);
    onBack();
  };
  const goInfo = () => {
    if (!onInfo) return;
    saveNow();
    if (isFull) void setFull(false);
    onInfo();
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
    setFatal(null);
    setRecovering(false);

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

  // Seconds left, but only while it matters (the last UP_NEXT_AT seconds): the player re-renders
  // for the countdown, not for every tick of a two-hour film.
  const nativeRemaining = usePlayhead(playhead, (t) => {
    if (isEmbed || !dur) return null;
    const left = dur - t;
    return left <= UP_NEXT_AT && left > 0.5 ? Math.ceil(left) : null;
  });
  const clock = isEmbed ? embedClock : { time: 0, duration: dur };
  const remaining = isEmbed
    ? (embedClock.duration ? embedClock.duration - embedClock.time : Infinity)
    : nativeRemaining ?? Infinity;
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const upNextDismissedRef = useRef(false);
  upNextDismissedRef.current = upNextDismissed;
  // "Keep watching" holds for this run to the end. Seek back out of the last stretch and the card
  // (and autoplay at the end) come back, instead of being gone for the rest of the episode.
  const inUpNext = inUpNextWindow(remaining, ended);
  useEffect(() => {
    if (!inUpNext) setUpNextDismissed(false);
  }, [inUpNext]);
  /** Every way of moving to the next episode saves the playhead first (it used to lose up to 5 s). */
  const goNext = () => {
    if (!onNext) return;
    saveNowRef.current();
    onNext();
  };
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;
  // Single click toggles play, double click toggles fullscreen: without a short wait the double
  // click also paused and resumed, which stutters the picture.
  const clickTimer = useRef<number>();
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  // With autoplay off the card used to vanish exactly at the end (0.5 s left), when it's needed most.
  const showUpNext = upNextVisible({ hasNext: !!onNext, dismissed: upNextDismissed, remaining, duration: clock.duration, ended });

  // Keyboard shortcuts (player/shortcuts.ts), bound once; this render's actions are read through a ref.
  usePlayerShortcuts({
    video,
    sheet,
    setSheet,
    keysOpen,
    setKeysOpen,
    isEmbed,
    isFull,
    hasEpisodes: !!episodes,
    hasSubtitle: () => !!(selectedSubRef.current || secondarySubRef.current),
    poke,
    toggle,
    seek,
    seekTo,
    changeVol,
    toggleMute,
    changeSpeed,
    toggleSub,
    cycleSub,
    nudge,
    toggleFull,
    setFull,
    togglePip,
    goNext,
    goInfo,
    leave,
  });

  // Hardware media keys, headset buttons and the Windows media flyout (player/useMediaSession.ts).
  useMediaSession({ video, title, subtitle, artwork: media?.backdrop, hasNext: !!onNext, seek, goNext: () => goNextRef.current() });

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
  // Read by the pointer and timeupdate handlers, which must not see a render-old value.
  const draggingRef = useRef(false);
  const atX = (clientX: number) => scrubPoint(clientX, scrubRef.current?.getBoundingClientRect(), dur);
  const onScrubDown = (e: React.PointerEvent) => {
    if (!dur || e.button !== 0 || draggingRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragging(true);
    const p = atX(e.clientX);
    setTime(p.t);
    hoverStore.set(p);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    if (!dur) return;
    const p = atX(e.clientX);
    hoverStore.set(p);
    if (draggingRef.current) setTime(p.t);
  };
  const onScrubUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    seekTo(atX(e.clientX).t);
    // Released outside the bar: the preview goes too (pointerleave already fired during capture).
    const r = scrubRef.current?.getBoundingClientRect();
    if (r && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top - 8 || e.clientY > r.bottom + 8)) hoverStore.set(null);
  };
  /**
   * The drag ended without a release: capture lost to Alt+Tab, a system dialog or a cancelled touch.
   * It used to leave `dragging` stuck on, freezing the playhead on screen (timeupdate skips while
   * dragging) and keeping the controls up for good. Nothing is committed: the bar goes back to
   * where the video really is.
   */
  const onScrubCancel = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    hoverStore.set(null);
    const v = video.current;
    if (v) setTime(v.currentTime);
  };
  const onScrubLeave = () => {
    if (!draggingRef.current) hoverStore.set(null);
  };
  const toggleTimeLeft = useCallback(
    () =>
      setTimeLeft((x) => {
        try {
          localStorage.setItem(TIME_LEFT_KEY, x ? "0" : "1");
        } catch {
          /* ignore */
        }
        return !x;
      }),
    [],
  );
  /** What the scrubber tooltip calls the stretch you're pointing at. */
  const partAt = (t: number) => (sk?.intro && t >= sk.intro[0] && t < sk.intro[1] ? "Intro" : sk?.outro && t >= sk.outro[0] && t < sk.outro[1] ? "Credits" : null);

  const hide = idle && playing && !sheet && !showUpNext && !dragging && !keysOpen;
  const embedHide = isEmbed && idle && !sheet && !keysOpen;
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
        durationSec: dur > 0 ? dur : undefined,
      },
      { signal: ctl.signal },
    )
      .then((res) => {
        if (!ctl.signal.aborted && mountedRef.current) setFetchedSkip(res);
      })
      .catch(() => {});
    return () => ctl.abort();
    // Asked again once the duration is known (rounded, so live duration jitter doesn't refetch):
    // AniSkip matches on episode length, and the first ask happens before metadata arrives.
  }, [cur?.url, isEmbed, cur?.skip?.intro, cur?.skip?.outro, media?.kind, media?.tmdbId, media?.imdbId, media?.malId, epSeason, epNumber, Math.round(dur / 10)]); // eslint-disable-line react-hooks/exhaustive-deps

  const sk = useMemo(() => mergeSkipRanges(cur?.skip, fetchedSkip), [cur?.skip, fetchedSkip]);
  const outroEnd = sk?.outro ? (Number.isFinite(sk.outro[1]) ? sk.outro[1] : (dur > 0 ? dur : Infinity)) : undefined;
  const inIntro = usePlayhead(playhead, (t) => !!sk?.intro && t >= sk.intro[0] && t < sk.intro[1] - 1.5);
  const inOutro = usePlayhead(playhead, (t) => !!sk?.outro && outroEnd != null && t >= sk.outro[0] && t < outroEnd - 1.5);
  const isPrimAss = Boolean(primTrack && (primTrack.format === "ass" || primTrack.format === "ssa") && primTrack.raw);
  // Subtitles toggled off with C: keep handing the overlay the ASS track it was rendering (marked
  // disabled), so it hides the renderer instead of destroying and later reloading its WASM worker.
  const parkedAss = !primTrack && lastActiveSubRef.current?.prim
    ? subTracks.find((t) => t.id === lastActiveSubRef.current?.prim && (t.format === "ass" || t.format === "ssa") && t.raw)
    : undefined;
  const overlayAss = isPrimAss ? primTrack : parkedAss;
  const enhMode = ENHANCE_MODES.find((m) => m.id === enhance) ?? ENHANCE_MODES[0];
  const openSheet = (s: Sheet) => setSheet((x) => (x === s ? null : s));

  const preparing = preparingLocal || preparingTorrent;
  const spinner = showsSpinner({ waiting, failed: !!fatal, isEmbed, hasStarted, playing, preparing });
  const paused = !isEmbed && !playing && !spinner;
  const hasOtherServer = candidates.some((c) => candKey(c) !== activeKey);
  const stage = loadingStage({ recovering, preparingTorrent, preparingLocal, hasStarted, server: cur?.providerName });
  // A connect or rebuffer that drags on offers the next server, rather than leaving you to watch a
  // spinner until the 15-20 s watchdog gives up on its own.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!spinner) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [spinner, activeKey, hasStarted]);

  return (
    <div
      ref={wrap}
      className={`player ${isEmbed ? "is-embed" : ""} ${hide || embedHide ? "idle" : ""} ${isFull ? "is-full" : ""} ${sheet ? "has-sheet" : ""} ${paused ? "is-paused" : ""}`}
      onMouseMove={onPointerActivity}
      onMouseLeave={() => {
        overChromeRef.current = false;
      }}
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
        onClick={(e) => {
          if (sheet) return setSheet(null);
          if (isEmbed) return toggle();
          clearTimeout(clickTimer.current);
          // detail > 1 is the second click of a double click: let onDoubleClick have it.
          if (e.detail > 1) return;
          clickTimer.current = window.setTimeout(toggle, 220);
        }}
        onDoubleClick={() => {
          if (isEmbed) return;
          clearTimeout(clickTimer.current);
          toggleFull();
        }}
        onWheel={onWheelVolume}
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
            {cinemaGlow && <Ambilight video={video} playing={playing} />}
            <video
              ref={video}
              playsInline
              crossOrigin="anonymous"
              className={enhancing === "on" ? "under" : ""}
              onPlay={() => {
                setPlaying(true);
                setEnded(false);
                resumeAudioFx();
              }}
              onPause={() => {
                setPlaying(false);
                // Pausing is often the last thing you do before closing the app.
                if (started.current) saveNow();
              }}
              onWaiting={() => {
                setWaiting(true);
                armStall();
              }}
              onPlaying={(e) => {
                setWaiting(false);
                clearStall();
                started.current = true;
                setHasStarted(true);
                // Belt and braces for the chosen speed: a player library may have reset the rate
                // while attaching (0 is Shaka holding playback for a rebuffer: leave that alone).
                const v = e.currentTarget;
                if (v.playbackRate !== 0 && v.playbackRate !== speedRef.current) v.playbackRate = speedRef.current;
                onPlaying();
              }}
              onCanPlay={() => {
                setWaiting(false);
                if (started.current) clearStall();
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (!draggingRef.current) setTime(v.currentTime);
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
              onSeeking={() => setEnded(false)}
              onEnded={() => {
                const v = video.current;
                if (v) onProgress?.(v.duration, v.duration);
                setEnded(true);
                // "Keep watching" means stay here: don't auto-advance behind the viewer's back.
                if (!upNextDismissedRef.current) onEnded?.();
              }}
              onError={() => {
                // hls.js and Shaka report their own errors. A plain <video> (a file, or HLS played
                // natively) has no one else to notice: without this it sat silent until a 20 s timeout.
                if (cur && cur.kind !== "embed" && !hlsRef.current && !shakaRef.current) failover("unsupported or unreachable stream");
              }}
            />
            <canvas
              key={`${enhance}:${cur?.url ?? ""}`}
              ref={canvas}
              className={`enhance-canvas ${enhancing === "on" ? "on" : ""}`}
              style={comparing ? { clipPath: `inset(0 0 0 ${compareAt}%)` } : undefined}
              aria-hidden
            />
            {comparing && (
              <div className="compare" style={{ ["--at" as string]: `${compareAt}%` }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <span className="compare-tag left">Original</span>
                <span className="compare-tag right">Anime4K</span>
                <div
                  className="compare-handle"
                  role="slider"
                  aria-label="Before and after divider"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(compareAt ?? 50)}
                  tabIndex={0}
                  onPointerDown={onCompareDrag}
                  onPointerMove={onCompareDrag}
                  // Double-click puts the divider back in the middle. It snaps rather than glides: the
                  // split itself is the canvas clip-path above, set from the same number, and must match.
                  onDoubleClick={() => setCompareAt(50)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      setCompareAt((x) => Math.max(2, Math.min(98, (x ?? 50) + (e.key === "ArrowLeft" ? -2 : 2))));
                    }
                  }}
                >
                  <span />
                </div>
              </div>
            )}
            <SubtitleOverlay
              cues={activePrimaryCues}
              secondaryCues={activeSecondaryCues}
              subPref={pref}
              controlsVisible={!(hide || embedHide)}
              videoRef={video}
              assRaw={overlayAss?.raw}
              assFormat={overlayAss?.format}
              offsetSec={offset}
              subEnabled={Boolean(primTrack)}
            />
          </>
        )}
        {spinner && (
          // Before the first frame: a card that says what is loading and from where. A rebuffer
          // mid-film: only the ring and a word, shown after a beat so short stalls don't flash.
          <div className={`pload ${hasStarted && !recovering && !preparing ? "rebuffer" : ""}`} role="status" aria-live="polite">
            <div className="pload-card">
              <span className="pload-ring" aria-hidden />
              <span className="pload-tx">
                <strong>{stage}</strong>
                {!hasStarted && <span className="pload-sub">{[title, subtitle].filter(Boolean).join(" · ")}</span>}
              </span>
              {slow && hasOtherServer && !recovering && (
                <button
                  type="button"
                  className="pload-next"
                  onClick={(e) => {
                    e.stopPropagation();
                    nextServer();
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <Icon name="refresh" size={14} />
                  Try next server
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sits under the chrome but over the iframe, so moving to the top edge wakes the controls. */}
      <div className="ptop-hover-zone" aria-hidden />

      <div className="chrome">
        <header className="ptop">
          <button className="pbtn round" onClick={leave} aria-label="Back" title="Back (Esc)"><Icon name="back" size={20} /></button>
          {onInfo ? (
            <button type="button" className="ptitle ptitle-btn" onClick={goInfo} title="Title details (I)" aria-label={`Open title details for ${title}`}>
              {media?.logo ? <img className="plogo" src={media.logo} alt={title} /> : <div className="pt">{title}</div>}
              <div className="ps">{[subtitle, media?.year].filter(Boolean).join(" · ")}</div>
            </button>
          ) : (
            <div className="ptitle">
              {media?.logo ? <img className="plogo" src={media.logo} alt={title} /> : <div className="pt">{title}</div>}
              <div className="ps">{[subtitle, media?.year].filter(Boolean).join(" · ")}</div>
            </div>
          )}
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
            {onInfo && (
              <button className="pbtn" onClick={goInfo} aria-label="Title details" title="Title details (I)">
                <Icon name="info" size={17} /><span>Info</span>
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
          <div className={`center-controls ${paused && !fatal ? "show" : ""}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <button className="cc-btn" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={26} /></button>
            <button className="cc-btn main" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={34} /></button>
            <button className="cc-btn" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={26} /></button>
          </div>
        )}

        {!isEmbed && (
          <footer className="pbot" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <Scrubber
              ph={playhead}
              dur={dur}
              thumb={thumb}
              dragging={dragging}
              hoverStore={hoverStore}
              intro={sk?.intro}
              outro={sk?.outro}
              scrubRef={scrubRef}
              partAt={partAt}
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              onPointerCancel={onScrubCancel}
              onPointerLeave={onScrubLeave}
            />
            <div className="prow">
              <div className="pc">
                <button className="pbtn round big" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={20} /></button>
                <button className="pbtn icon" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={20} /></button>
                <button className="pbtn icon" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={20} /></button>
                {onNext && <button className="pbtn icon" onClick={goNext} aria-label="Next episode" title="Next episode (N)"><Icon name="next" size={20} /></button>}
                <div className="vol" onWheel={onWheelVolume}>
                  <button className="pbtn icon" onClick={() => toggleMute()} aria-label={muted || vol === 0 ? "Unmute" : "Mute"} title={muted || vol === 0 ? "Unmute (M)" : "Mute (M)"}><Icon name={muted || vol === 0 ? "mute" : "vol"} size={20} /></button>
                  <input
                    type="range"
                    min={0}
                    max={MAX_VOL}
                    step={0.05}
                    value={muted ? 0 : vol}
                    style={{ ["--v" as any]: `${((muted ? 0 : vol) / MAX_VOL) * 100}%`, ["--mark" as any]: `${(1 / MAX_VOL) * 100}%` }}
                    onChange={(e) => setVolumeLevel(Number(e.target.value))}
                    aria-label="Volume"
                  />
                  {!muted && vol > 1.001 && <span className="vol-boost">{Math.round(vol * 100)}%</span>}
                </div>
                <TimeReadout ph={playhead} dur={dur} timeLeft={timeLeft} onToggle={toggleTimeLeft} />
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
                {pipOk && <button className={`pbtn icon ${pipOn ? "on" : ""}`} onClick={() => void togglePip()} aria-label="Picture-in-picture" aria-pressed={pipOn} title="Picture-in-picture (P)"><Icon name="pip" size={20} /></button>}
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
          seconds={ended || !Number.isFinite(remaining) ? 0 : Math.ceil(remaining)}
          auto={!!autoNext}
          onPlay={goNext}
          onDismiss={() => setUpNextDismissed(true)}
        />
      )}

      {fatal && (
        // Every server failed. The toast this used to be faded after 2.6 s and left a black screen:
        // now the ways out stay on screen until one is taken.
        <div className="perr" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="perr-card" role="alert">
            <span className="perr-ic" aria-hidden><Icon name="info" size={22} /></span>
            <strong className="perr-t">{fatal.server ? `${fatal.server} couldn't play this` : "This stream couldn't play"}</strong>
            <p className="perr-d">{friendlyFailure(fatal.why)} {hasOtherServer ? "Another server may have it." : onRetry ? "Looking again may find a server that has it." : ""}</p>
            <code className="perr-why">{fatal.why}</code>
            <div className="perr-acts">
              {hasOtherServer && (
                <button type="button" className="btn play sm" onClick={nextServer} autoFocus>
                  <Icon name="refresh" size={15} /> Try next server
                </button>
              )}
              {onRetry && (
                <button type="button" className={`btn ${hasOtherServer ? "glass" : "play"} sm`} onClick={refreshServerList} autoFocus={!hasOtherServer}>
                  <Icon name="search" size={15} /> Look again
                </button>
              )}
              <button type="button" className="btn glass sm" onClick={() => setSheet("servers")}>
                <Icon name="layers" size={15} /> All servers
              </button>
              {onInfo && (
                <button type="button" className="btn glass sm" onClick={goInfo}>
                  <Icon name="info" size={15} /> Title details
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* inert while closed: off-screen controls must not take focus or be read out. */}
      <aside ref={sheetInd} className={`psheet ${sheet ? "open" : ""}`} aria-hidden={!sheet} {...(sheet ? {} : { inert: "" })}>
        <div className="ps-head">
          <div className="ps-tabs" role="tablist">
            <button role="tab" className={sheet === "servers" ? "on" : ""} onClick={() => setSheet("servers")}>Servers</button>
            {episodes && <button role="tab" className={sheet === "episodes" ? "on" : ""} onClick={() => setSheet("episodes")}>Episodes</button>}
            <button role="tab" className={sheet === "subtitles" ? "on" : ""} onClick={() => setSheet("subtitles")}>Subtitles</button>
            {!isEmbed && <button role="tab" className={sheet === "transcript" ? "on" : ""} onClick={() => setSheet("transcript")}>Transcript</button>}
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
              secondaryOffset={secOffset}
              timingUnsupported={timingShiftUnsupported}
              onNudge={nudge}
              onResetOffset={resetOffset}
              onNudgeSecondary={nudgeSecondary}
              onResetSecondaryOffset={resetSecondaryOffset}
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
              {!isEmbed && (
                <>
                  <div className="ps-block">
                    <div className="ps-label">Volume boost <span className="ps-sub">{muted ? "Muted" : `${Math.round(vol * 100)}%`}</span></div>
                    <div className="seg3 wrap">
                      {[1, 1.25, 1.5, 2].map((lvl) => (
                        <button
                          key={lvl}
                          className={!muted && Math.abs(vol - lvl) < 0.03 ? "on" : ""}
                          onClick={() => {
                            const n = setVolumeLevel(lvl);
                            flash(`Volume ${Math.round(n * 100)}%${n > 1.001 ? " (Boost)" : ""}`, volMeter(n));
                          }}
                        >
                          {Math.round(lvl * 100)}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="ps-block">
                    <div className="ps-label">Sound enhancement</div>
                    <div className="opt-list">
                      <button className={`opt ${audioFx.night ? "on" : ""}`} onClick={() => toggleAudioFx("night")} aria-pressed={audioFx.night}>
                        <span>Night mode</span>
                        <small>Boosts quiet voices and softens sudden loud peaks</small>
                      </button>
                      <button className={`opt ${audioFx.dialogue ? "on" : ""}`} onClick={() => toggleAudioFx("dialogue")} aria-pressed={audioFx.dialogue}>
                        <span>Dialogue boost</span>
                        <small>Lifts vocal clarity above music and background effects</small>
                      </button>
                    </div>
                  </div>
                </>
              )}
              {(isEmbed || (!audio && audioTracks.length === 0)) && (
                <p className="ps-note">
                  {isEmbed
                    ? "Audio tracks and sound enhancements are controlled inside this stream's player."
                    : cur?.kind === "file"
                      ? "Audio is selected by the media engine for this file. If it is silent, its audio codec may not be supported."
                      : "This stream provides a single audio track."}
                </p>
              )}
            </div>
          )}

          {sheet === "transcript" && !isEmbed && (
            <TranscriptSheet
              ph={playhead}
              primary={primTrack ? trackData[primTrack.id]?.cues ?? primTrack.cues : undefined}
              secondary={secTrack ? trackData[secTrack.id]?.cues ?? secTrack.cues : undefined}
              primaryOffset={offset}
              secondaryOffset={secOffset}
              primaryLabel={primTrack?.label}
              secondaryLabel={secTrack?.label}
              onSeek={seekTo}
              onSyncTo={(n) => nudge(n - offsetRef.current)}
            />
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
                    {enhancing === "on" && (
                      <button className={`opt ${comparing ? "on" : ""}`} onClick={() => setCompareAt((x) => (x == null ? 50 : null))}>
                        <span>Before / after</span>
                        <small>{comparing ? "Drag the line across the picture · tap again to hide" : "Split the picture: original on the left, Anime4K on the right"}</small>
                      </button>
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
                  <div className="ps-label">Room</div>
                  <button className={`opt ${cinemaGlow ? "on" : ""}`} onClick={() => updateSettings({ cinemaGlow: !cinemaGlow })} aria-pressed={cinemaGlow}>
                    <span>Cinema glow</span>
                    <small>The black bars around a widescreen or 4:3 picture take the colour of its edges</small>
                  </button>
                </div>
              )}
              {!isEmbed && (
                <div className="ps-block">
                  <div className="ps-label">Sound</div>
                  <div className="opt-list">
                    <button className={`opt ${audioFx.night ? "on" : ""}`} onClick={() => toggleAudioFx("night")} aria-pressed={audioFx.night}>
                      <span>Night mode</span>
                      <small>Evens out loud and quiet scenes, so explosions don't wake the house</small>
                    </button>
                    <button className={`opt ${audioFx.dialogue ? "on" : ""}`} onClick={() => toggleAudioFx("dialogue")} aria-pressed={audioFx.dialogue}>
                      <span>Dialogue boost</span>
                      <small>Lifts voices above music and effects</small>
                    </button>
                  </div>
                </div>
              )}
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
        <div className={`seek-bump ${bump.total > 0 ? "fwd" : "back"} ${bump.again ? "again" : ""}`} key={bump.n} aria-hidden>
          <Icon name={bump.total > 0 ? "fwd" : "rew"} size={22} />
          <span>{bump.total > 0 ? "+" : "−"}{Math.abs(bump.total)}s</span>
        </div>
      )}

      {keysOpen && (
        <div className="pkeys-scrim" onClick={() => setKeysOpen(false)}>
          <div className="pkeys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            {/* Focus moves into the card (it's modal), and lands back on the page when it closes. */}
            <div className="pkeys-h">Keyboard shortcuts <button className="pbtn icon" onClick={() => setKeysOpen(false)} aria-label="Close" autoFocus><Icon name="x" size={16} /></button></div>
            <dl>
              {SHORTCUTS.map(([k, what]) => (
                <div key={k}>
                  {/* "C · Shift+C" -> keycaps, with the separators kept ("/" = either, "·" = and) */}
                  <dt>{k.split(/\s+([/·])\s+/).map((part, i) => (i % 2 ? <i key={i}>{part}</i> : <kbd key={i}>{part}</kbd>))}</dt>
                  <dd>{what}</dd>
                </div>
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

      {toast && (
        <div className={`ptoast ${toast.out ? "out" : ""}`} key={toast.id} role="status" aria-live="polite">
          <i className="dot" />
          {toast.msg}
          {toast.meter && (
            <span className="pt-meter" aria-hidden style={toast.meter.mark != null ? { ["--mark" as string]: `${toast.meter.mark * 100}%` } : undefined}>
              <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, toast.meter.v))})` }} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

