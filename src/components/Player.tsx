import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "../lib/format";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";
import { AudioToggle } from "./AudioToggle";
import type { Audio } from "../lib/settings";

interface Props {
  candidates: StreamCandidate[];
  title: string;
  subtitle?: string;
  startAt?: number;
  onProgress?: (pos: number, dur: number) => void;
  onEnded?: () => void;
  onNext?: () => void;
  onBack: () => void;
  audio?: Audio;
  onAudio?: (a: Audio) => void;
  media?: { title: string; logo?: string; overview?: string; year?: number; rating?: number };
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function Player({ candidates, title, subtitle, startAt, onProgress, onEnded, onNext, onBack, audio, onAudio, media }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const resumeAt = useRef(startAt ?? 0);
  const [idx, setIdx] = useState(() => Math.max(0, candidates.findIndex((c) => c.probe?.ok !== false)));
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(() => Number(localStorage.getItem("abx.vol") ?? 1));
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [waiting, setWaiting] = useState(true);
  const [idle, setIdle] = useState(false);
  const [panel, setPanel] = useState<null | "sources" | "speed">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [levels, setLevels] = useState<{ height: number }[]>([]);
  const [level, setLevel] = useState(-1);

  const cur = candidates[idx];

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  };

  // Try the next candidate when the current one dies, keeping the playhead.
  const failover = useCallback(
    (why: string) => {
      const v = video.current;
      if (v && v.currentTime > 1) resumeAt.current = v.currentTime;
      setIdx((i) => {
        const next = candidates.findIndex((c, j) => j > i && c.probe?.ok !== false);
        if (next === -1) {
          flash(`Playback failed: ${why}`);
          return i;
        }
        flash(`Switched to ${candidates[next].providerName} (${why})`);
        return next;
      });
    },
    [candidates],
  );

  // Attach the source.
  useEffect(() => {
    const v = video.current;
    if (!v || !cur) return;
    setWaiting(true);
    setLevels([]);
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const seekAndPlay = () => {
      if (resumeAt.current > 0 && resumeAt.current < (v.duration || Infinity) - 5) v.currentTime = resumeAt.current;
      v.play().catch(() => {});
    };
    if (cur.kind === "hls" && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 60, backBufferLength: 30 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
        setLevels(d.levels.map((l) => ({ height: l.height })));
        seekAndPlay();
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else failover(d.details);
      });
      hls.loadSource(cur.url);
      hls.attachMedia(v);
    } else {
      v.src = cur.url;
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    }
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [cur, failover]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = vol;
    v.muted = muted;
    v.playbackRate = speed;
    try { localStorage.setItem("abx.vol", String(vol)); } catch { /* ignore */ }
  }, [vol, muted, speed]);

  // Report progress every 5s.
  useEffect(() => {
    const t = setInterval(() => {
      const v = video.current;
      if (v && v.duration && !v.paused) onProgress?.(v.currentTime, v.duration);
    }, 5000);
    return () => clearInterval(t);
  }, [onProgress]);

  // Auto-hide controls.
  const idleTimer = useRef<number>();
  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600);
  };
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const toggle = () => {
    const v = video.current!;
    v.paused ? v.play() : v.pause();
  };
  const seek = (d: number) => {
    const v = video.current!;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d));
    flash(`${d > 0 ? "+" : ""}${d}s`);
  };
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.current?.requestFullscreen();
  };
  useEffect(() => {
    const f = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
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
        case "n": onNext?.(); break;
        case "Escape": if (!document.fullscreenElement) panel ? setPanel(null) : onBack(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pct = dur ? (time / dur) * 100 : 0;
  const hide = idle && playing && !panel;

  return (
    <div ref={wrap} className={`player ${hide ? "idle" : ""}`} onMouseMove={poke} onClick={() => panel && setPanel(null)}>
      <video
        ref={video}
        playsInline
        onClick={toggle}
        onDoubleClick={toggleFull}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setTime(v.currentTime);
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        }}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => { const v = video.current; if (v) onProgress?.(v.duration, v.duration); onEnded?.(); }}
        onError={() => cur?.kind === "file" && failover("unsupported or unreachable file")}
      />

      {waiting && <div className="spinner" aria-label="Loading" />}
      {toast && <div className="player-toast">{toast}</div>}

      <div className="player-top">
        <button className="icon-btn lg" onClick={onBack} aria-label="Back"><Icon name="back" size={22} /></button>
        <div>
          <div className="player-title">{title}</div>
          {subtitle && <div className="player-sub">{subtitle}</div>}
        </div>
        <div className="grow" />
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
        <span className="source-pill">{cur?.providerName}{cur?.probe?.quality || cur?.quality ? ` · ${cur.probe?.quality ?? cur.quality}p` : ""}</span>
      </div>

      <div className={`center-controls ${playing && !waiting ? "" : "show"}`} onClick={(e) => e.stopPropagation()}>
        <button className="cc-btn" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="replay10" size={30} /><small>10</small></button>
        <button className="cc-btn main" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={38} /></button>
        <button className="cc-btn" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd10" size={30} /><small>10</small></button>
      </div>

      {media && (
        <div className="player-info">
          {media.logo ? <img className="title-logo sm" src={media.logo} alt={media.title} /> : <div className="title-type sm">{media.title}</div>}
          {subtitle && <span className="sec-eyebrow">{subtitle}</span>}
          <span className="muted">{[media.year, media.rating && `${media.rating.toFixed(1)} ★`].filter(Boolean).join(" · ")}</span>
          {media.overview && <p>{media.overview}</p>}
        </div>
      )}

      <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
        <div
          className="scrub"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            video.current!.currentTime = ((e.clientX - r.left) / r.width) * dur;
          }}
        >
          <div className="scrub-buf" style={{ width: `${dur ? (buffered / dur) * 100 : 0}%` }} />
          <div className="scrub-fill" style={{ width: `${pct}%` }} />
          <div className="scrub-knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="controls">
          <button className="icon-btn lg" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={24} /></button>
          <button className="icon-btn" onClick={() => seek(-10)} aria-label="Back 10 seconds"><Icon name="rew" /></button>
          <button className="icon-btn" onClick={() => seek(10)} aria-label="Forward 10 seconds"><Icon name="fwd" /></button>
          {onNext && <button className="icon-btn" onClick={onNext} aria-label="Next episode"><Icon name="next" /></button>}
          <div className="vol">
            <button className="icon-btn" onClick={() => setMuted((m) => !m)} aria-label="Mute"><Icon name={muted || vol === 0 ? "mute" : "vol"} /></button>
            <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : vol} onChange={(e) => { setMuted(false); setVol(Number(e.target.value)); }} aria-label="Volume" />
          </div>
          <span className="time">{fmtTime(time)} <i>/</i> {fmtTime(dur)} <em>-{fmtTime(dur - time)}</em></span>
          <div className="grow" />
          <div className="pop-wrap">
            <button className="chip" onClick={() => setPanel(panel === "speed" ? null : "speed")}>{speed}×</button>
            {panel === "speed" && (
              <div className="pop">
                {SPEEDS.map((s) => <button key={s} className={s === speed ? "on" : ""} onClick={() => { setSpeed(s); setPanel(null); }}>{s}×</button>)}
                {levels.length > 1 && <div className="pop-sep">Quality</div>}
                {levels.length > 1 && (
                  <>
                    <button className={level === -1 ? "on" : ""} onClick={() => { hlsRef.current!.currentLevel = -1; setLevel(-1); }}>Auto</button>
                    {levels.map((l, i) => <button key={i} className={level === i ? "on" : ""} onClick={() => { hlsRef.current!.currentLevel = i; setLevel(i); }}>{l.height}p</button>)}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="pop-wrap">
            <button className="icon-btn" onClick={() => setPanel(panel === "sources" ? null : "sources")} aria-label="Sources"><Icon name="layers" /></button>
            {panel === "sources" && (
              <div className="pop pop-sources">
                <div className="pop-sep">Sources, best first</div>
                {candidates.map((c, i) => (
                  <button key={c.url} className={i === idx ? "on" : ""} disabled={c.probe?.ok === false} onClick={() => { resumeAt.current = video.current?.currentTime ?? 0; setIdx(i); setPanel(null); }}>
                    <span className="src-name">{c.providerName}<small>{c.label}</small></span>
                    <span className="src-meta">
                      {c.probe?.ok === false
                        ? "offline"
                        : [c.probe?.quality ?? c.quality ? `${c.probe?.quality ?? c.quality}p` : null, c.probe?.latencyMs ? `${c.probe.latencyMs} ms` : null].filter(Boolean).join(" · ") || "ready"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={toggleFull} aria-label="Fullscreen"><Icon name={isFull ? "unfull" : "full"} /></button>
        </div>
      </div>
    </div>
  );
}
