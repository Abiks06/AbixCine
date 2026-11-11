import type Hls from "hls.js";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtTime } from "../lib/format";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";
import { AudioToggle } from "./AudioToggle";
import { SourcePanel, type FailoverEntry } from "./SourcePanel";
import { useSettings, type Audio } from "../lib/settings";
import { playerBus, type PlayerCommand, type PlayerState, type SourceInfo } from "../player/bus";
import { SPEEDS, type PlayerParams } from "../player/params";
import { engineFor, MpvMedia, mpvTarget, skippableChapters, trackLabel, trackLangs, useMpv, type Engine, type MpvChapter, type MpvTrack } from "../player/mpv";
import type { SkipSegment } from "../lib/aniskip";

interface Props {
  candidates: StreamCandidate[];
  /** Told when a source starts playing or dies, so the picker learns. */
  onSourceResult?: (c: StreamCandidate, ok: boolean) => void;
  title: string;
  subtitle?: string;
  startAt?: number;
  onProgress?: (pos: number, dur: number) => void;
  onEnded?: () => void;
  onNext?: () => void;
  onBack: () => void;
  /** Re-run the source search when every candidate has died. */
  onRetry?: () => void;
  /** Count down into the next episode when this one ends. */
  autoplayNext?: boolean;
  nextLabel?: string;
  audio?: Audio;
  onAudio?: (a: Audio) => void;
  media?: { title: string; logo?: string; overview?: string; year?: number; rating?: number; backdrop?: string };
  /** Options from the /watch link: speed, controls, autoplay, muted, subtitle, title. */
  params?: PlayerParams;
  /** Opening / ending / recap times (AniSkip for anime). Chapters marked as such are added automatically. */
  skips?: SkipSegment[];
}

/** What the player needs from whichever engine is drawing: a <video> element or mpv. */
type MediaLike = HTMLVideoElement | MpvMedia;

const info = (c: StreamCandidate | undefined, index: number): SourceInfo | undefined =>
  c && { index, providerId: c.providerId, providerName: c.providerName, label: c.label, quality: c.probe?.quality ?? c.quality, kind: c.kind };

const UP_NEXT_SECS = 8;
const SKIP_LABEL = { op: "Skip intro", ed: "Skip credits", recap: "Skip recap" } as const;

function savedVolume() {
  try {
    const v = Number(localStorage.getItem("abx.vol") ?? 1);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

/** Keep the newest value of a prop in a ref, so long-lived handlers don't go stale or force re-attaches. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

const bufferedEnd = (m: MediaLike) => (m instanceof MpvMedia ? m.bufferedEnd : m.buffered.length ? m.buffered.end(m.buffered.length - 1) : 0);

export function Player({ candidates, onSourceResult, title: catalogTitle, subtitle, startAt, onProgress, onEnded, onNext, onBack, onRetry, autoplayNext, nextLabel, audio, onAudio, media, params, skips }: Props) {
  const title = params?.title ?? catalogTitle;
  const settings = useSettings();
  const mpvInfo = useMpv(settings.mpvPath);
  /** Don't attach anything until we know whether mpv exists, or the first source would attach twice. */
  const engineKnown = mpvInfo !== undefined || !isTauri();
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpvRef = useRef<MpvMedia | null>(null);
  const [mpvObj, setMpvObj] = useState<MpvMedia | null>(null);
  /** Where mpv ended up drawing, once it started (embedding can fall back to its own window). */
  const [mpvMode, setMpvMode] = useState<null | "embedded" | "separate">(null);
  const resumeAt = useRef(startAt ?? 0);
  const [idx, setIdx] = useState(() => Math.max(0, candidates.findIndex((c) => c.probe?.ok !== false)));
  /** Engine forced for a URL after a fallback (built-in couldn't decode it → mpv, or mpv failed → built-in). */
  const [forced, setForced] = useState<Record<string, Engine>>({});
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(savedVolume);
  const [muted, setMuted] = useState(params?.muted ?? false);
  const [speed, setSpeed] = useState(params?.speed ?? 1);
  const [controls, setControls] = useState(params?.controls !== false);
  /** autoplay=0 only holds the first load; after that a switched source carries on playing. */
  const autoplay = useRef(params?.autoplay !== false);
  /** Subtitle tracks: <video> text tracks (built-in) or mpv's track list (mpv, index = track id). */
  const [subs, setSubs] = useState<{ index: number; lang: string; label: string }[]>([]);
  const [sub, setSub] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<MpvTrack[]>([]);
  const [aid, setAid] = useState<number | null>(null);
  const [chapters, setChapters] = useState<MpvChapter[]>([]);
  const wantSub = useRef(params?.sub);
  const [log, setLog] = useState<FailoverEntry[]>([]);
  /** Why the next source change happens, so the sourcechange event can say. */
  const switchWhy = useRef<"user" | "failover" | "command">("user");
  const [waiting, setWaiting] = useState(true);
  const [idle, setIdle] = useState(false);
  const [panel, setPanel] = useState<null | "sources" | "speed">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [levels, setLevels] = useState<{ height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [height, setHeight] = useState(0);
  /** Every source died: show a recovery card instead of an endless spinner. */
  const [failed, setFailed] = useState<string | null>(null);
  /** Episode finished: seconds left on the up-next countdown, or 0 for a plain end card. */
  const [ended, setEnded] = useState<number | null>(null);

  const cur = candidates[idx];
  const engine: Engine = cur ? forced[cur.url] ?? engineFor(cur, settings, mpvInfo) : "html";
  const isMpv = engine === "mpv";
  /** The element/shim currently playing. */
  const m = (): MediaLike | null => (isMpv ? mpvRef.current : video.current);
  const mRef = useLatest(m);
  // Late backup sources change `candidates` while we play; read them through refs so they never
  // re-attach (and rewind) the stream that's already running.
  const candsRef = useLatest(candidates);
  const idxRef = useLatest(idx);
  const resultRef = useLatest(onSourceResult);
  const progressRef = useLatest(onProgress);
  const engineRef = useLatest(engine);
  const curRef = useLatest(cur);

  const toastTimer = useRef<number>();
  const flash = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Try the next candidate when the current one dies, keeping the playhead.
  // Side effects live outside the state updater so StrictMode can't double-count a failure.
  const failover = useCallback((why: string) => {
    const el = mRef.current();
    if (el && el.currentTime > 1) resumeAt.current = el.currentTime;
    const list = candsRef.current;
    const i = idxRef.current;
    if (list[i]) resultRef.current?.(list[i], false);
    const next = list.findIndex((c, j) => j > i && c.probe?.ok !== false);
    const entry: FailoverEntry = { at: resumeAt.current, from: list[i]?.providerName ?? "source", to: list[next]?.providerName, why };
    setLog((l) => [...l.slice(-4), entry]);
    if (next === -1) {
      setWaiting(false);
      setFailed(why);
      playerBus.emit("error", { message: why });
      return;
    }
    flash(`Switched to ${list[next].providerName} (${why})`);
    switchWhy.current = "failover";
    setIdx(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The built-in player choked on this file (codec it can't decode, black picture, silent audio):
   * play the same file with mpv before giving up on the source. Returns false if mpv can't help.
   */
  const settingsRef = useLatest(settings);
  const mpvRefInfo = useLatest(mpvInfo);
  const tryMpv = useCallback((why: string) => {
    const c = curRef.current;
    if (!c || engineRef.current !== "html" || !mpvRefInfo.current || settingsRef.current.engine === "builtin") return false;
    const el = video.current;
    if (el && el.currentTime > 1) resumeAt.current = el.currentTime;
    setForced((f) => (f[c.url] ? f : { ...f, [c.url]: "mpv" }));
    setLog((l) => [...l.slice(-4), { at: resumeAt.current, from: "Built-in player", to: "mpv", why }]);
    flash(`Opening this file in mpv (${why})`);
    return true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const mediaFailed = useCallback((why: string) => (tryMpv(why) ? undefined : failover(why)), [tryMpv, failover]);

  // First frame from a source counts as a successful play (once per source).
  const reported = useRef(new Set<string>());
  const onPlaying = () => {
    if (cur && !reported.current.has(cur.url)) {
      reported.current.add(cur.url);
      onSourceResult?.(cur, true);
    }
  };

  // Tell listeners when the playing source changes (not on the first attach: that's "ready").
  const lastSource = useRef<SourceInfo>();
  useEffect(() => {
    const to = info(candsRef.current[idx], idx);
    if (!to) return;
    if (lastSource.current && lastSource.current.index !== idx) playerBus.emit("sourcechange", { from: lastSource.current, to, reason: switchWhy.current });
    lastSource.current = to;
    switchWhy.current = "user";
  }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  // mpv lives as long as the player does; switching back to the built-in engine or leaving quits it.
  const stopMpv = useCallback(() => {
    const mp = mpvRef.current;
    if (!mp) return;
    if (mp.currentTime > 1) resumeAt.current = mp.currentTime;
    mpvRef.current = null;
    setMpvObj(null);
    setMpvMode(null);
    void mp.destroy();
  }, []);
  useEffect(() => stopMpv, [stopMpv]);

  // Attach the source. Keyed on URL + engine: a new candidates array with the same current source is a no-op.
  const curUrl = cur?.url;
  const curKind = cur?.kind;
  useEffect(() => {
    const v = video.current;
    if (!v || !curUrl || !engineKnown) return;
    const c = curRef.current!;
    setWaiting(true);
    setLevels([]);
    setLevel(-1);
    setHeight(0);
    hlsRef.current?.destroy();
    hlsRef.current = null;
    let cancelled = false;

    if (engine === "mpv") {
      v.pause();
      v.removeAttribute("src");
      v.load();
      setSubs([]);
      let mp = mpvRef.current;
      if (!mp) {
        mp = new MpvMedia();
        mpvRef.current = mp;
        setMpvObj(mp);
      }
      const s = settingsRef.current;
      const first = autoplay.current;
      mp.start({ path: s.mpvPath, embedded: s.mpvWindow === "embedded", hwdec: s.mpvHwdec, ...trackLangs(audio), title: [title, subtitle].filter(Boolean).join(" · ") })
        .then(() => (cancelled ? undefined : mp!.load(mpvTarget(c), resumeAt.current, first)))
        .then(() => {
          if (cancelled) return;
          autoplay.current = true;
          if (!first) setWaiting(false);
        })
        .catch((e) => {
          if (cancelled) return;
          // mpv wouldn't start: the built-in player gets a go, unless it already failed this file.
          if (forced[c.url] === "mpv" || c.needsMpv) failover(`mpv: ${e}`);
          else setForced((f) => ({ ...f, [c.url]: "html" }));
        });
      return () => {
        cancelled = true;
        if (mp && mp.currentTime > 1) resumeAt.current = mp.currentTime;
      };
    }

    stopMpv();
    const seekAndPlay = () => {
      if (resumeAt.current > 0 && resumeAt.current < (v.duration || Infinity) - 5) v.currentTime = resumeAt.current;
      if (autoplay.current) v.play().catch(() => {});
      else setWaiting(false);
      autoplay.current = true;
    };
    const attachHls = (H: typeof Hls) => {
      if (cancelled) return;
      if (!H.isSupported()) {
        v.src = curUrl;
        v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        return;
      }
      const hls = new H({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 60, backBufferLength: 30 });
      hlsRef.current = hls;
      let recoveries = 0;
      hls.on(H.Events.MANIFEST_PARSED, (_, d) => {
        setLevels(d.levels.map((l) => ({ height: l.height })));
        seekAndPlay();
      });
      hls.on(H.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        // Media errors get two local repair attempts, then mpv, then the next source. Never an endless loop.
        if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
          if (recoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
        } else if (d.type === H.ErrorTypes.MEDIA_ERROR) mediaFailed("can't decode");
        else failover(d.details);
      });
      hls.loadSource(curUrl);
      hls.attachMedia(v);
    };
    // hls.js (~600 kB) is only parsed when a stream actually needs it; local files never load it.
    if (curKind === "hls") {
      import("hls.js").then((mod) => attachHls(mod.default), () => failover("player failed to load"));
    } else {
      v.src = curUrl;
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    }
    return () => {
      cancelled = true;
      v.removeEventListener("loadedmetadata", seekAndPlay);
      if (v.currentTime > 1) resumeAt.current = v.currentTime;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [curUrl, curKind, engine, engineKnown, failover, mediaFailed, stopMpv]); // eslint-disable-line react-hooks/exhaustive-deps

  // Engine events. Both engines speak the same event names, so one set of handlers serves both.
  const handlers = useRef<Record<string, () => void>>({});
  handlers.current = {
    play: () => {
      setPlaying(true);
      setEnded(null);
      playerBus.emit("play", { currentTime: m()?.currentTime ?? 0 });
    },
    pause: () => {
      setPlaying(false);
      playerBus.emit("pause", { currentTime: m()?.currentTime ?? 0 });
    },
    waiting: () => {
      setWaiting(true);
      playerBus.emit("buffering", { waiting: true });
    },
    playing: () => {
      setWaiting(false);
      playerBus.emit("buffering", { waiting: false });
      onPlaying();
      // The built-in player sometimes "plays" a file it can't decode: sound with no picture
      // (HEVC) or a picture with no sound (DTS, TrueHD). Catch that and hand the file to mpv.
      const v = video.current;
      if (!isMpv && v && cur?.kind === "file") {
        const url = cur.url;
        window.setTimeout(() => {
          if (video.current !== v || curRef.current?.url !== url || v.paused || v.currentTime < 1) return;
          if (v.videoWidth === 0) mediaFailed("no picture");
          else if ((v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount === 0) mediaFailed("no sound");
        }, 2500);
      }
    },
    loadedmetadata: () => {
      const el = m();
      playerBus.emit("ready", { duration: el?.duration ?? 0, source: info(cur, idx) });
      if (el instanceof MpvMedia) cur?.subtitles?.forEach((t) => el.addSubtitle(t.url, t.label, t.lang));
    },
    canplay: () => setWaiting(false),
    timeupdate: () => {
      const el = m();
      if (!el) return;
      // Quarter-second steps: smooth enough for the scrubber, far fewer re-renders.
      const t = Math.round(el.currentTime * 4) / 4;
      const b = bufferedEnd(el);
      setTime(t);
      setBuffered(b);
      if (t !== time) playerBus.emit("timeupdate", { currentTime: el.currentTime, duration: el.duration, buffered: b });
    },
    durationchange: () => setDur(m()?.duration || 0),
    ended: () => {
      const el = m();
      if (el) onProgress?.(el.duration, el.duration);
      onEnded?.();
      playerBus.emit("ended", { duration: el?.duration ?? dur });
      setEnded(onNext && autoplayNext ? UP_NEXT_SECS : 0);
    },
    error: () => {
      if (isMpv) failover(mpvRef.current?.lastError ?? "mpv error");
      else if (!hlsRef.current) {
        const code = video.current?.error?.code;
        // 3 = decode, 4 = format not supported: mpv can usually play those.
        if (code === 3 || code === 4) mediaFailed("unsupported format");
        else failover("unreachable file");
      }
    },
    tracks: () => {
      const mp = mpvRef.current;
      if (!mp) return;
      const list = mp.tracks.filter((t) => t.type === "sub").map((t) => ({ index: t.id, lang: t.lang ?? "", label: trackLabel(t) }));
      setSubs(list);
      setSub(mp.sid ?? -1);
      setAudioTracks(mp.tracks.filter((t) => t.type === "audio"));
      setAid(mp.aid);
      const want = wantSub.current;
      if (want) {
        wantSub.current = undefined;
        if (want === "off") mp.setSubtitle(null);
        else {
          const hit = list.find((t) => t.lang.toLowerCase().startsWith(want));
          if (hit) mp.setSubtitle(hit.index);
        }
      }
    },
    chapters: () => setChapters(mpvRef.current?.chapters ?? []),
    resize: () => setHeight(mpvRef.current?.videoHeight ?? 0),
    started: () => setMpvMode(mpvRef.current?.embedded ? "embedded" : "separate"),
  };
  useEffect(() => {
    const el: EventTarget | null = isMpv ? mpvObj : video.current;
    if (!el) return;
    const names = Object.keys(handlers.current);
    const fns = names.map((n) => [n, () => handlers.current[n]()] as const);
    fns.forEach(([n, f]) => el.addEventListener(n, f));
    return () => fns.forEach(([n, f]) => el.removeEventListener(n, f));
  }, [isMpv, mpvObj]);

  useEffect(() => {
    const el = m();
    if (!el) return;
    el.volume = vol;
    el.muted = muted;
    el.playbackRate = speed;
    try { localStorage.setItem("abx.vol", String(vol)); } catch { /* ignore */ }
    playerBus.emit("volumechange", { volume: vol, muted });
  }, [vol, muted, speed, isMpv, mpvObj]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void playerBus.emit("ratechange", { rate: speed }), [speed]);

  // Built-in engine subtitles: list the video's text tracks as they appear, and show the one asked for.
  useEffect(() => {
    const v = video.current;
    if (!v || isMpv) return;
    const tracks = v.textTracks;
    const sync = () => {
      const list = Array.from(tracks)
        .map((t, index) => ({ index, lang: t.language, label: t.label || t.language || `Track ${index + 1}`, kind: t.kind }))
        .filter((t) => t.kind === "subtitles" || t.kind === "captions")
        .map(({ kind: _k, ...t }) => t);
      setSubs(list);
      const want = wantSub.current;
      if (want && want !== "off") {
        const hit = list.find((t) => t.lang.toLowerCase().startsWith(want));
        if (hit) {
          wantSub.current = undefined;
          setSub(hit.index);
        }
      }
    };
    sync();
    tracks.addEventListener("addtrack", sync);
    tracks.addEventListener("removetrack", sync);
    return () => {
      tracks.removeEventListener("addtrack", sync);
      tracks.removeEventListener("removetrack", sync);
    };
  }, [curUrl, isMpv]);
  useEffect(() => {
    const v = video.current;
    if (!v || isMpv) return;
    // hls.js watches these modes and switches its own subtitle rendition to match.
    Array.from(v.textTracks).forEach((t, i) => (t.mode = i === sub ? "showing" : "disabled"));
  }, [sub, subs.length, isMpv]);
  useEffect(() => void playerBus.emit("subtitlechange", { index: sub }), [sub]);
  const chooseSub = (i: number) => {
    if (isMpv) mpvRef.current?.setSubtitle(i < 0 ? null : i);
    setSub(i);
  };

  // Report progress every 10s while playing, plus on pause, when the window hides, and on the way out.
  const report = useCallback(() => {
    const el = mRef.current();
    if (el && el.duration && el.currentTime > 0) progressRef.current?.(el.currentTime, el.duration);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => {
      const el = mRef.current();
      if (el && !el.paused) report();
    }, 10_000);
    const onHide = () => document.hidden && report();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onHide);
      report();
    };
  }, [report]); // eslint-disable-line react-hooks/exhaustive-deps

  // Up-next countdown.
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => (ended <= 1 ? onNext?.() : setEnded(ended - 1)), 1000);
    return () => clearTimeout(t);
  }, [ended, onNext]);

  // Auto-hide controls.
  const idleTimer = useRef<number>();
  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600);
  };
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const toggle = () => {
    const el = m();
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };
  const seekTo = (t: number) => {
    const el = m();
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || t, t));
  };
  const seek = (d: number) => {
    const el = m();
    if (!el) return;
    seekTo(el.currentTime + d);
    flash(`${d > 0 ? "+" : ""}${d}s`);
  };

  // Fullscreen: the built-in engine fullscreens the player element; mpv embedded needs the whole
  // window fullscreen so the video window behind it grows too.
  const winFull = useRef(false);
  const toggleFull = (on?: boolean) => {
    if (isMpv && isTauri()) {
      const want = on ?? !isFull;
      winFull.current = want;
      setIsFull(want);
      void getCurrentWindow().setFullscreen(want).catch(() => {});
      return;
    }
    const want = on ?? !document.fullscreenElement;
    if (!want) document.fullscreenElement && document.exitFullscreen().catch(() => {});
    else if (!document.fullscreenElement) wrap.current?.requestFullscreen().catch(() => {});
  };
  useEffect(() => {
    const f = () => setIsFull(!!document.fullscreenElement || winFull.current);
    document.addEventListener("fullscreenchange", f);
    return () => {
      document.removeEventListener("fullscreenchange", f);
      if (winFull.current && isTauri()) void getCurrentWindow().setFullscreen(false).catch(() => {});
    };
  }, []);

  const setQuality = (h: number) => {
    const hl = hlsRef.current;
    if (!hl) return;
    const i = h < 0 ? -1 : levels.findIndex((l) => l.height === h);
    if (h >= 0 && i < 0) return;
    hl.currentLevel = i;
    setLevel(i);
    playerBus.emit("qualitychange", { height: i < 0 ? -1 : levels[i].height });
  };

  // mpv embedded: the page turns see-through where the picture is, so mpv's window behind shows.
  const seeThrough = isMpv && mpvMode === "embedded";
  useEffect(() => {
    document.documentElement.classList.toggle("mpv-on", seeThrough);
    return () => document.documentElement.classList.remove("mpv-on");
  }, [seeThrough]);

  // Skip intro / recap / credits: AniSkip times plus any chapter named like an opening.
  const segments = useMemo(() => [...(skips ?? []), ...skippableChapters(chapters, dur)], [skips, chapters, dur]);
  const activeSkip = segments.find((k) => time >= k.start && time < k.end - 1);
  const autoSkipped = useRef(new Set<number>());
  useEffect(() => {
    if (!activeSkip || !settings.autoSkipIntro || activeSkip.type === "ed" || autoSkipped.current.has(activeSkip.start)) return;
    autoSkipped.current.add(activeSkip.start);
    seekTo(activeSkip.end);
    flash(activeSkip.type === "op" ? "Skipped the intro" : "Skipped the recap");
  }, [activeSkip?.start, settings.autoSkipIntro]); // eslint-disable-line react-hooks/exhaustive-deps
  const skipNow = () => {
    if (!activeSkip) return;
    // Credits at the very end: go straight to the next episode when there is one.
    if (activeSkip.type === "ed" && onNext && dur - activeSkip.end < 30) onNext();
    else seekTo(activeSkip.end);
  };

  // Keyboard shortcuts. The handler lives in a ref so the listener is attached once, not on every timeupdate.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Leave Ctrl/Alt/Win combos (Ctrl+K palette, Alt+Tab…) to the app and the OS.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      poke();
      switch (e.key) {
        case " ": case "k": e.preventDefault(); toggle(); break;
        case "ArrowLeft": seek(-5); break;
        case "ArrowRight": seek(5); break;
        case "j": seek(-10); break;
        case "l": seek(10); break;
        case "ArrowUp": e.preventDefault(); setVol((x) => Math.min(1, +(x + 0.1).toFixed(2))); break;
        case "ArrowDown": e.preventDefault(); setVol((x) => Math.max(0, +(x - 0.1).toFixed(2))); break;
        case "m": setMuted((x) => !x); break;
        case "f": toggleFull(); break;
        case "c": setControls((x) => !x); break;
        case "s": if (activeSkip) skipNow(); break;
        case "n": onNext?.(); break;
        case "Escape":
          if (winFull.current) toggleFull(false);
          else if (!document.fullscreenElement) panel ? setPanel(null) : onBack();
          break;
      }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ambient bleed: a tiny copy of the picture, blurred huge behind the screen, so the frame glows with the scene.
  const bleed = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (isMpv) return; // mpv's frames aren't readable from the page
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      // ~6 fps is plenty for a 64×36 glow; skip entirely while paused or hidden.
      if (t - last < 160) return;
      last = t;
      const v = video.current, c = bleed.current;
      if (!v || !c || v.readyState < 2 || v.paused || document.hidden) return;
      try {
        c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      } catch {
        /* not drawable yet */
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [isMpv]);

  const pct = dur ? (time / dur) * 100 : 0;
  const hide = idle && playing && !panel;
  const q = (isMpv && height) || (cur?.probe?.quality ?? cur?.quality);
  const curLevel = level >= 0 ? levels[level]?.height : undefined;
  const shownQ = curLevel ?? q;
  const switchTo = (i: number, why: "user" | "command" = "user") => {
    const at = m()?.currentTime ?? 0;
    resumeAt.current = at;
    switchWhy.current = why;
    setIdx(i);
    setFailed(null);
    setPanel(null);
    flash(`Switched to ${candidates[i].providerName} at ${fmtTime(at)}`);
  };
  const setEngine = (e: Engine) => {
    if (!cur || e === engine) return;
    resumeAt.current = m()?.currentTime ?? resumeAt.current;
    setForced((f) => ({ ...f, [cur.url]: e }));
    setPanel(null);
    flash(e === "mpv" ? "Switching to mpv" : "Switching to the built-in player");
  };

  // The command bus: other parts of the app (and plugins) drive this player through playerBus.
  const cmdRef = useRef<(c: PlayerCommand) => void>(() => {});
  cmdRef.current = (c) => {
    const el = m();
    if (!el) return;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
    switch (c.type) {
      case "play": void el.play().catch(() => {}); break;
      case "pause": el.pause(); break;
      case "toggle": toggle(); break;
      case "seek": { const t = num(c.time); if (t != null) seekTo(t); break; }
      case "seekBy": { const d = num(c.seconds); if (d != null) seek(d); break; }
      case "setVolume": { const x = num(c.volume); if (x != null) { setMuted(false); setVol(Math.min(1, Math.max(0, x))); } break; }
      case "mute": setMuted((mu) => c.muted ?? !mu); break;
      case "setSpeed": if ((SPEEDS as readonly number[]).includes(c.rate)) setSpeed(c.rate); break;
      case "setProvider": {
        const i = candidates.findIndex((x) => x.providerId === c.provider && x.probe?.ok !== false);
        if (i >= 0 && i !== idx) switchTo(i, "command");
        break;
      }
      case "setSource": if (candidates[c.index] && candidates[c.index].probe?.ok !== false && c.index !== idx) switchTo(c.index, "command"); break;
      case "setSubtitle": if (c.index === -1 || subs.some((t) => t.index === c.index)) chooseSub(c.index); break;
      case "setQuality": { const h = num(c.height); if (h != null) setQuality(h); break; }
      case "fullscreen": toggleFull(c.on); break;
      case "next": onNext?.(); break;
      case "back": onBack(); break;
    }
  };
  const stateRef = useRef<() => PlayerState>(null!);
  stateRef.current = () => {
    const el = m();
    return {
      title,
      subtitle,
      playing,
      waiting,
      currentTime: el?.currentTime ?? time,
      duration: dur,
      buffered,
      volume: vol,
      muted,
      speed,
      source: info(cur, idx),
      sources: candidates.map((c, i) => info(c, i)!),
      subtitles: subs,
      subtitleTrack: sub,
      qualities: levels.map((l) => l.height),
      quality: level >= 0 ? levels[level]?.height ?? -1 : -1,
      engine,
    };
  };
  useEffect(() => playerBus.attach({ run: (c) => cmdRef.current(c), state: () => stateRef.current() }), []);

  const showChrome = controls || !!panel;
  const separate = isMpv && mpvMode === "separate";
  return (
    <div
      ref={wrap}
      className={`player ${hide ? "idle" : ""} ${isFull ? "is-full" : ""} ${showChrome ? "" : "no-controls"} ${isMpv ? "mpv" : ""} ${seeThrough ? "see-through" : ""} ${separate ? "separate" : ""}`}
      onMouseMove={poke}
      onClick={() => panel && setPanel(null)}
    >
      <canvas ref={bleed} className="bleed" width={64} height={36} aria-hidden />
      <div className="screen" onClick={toggle} onDoubleClick={() => toggleFull()}>
        <video ref={video} playsInline>
          {!isMpv && cur?.subtitles?.map((t) => <track key={t.url} kind="subtitles" src={t.url} srcLang={t.lang} label={t.label} />)}
        </video>
        {separate && (
          <div className="mpv-away" style={media?.backdrop ? { backgroundImage: `url(${media.backdrop})` } : undefined}>
            <div className="glass mpv-away-card">
              <Icon name="layers" size={18} /> Playing in mpv's window. These controls still work.
            </div>
          </div>
        )}
        {waiting && <div className="spinner" aria-label="Loading" />}
      </div>
      {toast && <div className="glass toast" key={toast}><i className="dot" />{toast}</div>}

      {activeSkip && !failed && ended === null && (!settings.autoSkipIntro || activeSkip.type === "ed") && (
        <button className="skip-btn glass" onClick={(e) => { e.stopPropagation(); skipNow(); }}>
          {activeSkip.type === "ed" && onNext && dur - activeSkip.end < 30 ? "Next episode" : SKIP_LABEL[activeSkip.type]} <Icon name="next" size={14} />
        </button>
      )}

      {failed && (
        <div className="p-card glass" role="alertdialog" aria-label="Playback failed" onClick={(e) => e.stopPropagation()}>
          <h3>Couldn't play this</h3>
          <p className="muted">Every source stalled or refused ({failed}). Your place is saved at {fmtTime(resumeAt.current)}.</p>
          {!mpvInfo && isTauri() && <p className="muted">Installing mpv lets AbixCine play almost any file. See Settings → Playback.</p>}
          <div className="acts">
            {onRetry && <button className="btn play" onClick={onRetry} autoFocus><Icon name="play" size={16} /> Search sources again</button>}
            {candidates.length > 1 && <button className="btn glass" onClick={() => setPanel("sources")}><Icon name="layers" size={16} /> Choose a source</button>}
            <button className="btn glass" onClick={onBack}><Icon name="back" size={16} /> Back</button>
          </div>
        </div>
      )}
      {ended !== null && !failed && (
        <div className="p-card glass up-next" role="dialog" aria-label={onNext ? "Up next" : "Finished"} onClick={(e) => e.stopPropagation()}>
          {onNext ? (
            <>
              <div className="eyebrow">Up next{ended > 0 ? ` in ${ended}s` : ""}</div>
              <h3>{nextLabel ?? "Next episode"}</h3>
              {ended > 0 && <div className="upnext-bar" style={{ ["--d" as string]: `${UP_NEXT_SECS}s` }}><i /></div>}
              <div className="acts">
                <button className="btn play" onClick={onNext} autoFocus><Icon name="next" size={16} /> Play now</button>
                {ended > 0 ? (
                  <button className="btn glass" onClick={() => setEnded(0)}>Cancel</button>
                ) : (
                  <button className="btn glass" onClick={onBack}><Icon name="back" size={16} /> Back</button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">Finished</div>
              <h3>{title}</h3>
              <div className="acts">
                <button className="btn play" onClick={() => { seekTo(0); void m()?.play().catch(() => {}); setEnded(null); }} autoFocus><Icon name="replay10" size={16} /> Watch again</button>
                <button className="btn glass" onClick={onBack}><Icon name="back" size={16} /> Back</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="chrome">
        <div className="ptop">
          <button className="cb glassy" onClick={onBack} aria-label="Back"><Icon name="back" size={20} /></button>
          <div className="ptitle">
            <div className="pt">{title}</div>
            <div className="ps">{[subtitle, media?.year].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="pop-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="status src-btn" onClick={() => setPanel(panel === "sources" ? null : "sources")}>
              <Icon name="layers" size={14} />
              {log.length > 0 && <i className="dot warn" aria-label="Switched source" />}
              <span>{cur?.providerName}{q ? ` · ${q}p` : ""}{isMpv ? " · mpv" : ""}{cur?.probe?.latencyMs ? ` · ${cur.probe.latencyMs} ms` : ""}</span>
            </button>
            {panel === "sources" && <SourcePanel candidates={candidates} idx={idx} onPick={(i) => switchTo(i)} log={log} />}
          </div>
        </div>

        <div className={`center-controls ${playing && !waiting ? "" : "show"}`} onClick={(e) => e.stopPropagation()}>
          <button className="cc-btn" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={28} /><small>10</small></button>
          <button className="cc-btn main" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={34} /></button>
          <button className="cc-btn" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={28} /><small>10</small></button>
        </div>

        <div className="pbot" onClick={(e) => e.stopPropagation()}>
          <div
            className="scrub"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              seekTo(((e.clientX - r.left) / r.width) * dur);
            }}
          >
            <div className="c">
              <span className="buf" style={{ transform: `scaleX(${dur ? buffered / dur : 0})` }} />
              <i style={{ transform: `scaleX(${pct / 100})` }} />
              {dur > 0 && segments.map((k) => <b key={k.start} className="seg" style={{ left: `${(k.start / dur) * 100}%`, width: `${((k.end - k.start) / dur) * 100}%` }} />)}
            </div>
            <span className="knob" style={{ left: `${pct}%` }} />
          </div>
          <div className="prow">
            <div className="pc">
              <button className="cb big" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={20} /></button>
              <button className="cb" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={20} /></button>
              <button className="cb" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={20} /></button>
              {onNext && <button className="cb" onClick={onNext} aria-label="Next episode"><Icon name="next" size={20} /></button>}
              <div className="vol">
                <button className="cb" onClick={() => setMuted((mu) => !mu)} aria-label="Mute"><Icon name={muted || vol === 0 ? "mute" : "vol"} size={20} /></button>
                <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : vol} style={{ ["--v" as any]: `${(muted ? 0 : vol) * 100}%` }} onChange={(e) => { setMuted(false); setVol(Number(e.target.value)); }} aria-label="Volume" />
              </div>
              <span className="time">{fmtTime(time)} / {fmtTime(dur)}<em>−{fmtTime(dur - time)}</em></span>
            </div>
            <div className="pc">
              {audio && onAudio && (
                <AudioToggle
                  compact
                  value={audio}
                  onChange={(a) => {
                    // Save the playhead first so the other track resumes at the same moment.
                    const el = m();
                    if (el?.duration) onProgress?.(el.currentTime, el.duration);
                    onAudio(a);
                  }}
                />
              )}
              <div className="pop-wrap">
                <button className="pp" onClick={() => setPanel(panel === "speed" ? null : "speed")}>
                  {shownQ ? <span className={`q ${shownQ >= 2160 ? "" : "hd"}`}>{shownQ >= 2160 ? "4K" : shownQ >= 720 ? "HD" : "SD"}</span> : null}
                  {shownQ ? `${shownQ}p` : "Auto"}{speed !== 1 ? ` · ${speed}×` : ""}
                </button>
                {panel === "speed" && (
                  <div className="glass menu set-menu">
                    <div className="menu-sep">Speed</div>
                    <div className="menu-chips">
                      {SPEEDS.map((sp) => <button key={sp} className={sp === speed ? "on" : ""} onClick={() => { setSpeed(sp); setPanel(null); }}>{sp}×</button>)}
                    </div>
                    {levels.length > 1 && (
                      <>
                        <div className="menu-sep">Quality</div>
                        <div className="menu-chips">
                          <button className={level === -1 ? "on" : ""} onClick={() => { setQuality(-1); setPanel(null); }}>Auto</button>
                          {levels.map((l, i) => <button key={i} className={level === i ? "on" : ""} onClick={() => { setQuality(l.height); setPanel(null); }}>{l.height}p</button>)}
                        </div>
                      </>
                    )}
                    {audioTracks.length > 1 && (
                      <>
                        <div className="menu-sep">Audio track</div>
                        <div className="menu-chips">
                          {audioTracks.map((t) => <button key={t.id} className={aid === t.id ? "on" : ""} onClick={() => { mpvRef.current?.setAudio(t.id); setPanel(null); }}>{trackLabel(t)}</button>)}
                        </div>
                      </>
                    )}
                    {subs.length > 0 && (
                      <>
                        <div className="menu-sep">Subtitles</div>
                        <div className="menu-chips">
                          <button className={sub === -1 ? "on" : ""} onClick={() => { chooseSub(-1); setPanel(null); }}>Off</button>
                          {subs.map((t) => <button key={t.index} className={sub === t.index ? "on" : ""} onClick={() => { chooseSub(t.index); setPanel(null); }}>{t.label}</button>)}
                        </div>
                      </>
                    )}
                    {mpvInfo && (
                      <>
                        <div className="menu-sep">Player</div>
                        <div className="menu-chips">
                          <button className={!isMpv ? "on" : ""} onClick={() => setEngine("html")}>Built-in</button>
                          <button className={isMpv ? "on" : ""} onClick={() => setEngine("mpv")}>mpv</button>
                        </div>
                      </>
                    )}
                    <div className="menu-sep">Controls</div>
                    <div className="menu-chips">
                      <button onClick={() => { setControls(false); setPanel(null); flash("Controls hidden · press C to bring them back"); }}>Hide bar (C)</button>
                    </div>
                  </div>
                )}
              </div>
              <button className="cb" onClick={() => toggleFull()} aria-label="Fullscreen"><Icon name={isFull ? "unfull" : "full"} size={20} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
