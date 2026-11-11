import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "../lib/format";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";
import { AudioToggle } from "./AudioToggle";
import { SourcePanel, type FailoverEntry } from "./SourcePanel";
import type { Audio } from "../lib/settings";
import { playerBus, type PlayerCommand, type PlayerState, type SourceInfo } from "../player/bus";
import { SPEEDS, type PlayerParams } from "../player/params";

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
  media?: { title: string; logo?: string; overview?: string; year?: number; rating?: number };
  /** Options from the /watch link: speed, controls, autoplay, muted, subtitle, title. */
  params?: PlayerParams;
}

const info = (c: StreamCandidate | undefined, index: number): SourceInfo | undefined =>
  c && { index, providerId: c.providerId, providerName: c.providerName, label: c.label, quality: c.probe?.quality ?? c.quality, kind: c.kind };

const UP_NEXT_SECS = 8;

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

export function Player({ candidates, onSourceResult, title: catalogTitle, subtitle, startAt, onProgress, onEnded, onNext, onBack, onRetry, autoplayNext, nextLabel, audio, onAudio, media, params }: Props) {
  const title = params?.title ?? catalogTitle;
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const resumeAt = useRef(startAt ?? 0);
  const [idx, setIdx] = useState(() => Math.max(0, candidates.findIndex((c) => c.probe?.ok !== false)));
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
  /** Text tracks the <video> exposes (sidecar files from the source, or HLS subtitle renditions). */
  const [subs, setSubs] = useState<{ index: number; lang: string; label: string }[]>([]);
  const [sub, setSub] = useState(-1);
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
  /** Every source died: show a recovery card instead of an endless spinner. */
  const [failed, setFailed] = useState<string | null>(null);
  /** Episode finished: seconds left on the up-next countdown, or 0 for a plain end card. */
  const [ended, setEnded] = useState<number | null>(null);

  const cur = candidates[idx];
  // Late backup sources change `candidates` while we play; read them through refs so they never
  // re-attach (and rewind) the stream that's already running.
  const candsRef = useLatest(candidates);
  const idxRef = useLatest(idx);
  const resultRef = useLatest(onSourceResult);
  const progressRef = useLatest(onProgress);

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
    const v = video.current;
    if (v && v.currentTime > 1) resumeAt.current = v.currentTime;
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

  // Attach the source. Keyed on the URL only: a new candidates array with the same current source is a no-op.
  const curUrl = cur?.url;
  const curKind = cur?.kind;
  useEffect(() => {
    const v = video.current;
    if (!v || !curUrl) return;
    setWaiting(true);
    setLevels([]);
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const seekAndPlay = () => {
      if (resumeAt.current > 0 && resumeAt.current < (v.duration || Infinity) - 5) v.currentTime = resumeAt.current;
      if (autoplay.current) v.play().catch(() => {});
      else setWaiting(false);
      autoplay.current = true;
    };
    let cancelled = false;
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
        // Media errors get two local repair attempts, then the next source. Never an endless loop.
        if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
          if (recoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
        } else failover(d.details);
      });
      hls.loadSource(curUrl);
      hls.attachMedia(v);
    };
    // hls.js (~600 kB) is only parsed when a stream actually needs it; local files never load it.
    if (curKind === "hls") {
      import("hls.js").then((m) => attachHls(m.default), () => failover("player failed to load"));
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
  }, [curUrl, curKind, failover]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = vol;
    v.muted = muted;
    v.playbackRate = speed;
    try { localStorage.setItem("abx.vol", String(vol)); } catch { /* ignore */ }
    playerBus.emit("volumechange", { volume: vol, muted });
  }, [vol, muted, speed]);
  useEffect(() => void playerBus.emit("ratechange", { rate: speed }), [speed]);

  // Subtitles: list the video's text tracks as they appear, and show the one asked for.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
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
  }, [curUrl]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // hls.js watches these modes and switches its own subtitle rendition to match.
    Array.from(v.textTracks).forEach((t, i) => (t.mode = i === sub ? "showing" : "disabled"));
  }, [sub, subs.length]);
  useEffect(() => void playerBus.emit("subtitlechange", { index: sub }), [sub]);

  // Report progress every 10s while playing, plus on pause, when the window hides, and on the way out.
  const report = useCallback(() => {
    const v = video.current;
    if (v && v.duration && v.currentTime > 0) progressRef.current?.(v.currentTime, v.duration);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => {
      if (video.current && !video.current.paused) report();
    }, 10_000);
    const onHide = () => document.hidden && report();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onHide);
      report();
    };
  }, [report]);

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
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const seek = (d: number) => {
    const v = video.current!;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d));
    flash(`${d > 0 ? "+" : ""}${d}s`);
  };
  const toggleFull = (on = !document.fullscreenElement) => {
    if (!on) document.fullscreenElement && document.exitFullscreen().catch(() => {});
    else if (!document.fullscreenElement) wrap.current?.requestFullscreen().catch(() => {});
  };
  const setQuality = (height: number) => {
    const h = hlsRef.current;
    if (!h) return;
    const i = height < 0 ? -1 : levels.findIndex((l) => l.height === height);
    if (height >= 0 && i < 0) return;
    h.currentLevel = i;
    setLevel(i);
    playerBus.emit("qualitychange", { height: i < 0 ? -1 : levels[i].height });
  };
  useEffect(() => {
    const f = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

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
        case "n": onNext?.(); break;
        case "Escape": if (!document.fullscreenElement) panel ? setPanel(null) : onBack(); break;
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
  }, []);

  const pct = dur ? (time / dur) * 100 : 0;
  const hide = idle && playing && !panel;
  const q = cur?.probe?.quality ?? cur?.quality;
  const curLevel = level >= 0 ? levels[level]?.height : undefined;
  const shownQ = curLevel ?? q;
  const switchTo = (i: number, why: "user" | "command" = "user") => {
    const v = video.current;
    resumeAt.current = v?.currentTime ?? 0;
    switchWhy.current = why;
    setIdx(i);
    setFailed(null);
    setPanel(null);
    flash(`Switched to ${candidates[i].providerName} at ${fmtTime(v?.currentTime ?? 0)}`);
  };

  // The command bus: other parts of the app (and plugins) drive this player through playerBus.
  const cmdRef = useRef<(c: PlayerCommand) => void>(() => {});
  cmdRef.current = (c) => {
    const v = video.current;
    if (!v) return;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
    switch (c.type) {
      case "play": v.play().catch(() => {}); break;
      case "pause": v.pause(); break;
      case "toggle": toggle(); break;
      case "seek": { const t = num(c.time); if (t != null) v.currentTime = Math.max(0, Math.min(v.duration || t, t)); break; }
      case "seekBy": { const d = num(c.seconds); if (d != null) seek(d); break; }
      case "setVolume": { const x = num(c.volume); if (x != null) { setMuted(false); setVol(Math.min(1, Math.max(0, x))); } break; }
      case "mute": setMuted((m) => c.muted ?? !m); break;
      case "setSpeed": if ((SPEEDS as readonly number[]).includes(c.rate)) setSpeed(c.rate); break;
      case "setProvider": {
        const i = candidates.findIndex((x) => x.providerId === c.provider && x.probe?.ok !== false);
        if (i >= 0 && i !== idx) switchTo(i, "command");
        break;
      }
      case "setSource": if (candidates[c.index] && candidates[c.index].probe?.ok !== false && c.index !== idx) switchTo(c.index, "command"); break;
      case "setSubtitle": if (c.index === -1 || subs.some((t) => t.index === c.index)) setSub(c.index); break;
      case "setQuality": { const h = num(c.height); if (h != null) setQuality(h); break; }
      case "fullscreen": toggleFull(c.on); break;
      case "next": onNext?.(); break;
      case "back": onBack(); break;
    }
  };
  const stateRef = useRef<() => PlayerState>(null!);
  stateRef.current = () => {
    const v = video.current;
    return {
      title,
      subtitle,
      playing,
      waiting,
      currentTime: v?.currentTime ?? time,
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
    };
  };
  useEffect(() => playerBus.attach({ run: (c) => cmdRef.current(c), state: () => stateRef.current() }), []);

  const showChrome = controls || !!panel;
  return (
    <div ref={wrap} className={`player ${hide ? "idle" : ""} ${isFull ? "is-full" : ""} ${showChrome ? "" : "no-controls"}`} onMouseMove={poke} onClick={() => panel && setPanel(null)}>
      <canvas ref={bleed} className="bleed" width={64} height={36} aria-hidden />
      <div className="screen">
        <video
          ref={video}
          playsInline
          onClick={toggle}
          onDoubleClick={() => toggleFull()}
          onPlay={(e) => {
            setPlaying(true);
            setEnded(null);
            playerBus.emit("play", { currentTime: e.currentTarget.currentTime });
          }}
          onPause={(e) => {
            setPlaying(false);
            playerBus.emit("pause", { currentTime: e.currentTarget.currentTime });
          }}
          onWaiting={() => {
            setWaiting(true);
            playerBus.emit("buffering", { waiting: true });
          }}
          onPlaying={() => {
            setWaiting(false);
            playerBus.emit("buffering", { waiting: false });
            onPlaying();
          }}
          onLoadedMetadata={(e) => playerBus.emit("ready", { duration: e.currentTarget.duration, source: info(cur, idx) })}
          onCanPlay={() => setWaiting(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            // Quarter-second steps: smooth enough for the scrubber, far fewer re-renders.
            const t = Math.round(v.currentTime * 4) / 4;
            const b = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
            setTime(t);
            setBuffered(b);
            if (t !== time) playerBus.emit("timeupdate", { currentTime: v.currentTime, duration: v.duration, buffered: b });
          }}
          onDurationChange={(e) => setDur(e.currentTarget.duration)}
          onEnded={() => {
            const v = video.current;
            if (v) onProgress?.(v.duration, v.duration);
            onEnded?.();
            playerBus.emit("ended", { duration: v?.duration ?? dur });
            setEnded(onNext && autoplayNext ? UP_NEXT_SECS : 0);
          }}
          onError={() => !hlsRef.current && failover("unsupported or unreachable file")}
        >
          {cur?.subtitles?.map((t) => <track key={t.url} kind="subtitles" src={t.url} srcLang={t.lang} label={t.label} />)}
        </video>
        {waiting && <div className="spinner" aria-label="Loading" />}
      </div>
      {toast && <div className="glass toast" key={toast}><i className="dot" />{toast}</div>}

      {failed && (
        <div className="p-card glass" role="alertdialog" aria-label="Playback failed" onClick={(e) => e.stopPropagation()}>
          <h3>Couldn't play this</h3>
          <p className="muted">Every source stalled or refused ({failed}). Your place is saved at {fmtTime(resumeAt.current)}.</p>
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
                <button className="btn play" onClick={() => { const v = video.current; if (v) { v.currentTime = 0; v.play().catch(() => {}); } setEnded(null); }} autoFocus><Icon name="replay10" size={16} /> Watch again</button>
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
              <span>{cur?.providerName}{q ? ` · ${q}p` : ""}{cur?.probe?.latencyMs ? ` · ${cur.probe.latencyMs} ms` : ""}</span>
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
              video.current!.currentTime = ((e.clientX - r.left) / r.width) * dur;
            }}
          >
            <div className="c">
              <span className="buf" style={{ transform: `scaleX(${dur ? buffered / dur : 0})` }} />
              <i style={{ transform: `scaleX(${pct / 100})` }} />
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
                <button className="cb" onClick={() => setMuted((m) => !m)} aria-label="Mute"><Icon name={muted || vol === 0 ? "mute" : "vol"} size={20} /></button>
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
                    const v = video.current;
                    if (v?.duration) onProgress?.(v.currentTime, v.duration);
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
                    {subs.length > 0 && (
                      <>
                        <div className="menu-sep">Subtitles</div>
                        <div className="menu-chips">
                          <button className={sub === -1 ? "on" : ""} onClick={() => { setSub(-1); setPanel(null); }}>Off</button>
                          {subs.map((t) => <button key={t.index} className={sub === t.index ? "on" : ""} onClick={() => { setSub(t.index); setPanel(null); }}>{t.label}</button>)}
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
