import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "../lib/format";
import { candLine } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";
import { AudioToggle } from "./AudioToggle";
import type { Audio } from "../lib/settings";

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
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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

export function Player({ candidates, onSourceResult, title, subtitle, startAt, onProgress, onEnded, onNext, onBack, onRetry, autoplayNext, nextLabel, audio, onAudio, media }: Props) {
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
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
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
    if (next === -1) {
      setWaiting(false);
      setFailed(why);
      return;
    }
    flash(`Switched to ${list[next].providerName} (${why})`);
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
      v.play().catch(() => {});
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
  }, [vol, muted, speed]);

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
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrap.current?.requestFullscreen().catch(() => {});
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
  const switchTo = (i: number) => {
    const v = video.current;
    resumeAt.current = v?.currentTime ?? 0;
    setIdx(i);
    setFailed(null);
    setPanel(null);
    flash(`Switched to ${candidates[i].providerName} at ${fmtTime(v?.currentTime ?? 0)}`);
  };

  return (
    <div ref={wrap} className={`player ${hide ? "idle" : ""} ${isFull ? "is-full" : ""}`} onMouseMove={poke} onClick={() => panel && setPanel(null)}>
      <canvas ref={bleed} className="bleed" width={64} height={36} aria-hidden />
      <div className="screen">
        <video
          ref={video}
          playsInline
          onClick={toggle}
          onDoubleClick={toggleFull}
          onPlay={() => {
            setPlaying(true);
            setEnded(null);
          }}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => {
            setWaiting(false);
            onPlaying();
          }}
          onCanPlay={() => setWaiting(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            // Quarter-second steps: smooth enough for the scrubber, far fewer re-renders.
            setTime(Math.round(v.currentTime * 4) / 4);
            if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
          }}
          onDurationChange={(e) => setDur(e.currentTarget.duration)}
          onEnded={() => {
            const v = video.current;
            if (v) onProgress?.(v.duration, v.duration);
            onEnded?.();
            setEnded(onNext && autoplayNext ? UP_NEXT_SECS : 0);
          }}
          onError={() => !hlsRef.current && failover("unsupported or unreachable file")}
        />
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
              <span>{cur?.providerName}{q ? ` · ${q}p` : ""}{cur?.probe?.latencyMs ? ` · ${cur.probe.latencyMs} ms` : ""}</span>
            </button>
            {panel === "sources" && (
              <div className="glass menu src-menu">
                {candidates.map((c, i) => (
                  <button key={c.url} className={i === idx ? "on" : ""} disabled={c.probe?.ok === false} onClick={() => i !== idx && switchTo(i)}>
                    <span className="src-name">{c.providerName}</span>
                    <small>{i === idx ? "NOW" : i === 0 ? "AUTO PICK" : "BACKUP"}</small>
                    <small className="src-file">{c.label}</small>
                    <small>{candLine(c) || "ready"}{c.why?.length ? ` · ${c.why[0]}` : ""}</small>
                  </button>
                ))}
              </div>
            )}
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
                          <button className={level === -1 ? "on" : ""} onClick={() => { hlsRef.current!.currentLevel = -1; setLevel(-1); setPanel(null); }}>Auto</button>
                          {levels.map((l, i) => <button key={i} className={level === i ? "on" : ""} onClick={() => { hlsRef.current!.currentLevel = i; setLevel(i); setPanel(null); }}>{l.height}p</button>)}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
              <button className="cb" onClick={toggleFull} aria-label="Fullscreen"><Icon name={isFull ? "unfull" : "full"} size={20} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
