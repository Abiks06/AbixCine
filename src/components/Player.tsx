import type Hls from "hls.js";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtTime } from "../lib/format";
import { ENHANCE_MODES, startEnhancer, webgpuAvailable, type EnhanceMode, type Enhancer, type EnhancerStats } from "../lib/enhance";
import { decodeSubtitle, langBase, loadSubPref, loadSubtitle, preferredAudioTrackIndex, saveSubPref, toVtt, type CueSize, type SubPref } from "../lib/subtitles";
import type { Audio } from "../lib/settings";
import type { Episode } from "../lib/types";
import type { StreamCandidate } from "../sources/types";
import { initialCandidateIndex, verifyEmbed } from "../sources/registry";
import { AudioToggle } from "./AudioToggle";
import { Icon } from "./Icon";

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
  candidates: StreamCandidate[];
  initialSource?: string;
  /** Told when a source starts playing or dies, so the picker learns. */
  onSourceResult?: (c: StreamCandidate, ok: boolean) => void;
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
  /** Count down into the next episode when this one ends. */
  autoplayNext?: boolean;
  nextLabel?: string;
  audio?: Audio;
  onAudio?: (a: Audio) => void;
  originalLanguage?: string;
  episodes?: EpisodeNav;
  media?: { title: string; logo?: string; overview?: string; year?: number; rating?: number; backdrop?: string; kind?: string };
}

interface SubTrack {
  id: string;
  label: string;
  lang: string;
  /** HLS rendition, sidecar track, or embedded track exposed by the media element. */
  kind: "hls" | "file" | "native";
  hlsIndex?: number;
  src?: string;
  nativeTrack?: TextTrack;
}

type Sheet = "servers" | "episodes" | "audio" | "picture";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const CUE_SIZES: { id: CueSize; label: string }[] = [
  { id: "s", label: "S" },
  { id: "m", label: "M" },
  { id: "l", label: "L" },
];
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
  ["C", "Subtitles on or off"],
  ["[ / ]", "Subtitle timing"],
  ["S · E", "Servers · Episodes"],
  ["N", "Next episode"],
  ["F · P", "Fullscreen · Picture-in-picture"],
  ["Esc", "Close panel, leave fullscreen, go back"],
];
const ENHANCE_KEY = "abx.enhance.v1";

const kindOf = (c: StreamCandidate) =>
  c.kind === "embed" ? "Online" : c.providerId === "local" ? "This PC" : c.providerId === "jellyfin" ? "Jellyfin" : "Direct";
const audioTag = (c: StreamCandidate) =>
  c.audio === "dub" ? "DUB" : c.audio === "sub" ? "SUB" : c.audio === "dual" ? "DUAL" : c.audio === "unknown" ? "JP?" : null;

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
  let d: any = raw;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const p = d.data && typeof d.data === "object" ? d.data : d;
  const ev = String(p.event ?? d.event ?? p.type ?? "").toLowerCase();
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

export function Player({ candidates: given, initialSource, onSourceResult, title, subtitle, startAt, onProgress, onEnded, onNext, autoNext, onBack, audio, onAudio, originalLanguage, episodes, media }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cueBox = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const resumeAt = useRef(startAt ?? 0);
  // Servers verified from inside the player (standby ones checked on demand) replace the originals.
  const [patched, setPatched] = useState<Record<string, StreamCandidate>>({});
  const candidates = useMemo(() => given.map((c) => patched[c.pageUrl ?? c.url] ?? c), [given, patched]);
  const [checking, setChecking] = useState<string | null>(null);
  const [idx, setIdx] = useState(() => initialCandidateIndex(candidates, initialSource));
  const [playing, setPlaying] = useState(false);
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
  const [idle, setIdle] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [levels, setLevels] = useState<{ height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [hover, setHover] = useState<{ x: number; t: number; w: number } | null>(null);
  /** The ±seconds badge that appears on the side you skipped towards; repeated presses add up. */
  const [bump, setBump] = useState<{ total: number; n: number } | null>(null);
  const bumpTimer = useRef<number>();
  const [timeLeft, setTimeLeft] = useState(() => localStorage.getItem(TIME_LEFT_KEY) === "1");
  const [keysOpen, setKeysOpen] = useState(false);

  const cur = candidates[idx];
  const isEmbed = cur?.kind === "embed";

  // Watch keeps appending late backup servers to `candidates`; read them through refs so a
  // new backup never re-runs the attach effect (which would restart the stream).
  const candsRef = useRef(candidates);
  candsRef.current = candidates;
  const resultRef = useRef(onSourceResult);
  resultRef.current = onSourceResult;
  const curRef = useRef(cur);
  curRef.current = cur;

  const toastTimer = useRef<number>();
  const flash = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

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

  /* --------------------------------------------------------------- failover */

  // Try the next candidate when the current one dies, keeping the playhead.
  const failover = useCallback((why: string) => {
    saveNow();
    setIdx((i) => {
      const list = candsRef.current;
      const dead = list[i];
      if (dead) {
        resultRef.current?.(dead, false);
        // Show it as failed in the server list so nobody picks it again this session.
        setPatched((p) => ({ ...p, [dead.pageUrl ?? dead.url]: { ...dead, probe: { ok: false, latencyMs: dead.probe?.latencyMs ?? 0, error: "won't play" } } }));
      }
      // Only servers that passed the playability check; prefer the ones ranked after this one.
      const usable = (c: StreamCandidate, j: number) => j !== i && !!c.probe?.ok && c.kind !== "embed";
      let next = list.findIndex((c, j) => j > i && usable(c, j));
      if (next === -1) next = list.findIndex(usable);
      if (next === -1) {
        flash(`Playback failed: ${why}`);
        setSheet("servers");
        return i;
      }
      flash(`Switched to ${list[next].providerName} (${why})`);
      return next;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // First frame from a source counts as a successful play (once per source).
  const reported = useRef(new Set<string>());
  const onPlaying = () => {
    const c = curRef.current;
    if (c && !reported.current.has(c.url)) {
      reported.current.add(c.url);
      resultRef.current?.(c, true);
    }
  };

  /* -------------------------------------------------------------- subtitles */

  const [pref, setPref] = useState<SubPref>(loadSubPref);
  const updatePref = (p: Partial<SubPref>) =>
    setPref((x) => {
      const n = { ...x, ...p };
      saveSubPref(n);
      return n;
    });
  const [hlsSubs, setHlsSubs] = useState<SubTrack[]>([]);
  const [fileSubs, setFileSubs] = useState<SubTrack[]>([]);
  const [nativeSubs, setNativeSubs] = useState<SubTrack[]>([]);
  const [addedSubs, setAddedSubs] = useState<SubTrack[]>([]);
  const addedSubsRef = useRef(addedSubs);
  addedSubsRef.current = addedSubs;
  const subTracks = useMemo(() => [...hlsSubs, ...nativeSubs, ...fileSubs, ...addedSubs], [hlsSubs, nativeSubs, fileSubs, addedSubs]);
  const subTracksRef = useRef(subTracks);
  subTracksRef.current = subTracks;
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string; lang: string }[]>([]);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(-1);
  const manualAudio = useRef(false);
  const pendingSub = useRef<string | null>(null);
  /** Once the viewer picks a track on this source, stop auto-choosing for them. */
  const manualSub = useRef(false);
  const trackEls = useRef(new Map<string, HTMLTrackElement>());
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  offsetRef.current = offset;
  /** Offset already applied to each loaded <track>'s cues. */
  const applied = useRef(new Map<string, number>());

  // Tracks are kept "hidden" (loaded, not drawn by the browser): AbixCine draws the cues itself
  // so they sit above the enhancement canvas and lift clear of the controls.
  const applySub = useCallback((id: string | null) => {
    const t = id ? subTracksRef.current.find((x) => x.id === id) : undefined;
    trackEls.current.forEach((el, tid) => {
      el.track.mode = t?.kind === "file" && tid === id ? "hidden" : "disabled";
    });
    subTracksRef.current.forEach((track) => {
      if (track.kind === "native" && track.nativeTrack) {
        track.nativeTrack.mode = t?.kind === "native" && track.id === id ? "hidden" : "disabled";
      }
    });
    const hls = hlsRef.current;
    if (hls) {
      hls.subtitleDisplay = false;
      hls.subtitleTrack = t?.kind === "hls" ? t.hlsIndex! : -1;
    }
    setSelectedSub(t ? t.id : null);
  }, []);

  const chooseSub = (id: string | null) => {
    manualSub.current = true;
    applySub(id);
    const t = subTracks.find((x) => x.id === id);
    updatePref(t ? { on: true, lang: langBase(t.lang) } : { on: false });
    flash(`Subtitles: ${t ? t.label : "Off"}`);
  };

  /** Best track for the viewer's language, falling back to English, then the first one. */
  const preferredTrack = (list: SubTrack[]) => {
    const want = pref.lang ?? "en";
    const byLang = (l: string) => list.filter((t) => langBase(t.lang) === l);
    const pick = (l: SubTrack[]) => l.find((t) => !/forced|signs/i.test(t.label)) ?? l[0];
    return pick(byLang(want)) ?? pick(byLang("en")) ?? list[0];
  };

  // Auto-pick when the track list changes: on if the viewer had subtitles on, or by default
  // for subbed anime; otherwise make sure nothing (e.g. an HLS "default" track) shows.
  useEffect(() => {
    if (pendingSub.current && subTracks.some((t) => t.id === pendingSub.current)) {
      const id = pendingSub.current;
      pendingSub.current = null;
      chooseSub(id);
      return;
    }
    if (manualSub.current) return;
    const wantOn = pref.on ?? audio === "sub";
    applySub(wantOn && subTracks.length ? preferredTrack(subTracks)!.id : null);
  }, [subTracks]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSub = () => {
    if (!subTracks.length) return flash("No subtitles for this server");
    chooseSub(selectedSub ? null : preferredTrack(subTracks)!.id);
  };

  const addSubtitle = async (file?: File) => {
    if (!file) return;
    try {
      const src = URL.createObjectURL(new Blob([toVtt(decodeSubtitle(await file.arrayBuffer()))], { type: "text/vtt" }));
      const id = `added-${crypto.randomUUID()}`;
      pendingSub.current = id;
      setAddedSubs((current) => [...current, { id, label: file.name, lang: "und", kind: "file", src }]);
      flash(`Added subtitle: ${file.name}`);
    } catch (e) {
      flash(`Couldn't load subtitle: ${e instanceof Error ? e.message : "invalid file"}`);
    }
  };
  useEffect(() => () => addedSubsRef.current.forEach((s) => s.src && URL.revokeObjectURL(s.src)), []);

  /** Shift loaded cues so their total offset matches the chosen delay. */
  const shiftCues = (id: string, el: HTMLTrackElement) => {
    const cues = el.track.cues;
    if (!cues) return;
    const target = offsetRef.current;
    const delta = target - (applied.current.get(id) ?? 0);
    if (!delta) return;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      c.startTime = Math.max(0, c.startTime + delta);
      c.endTime = Math.max(0, c.endTime + delta);
    }
    applied.current.set(id, target);
  };
  useEffect(() => {
    trackEls.current.forEach((el, id) => applied.current.has(id) && shiftCues(id, el));
  }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps
  const nudge = (d: number) => {
    const n = Math.round((offset + d) * 10) / 10;
    setOffset(n);
    flash(`Subtitle delay ${n > 0 ? "+" : ""}${n.toFixed(1)}s`);
  };

  // Sidecar / server subtitle files: fetch, decode, convert SRT to WebVTT, serve as blobs
  // (same-origin, so no CORS trouble with the <track> element).
  useEffect(() => {
    setFileSubs([]);
    const list = cur?.subtitles;
    if (!list?.length || isEmbed) return;
    const ctl = new AbortController();
    const blobs: string[] = [];
    Promise.all(
      list.map((s, i) =>
        loadSubtitle(s.url, ctl.signal)
          .then((src) => (blobs.push(src), { id: `file-${i}`, label: s.label || s.lang || `Track ${i + 1}`, lang: s.lang, kind: "file" as const, src }))
          .catch(() => null),
      ),
    ).then((tracks) => {
      if (ctl.signal.aborted) return;
      const ok = tracks.filter((t): t is NonNullable<typeof t> => !!t);
      const seen = new Map<string, number>();
      for (const t of ok) {
        const n = (seen.get(t.label) ?? 0) + 1;
        seen.set(t.label, n);
        if (n > 1) t.label = `${t.label} ${n}`;
      }
      setFileSubs(ok);
    });
    return () => {
      ctl.abort();
      blobs.forEach((b) => URL.revokeObjectURL(b));
    };
  }, [cur?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw the active cues of whichever track is selected (the one in "hidden" mode).
  useEffect(() => {
    const v = video.current;
    if (!v || isEmbed) return;
    let bound: TextTrack | null = null;
    const paint = () => {
      const box = cueBox.current;
      if (!box) return;
      box.replaceChildren();
      const cues = bound?.activeCues;
      if (!cues) return;
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i] as VTTCue;
        const line = document.createElement("span");
        line.className = "cue";
        line.append(typeof c.getCueAsHTML === "function" ? c.getCueAsHTML() : document.createTextNode((c as any).text ?? ""));
        box.append(line);
      }
    };
    const bind = () => {
      const next = Array.from(v.textTracks).find((t) => t.mode === "hidden") ?? null;
      if (next !== bound) {
        bound?.removeEventListener("cuechange", paint);
        bound = next;
        bound?.addEventListener("cuechange", paint);
      }
      paint();
    };
    v.textTracks.addEventListener("change", bind);
    v.textTracks.addEventListener("addtrack", bind);
    bind();
    return () => {
      v.textTracks.removeEventListener("change", bind);
      v.textTracks.removeEventListener("addtrack", bind);
      bound?.removeEventListener("cuechange", paint);
    };
  }, [cur?.url, isEmbed]);
  // Selection or timing changed: repaint straight away rather than at the next cue boundary.
  useEffect(() => {
    video.current?.textTracks.dispatchEvent(new Event("change"));
  }, [selectedSub, offset]);

  /* ----------------------------------------------------------------- audio */

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
    if (hls?.audioTracks[id]) {
      manualAudio.current = true;
      hls.audioTrack = id;
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
      const sidecars = new Set(Array.from(trackEls.current.values(), (el) => el.track));
      const tracks = Array.from(v.textTracks)
        .map((track, i) => ({ track, i }))
        .filter(({ track }) => (track.kind === "subtitles" || track.kind === "captions") && !sidecars.has(track))
        .map(({ track, i }) => ({
          id: `native-sub-${i}`,
          label: track.label || track.language || `Track ${i + 1}`,
          lang: track.language || "und",
          kind: "native" as const,
          nativeTrack: track,
        }));
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
  const started = useRef(false);
  const stallTimer = useRef<number>();
  const clearStall = () => clearTimeout(stallTimer.current);
  const armStall = () => {
    clearStall();
    const v = video.current;
    if (!v || v.paused && started.current) return;
    stallTimer.current = window.setTimeout(() => {
      const vv = video.current;
      // Still not playing, not paused by the viewer, and no data arriving.
      if (vv && !(vv.paused && started.current) && vv.readyState < 3) failover(started.current ? "stalled" : "didn't start");
    }, started.current ? STALL_TIMEOUT : START_TIMEOUT);
  };
  useEffect(() => {
    if (!cur || cur.kind === "embed" || preparingLocal) return;
    started.current = false;
    armStall();
    return clearStall;
  }, [cur?.url, preparingLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------- attach source */

  useEffect(() => {
    const c = curRef.current;
    if (!c) return;
    setPreparingLocal(false);
    setHlsSubs([]);
    setNativeSubs([]);
    setAudioTracks([]);
    setSelectedAudioTrack(-1);
    manualAudio.current = false;
    setSelectedSub(null);
    manualSub.current = false;
    applied.current.clear();
    setOffset(0);
    setLevels([]);
    setLevel(-1);
    setTime(0);
    setDur(0);
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (c.kind === "embed") {
      setWaiting(true);
      embedPos.current = { time: resumeAt.current, duration: 0 };
      setEmbedClock({ time: 0, duration: 0 });
      return;
    }
    const v = video.current;
    if (!v) return;
    setWaiting(true);

    const seekAndPlay = () => {
      if (resumeAt.current > 0 && resumeAt.current < (v.duration || Infinity) - 5) v.currentTime = resumeAt.current;
      pickAudioTrack();
      v.play().catch(() => {});
    };
    let cancelled = false;
    const loadFile = (url: string) => {
      if (cancelled) return;
      v.src = url;
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    };
    const attachHls = (H: typeof Hls) => {
      if (cancelled) return;
      if (!H.isSupported()) {
        v.src = c.url;
        v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        return;
      }
      const hls = new H({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 60, backBufferLength: 30 });
      hlsRef.current = hls;
      hls.subtitleDisplay = false;
      hls.on(H.Events.MANIFEST_PARSED, (_, d) => {
        setLevels(d.levels.map((l) => ({ height: l.height })));
        seekAndPlay();
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
          (d.subtitleTracks ?? []).map((t, i) => ({ id: `hls-${i}`, label: t.name || t.lang || `Track ${i + 1}`, lang: t.lang ?? "und", kind: "hls", hlsIndex: i })),
        );
      });
      let recoveries = 0;
      hls.on(H.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        // Media errors get two local repair attempts (the second also swaps the audio codec), then the next source.
        if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
          if (recoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
        } else failover(d.details);
      });
      hls.loadSource(c.url);
      hls.attachMedia(v);
    };
    // hls.js (~600 kB) is only parsed when a stream actually needs it; local files never load it.
    if (c.kind === "hls") {
      import("hls.js").then((m) => attachHls(m.default), () => failover("player failed to load"));
    } else {
      if (c.localPath) {
        setPreparingLocal(true);
        invoke<string>("prepare_local_media", { path: c.localPath })
          .then((path) => {
            setPreparingLocal(false);
            loadFile(convertFileSrc(path));
          })
          .catch((error: unknown) => {
            setPreparingLocal(false);
            setWaiting(false);
            if (!cancelled) failover(`audio conversion failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      } else {
        loadFile(c.url);
      }
    }
    return () => {
      cancelled = true;
      v.removeEventListener("loadedmetadata", seekAndPlay);
      if (v.currentTime > 1) resumeAt.current = v.currentTime;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [cur?.url, failover]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------------ embeds */

  // Built once per source so later playhead updates don't reload the iframe.
  const embedSrc = useMemo(
    () => (cur?.kind === "embed" ? withStart(cur.url, cur.startParam, resumeAt.current) : ""),
    [cur?.url], // eslint-disable-line react-hooks/exhaustive-deps
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
        if (m.time > 0) onPlaying();
      }
      if (m.ended) {
        const p = embedPos.current;
        if (p.duration) onProgress?.(p.duration, p.duration);
        onEnded?.();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [isEmbed, cur?.url, onProgress, onEnded]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ enhancement */

  const [enhance, setEnhance] = useState<EnhanceMode>(loadEnhance);
  const [enhancing, setEnhancing] = useState<"idle" | "starting" | "on" | "error">("idle");
  const [enhStats, setEnhStats] = useState<EnhancerStats | null>(null);
  /** Embeds get a CSS colour/contrast lift instead: their pixels are cross-origin. */
  const [vivid, setVivid] = useState(() => localStorage.getItem("abx.vivid") === "1");
  const pickEnhance = (m: EnhanceMode) => {
    setEnhance(m);
    try { localStorage.setItem(ENHANCE_KEY, m); } catch { /* ignore */ }
  };
  useEffect(() => {
    try { localStorage.setItem("abx.vivid", vivid ? "1" : "0"); } catch { /* ignore */ }
  }, [vivid]);

  useEffect(() => {
    const v = video.current, c = canvas.current;
    if (enhance === "off" || isEmbed || !v || !c) {
      setEnhancing("idle");
      return;
    }
    let stopped = false;
    let eng: Enhancer | null = null;
    setEnhancing("starting");
    startEnhancer(v, c, enhance, {
      // The governor stepped down because the GPU couldn't keep up: say so, and stop if it reached "off".
      onDowngrade: (to, why) => {
        if (to === "off") {
          eng?.stop();
          eng = null;
          setEnhancing("idle");
          setEnhStats(null);
          flash("Enhancement turned off: this GPU can't keep up at this size");
          return;
        }
        flash(`Enhancement eased to ${ENHANCE_MODES.find((m) => m.id === to)?.name} (${why})`);
      },
    })
      .then((e) => {
        if (stopped) return e.stop();
        eng = e;
        setEnhancing("on");
      })
      .catch((err) => {
        if (stopped) return;
        setEnhancing("error");
        flash(`Enhancement unavailable: ${err?.message ?? err}`);
      });
    // Live stats for the Picture panel (GPU time per frame, chain, skipped frames).
    const statTimer = window.setInterval(() => eng && setEnhStats(eng.stats()), 1000);
    return () => {
      stopped = true;
      clearInterval(statTimer);
      eng?.stop();
      setEnhStats(null);
    };
  }, [enhance, cur?.url, isEmbed]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const switchTo = async (i: number) => {
    if (i === idx) return;
    let c = candidates[i];
    // A standby server hasn't been checked yet: capture its stream first, play only if it has the title.
    if (!c.probe && c.kind === "embed") {
      const id = c.pageUrl ?? c.url;
      setChecking(id);
      const r = await verifyEmbed(c);
      setChecking(null);
      setPatched((p) => ({ ...p, [id]: r }));
      if (!r.probe?.ok) return flash(`${c.providerName} doesn't have this one`);
      c = r;
    }
    saveNow();
    setIdx(i);
    flash(`Now playing from ${c.providerName}${resumeAt.current > 5 ? ` at ${fmtTime(resumeAt.current)}` : ""}`);
  };
  /** "Not playing right?": move to the next server that isn't known to be missing the title. */
  const nextServer = () => {
    const after = candidates.findIndex((c, j) => j > idx && c.probe?.ok !== false);
    const i = after === -1 ? candidates.findIndex((c, j) => j !== idx && c.probe?.ok !== false) : after;
    if (i === -1) return flash("No other server has this one");
    if (cur) resultRef.current?.(cur, false);
    void switchTo(i);
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

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;
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
        case "c": toggleSub(); break;
        case "s": setSheet((x) => (x === "servers" ? null : "servers")); break;
        case "e": if (episodes) setSheet((x) => (x === "episodes" ? null : "episodes")); break;
        case "[": if (selectedSub?.startsWith("file")) nudge(-0.5); break;
        case "]": if (selectedSub?.startsWith("file")) nudge(0.5); break;
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
  const pickServer = useCallback((i: number) => void latest.current.switchTo(i), []);
  const pickEpisode = useCallback((s: number | undefined, e: number) => {
    latest.current.saveNow();
    latest.current.episodes?.go(s, e);
  }, []);

  /* ---------------------------------------------------------------- scrubber */

  const scrubRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const atX = (clientX: number) => {
    const r = scrubRef.current!.getBoundingClientRect();
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
  const curLevel = level >= 0 ? levels[level]?.height : undefined;
  const shownQ = curLevel ?? q;
  const selTrack = subTracks.find((t) => t.id === selectedSub);
  const playable = candidates.filter((c) => c.probe?.ok).length;
  // Intro / credits skip, when the source knows where they are.
  const sk = cur?.skip;
  const inIntro = !!sk?.intro && time >= sk.intro[0] && time < sk.intro[1] - 1.5;
  const inOutro = !!sk?.outro && time >= sk.outro[0] && time < sk.outro[1] - 1.5;
  const enhMode = ENHANCE_MODES.find((m) => m.id === enhance)!;
  const openSheet = (s: Sheet) => setSheet((x) => (x === s ? null : s));

  return (
    <div
      ref={wrap}
      className={`player cue-${pref.size} ${isEmbed ? "is-embed" : ""} ${hide || embedHide ? "idle" : ""} ${isFull ? "is-full" : ""} ${sheet ? "has-sheet" : ""}`}
      onMouseMove={poke}
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
            key={cur.url}
            src={embedSrc}
            className={`embed-frame ${vivid ? "vivid" : ""}`}
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media; gyroscope; accelerometer"
            allowFullScreen
            referrerPolicy="origin"
            onLoad={() => {
              setWaiting(false);
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
              onProgress={(e) => setBuffered(bufferedAhead(e.currentTarget))}
              onDurationChange={(e) => setDur(e.currentTarget.duration)}
              onEnded={() => { const v = video.current; if (v) onProgress?.(v.duration, v.duration); onEnded?.(); }}
              onError={() => cur?.kind === "file" && failover("unsupported or unreachable file")}
            >
              {[...fileSubs, ...addedSubs].map((s) => (
                <track
                  key={s.src}
                  ref={(el) => {
                    if (!el) return void trackEls.current.delete(s.id);
                    if (trackEls.current.get(s.id) === el) return;
                    trackEls.current.set(s.id, el);
                    // React doesn't wire onLoad for <track>; cues exist only after this,
                    // so that's when a timing offset chosen earlier gets applied.
                    el.addEventListener("load", () => {
                      applied.current.set(s.id, 0);
                      shiftCues(s.id, el);
                    }, { once: true });
                  }}
                  src={s.src}
                  kind="subtitles"
                  srcLang={langBase(s.lang) === "und" ? undefined : langBase(s.lang)}
                  label={s.label}
                />
              ))}
            </video>
            <canvas ref={canvas} className={`enhance-canvas ${enhancing === "on" ? "on" : ""}`} aria-hidden />
            <div ref={cueBox} className="cues" aria-live="polite" />
          </>
        )}
        {waiting && (
          <div className="pload" aria-label="Loading">
            <span className="pload-ring" />
            <span className="pload-txt">{preparingLocal ? "Preparing local audio" : started.current ? "Buffering" : `Connecting to ${cur?.providerName ?? "server"}`}</span>
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
              <span className="sp-dot" />
              <span className="sp-name">{cur?.providerName}</span>
              <span className="sp-meta">{[q ? `${q}p` : null, cur?.probe?.latencyMs ? `${cur.probe.latencyMs} ms` : null].filter(Boolean).join(" · ")}</span>
              <span className="sp-count">{playable}</span>
            </button>
            {isEmbed && playable > 1 && (
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
                <button className={`pbtn icon ${selectedSub ? "lit" : ""} ${sheet === "audio" ? "on" : ""}`} onClick={() => openSheet("audio")} title="Audio & subtitles (C toggles)" aria-label="Subtitles">
                  <Icon name="cc" size={20} />
                </button>
                <button className={`pbtn chipbtn ${sheet === "picture" ? "on" : ""}`} onClick={() => openSheet("picture")} title="Picture & playback">
                  {shownQ ? <span className={`q ${shownQ >= 2160 ? "" : "hd"}`}>{shownQ >= 2160 ? "4K" : shownQ >= 720 ? "HD" : "SD"}</span> : null}
                  {enhance !== "off" && <span className={`enh-dot ${enhancing}`} title={enhMode.name} />}
                  <span>{shownQ ? `${shownQ}p` : "Auto"}{speed !== 1 ? ` · ${speed}×` : ""}</span>
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
            if (v) v.currentTime = inIntro ? sk!.intro![1] : sk!.outro![1];
          }}
        >
          {inIntro ? "Skip intro" : "Skip credits"} <Icon name="next" size={16} />
        </button>
      )}

      {showUpNext && (
        <UpNext
          label={episodes?.nextLabel ?? "Next episode"}
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
            <button role="tab" className={sheet === "audio" ? "on" : ""} onClick={() => setSheet("audio")}>Audio</button>
            <button role="tab" className={sheet === "picture" ? "on" : ""} onClick={() => setSheet("picture")}>Picture</button>
          </div>
          <button className="pbtn icon" onClick={() => setSheet(null)} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="ps-body" key={sheet ?? "none"}>
          {sheet === "servers" && (
            <ServerList candidates={candidates} idx={idx} checking={checking} onPick={pickServer} />
          )}

          {sheet === "episodes" && episodes && <EpisodeSheet nav={episodes} onPick={pickEpisode} />}

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
              {!isEmbed && cur?.kind === "file" && audioTracks.length === 0 && (
                <p className="ps-note">Audio is selected by the media engine for this file. If it is silent, its audio codec may not be supported.</p>
              )}
              <div className="ps-block">
                <div className="ps-label">Subtitles {!isEmbed && <kbd>C</kbd>}</div>
                {isEmbed ? (
                  <p className="ps-note">This server draws its own subtitles. Use the CC button inside its player.</p>
                ) : (
                  <div className="opt-list">
                    <button className={`opt ${!selectedSub ? "on" : ""}`} onClick={() => chooseSub(null)}><span>Off</span></button>
                    {subTracks.map((t) => (
                      <button key={t.id} className={`opt ${selectedSub === t.id ? "on" : ""}`} onClick={() => chooseSub(t.id)}>
                        <span>{t.label}</span>
                        <small>{langBase(t.lang) !== "und" ? langBase(t.lang).toUpperCase() : ""}</small>
                      </button>
                    ))}
                    <label className="btn glass sm sub-add">
                      Load .srt / .vtt
                      <input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" onChange={(e) => { void addSubtitle(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
                    </label>
                    {subTracks.length === 0 && (
                      <p className="ps-note">
                        {cur?.kind === "file" ? "No subtitle files next to this video. You can load an .srt or .vtt file." : "This server has no subtitle tracks. You can load an .srt or .vtt file."}
                      </p>
                    )}
                  </div>
                )}
              </div>
              {selTrack && (
                <div className="ps-block">
                  <div className="ps-label">Text size</div>
                  <div className="seg3">
                    {CUE_SIZES.map((sz) => (
                      <button key={sz.id} className={pref.size === sz.id ? "on" : ""} onClick={() => updatePref({ size: sz.id })}>{sz.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {selTrack?.kind === "file" && (
                <div className="ps-block">
                  <div className="ps-label">Timing <kbd>[</kbd><kbd>]</kbd></div>
                  <div className="seg3">
                    <button onClick={() => nudge(-0.5)}>−0.5s</button>
                    <button className={offset === 0 ? "on" : ""} onClick={() => nudge(-offset)}>{offset === 0 ? "In sync" : `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`}</button>
                    <button onClick={() => nudge(0.5)}>+0.5s</button>
                  </div>
                </div>
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
                ) : !webgpuAvailable() ? (
                  <p className="ps-note">Your graphics driver doesn't expose WebGPU, which Anime4K needs. Updating the GPU driver usually fixes this.</p>
                ) : (
                  <div className="opt-list">
                    {ENHANCE_MODES.map((m) => (
                      <button key={m.id} className={`opt big ${enhance === m.id ? "on" : ""}`} onClick={() => pickEnhance(m.id)}>
                        <span>{m.name}{m.heavy && <em className="heavy">GPU heavy</em>}</span>
                        <small>
                          {enhance === m.id && enhancing === "starting"
                            ? "Compiling shaders…"
                            : enhance === m.id && enhancing === "error"
                              ? "Couldn't start on this stream"
                              : enhance === m.id && enhStats
                                ? `${enhStats.mode !== m.id ? `Eased to ${ENHANCE_MODES.find((x) => x.id === enhStats.mode)?.name} · ` : ""}${enhStats.chain} · ${enhStats.gpuMs} ms per frame${enhStats.skipped ? ` · ${enhStats.skipped} frames skipped` : ""}`
                                : m.hint}
                        </small>
                      </button>
                    ))}
                  </div>
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
                    <button className={level === -1 ? "on" : ""} onClick={() => { hlsRef.current!.currentLevel = -1; setLevel(-1); }}>Auto</button>
                    {levels.map((l, i) => <button key={i} className={level === i ? "on" : ""} onClick={() => { hlsRef.current!.currentLevel = i; setLevel(i); }}>{l.height}p</button>)}
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

const ServerList = memo(function ServerList({ candidates, idx, checking, onPick }: { candidates: StreamCandidate[]; idx: number; checking: string | null; onPick: (i: number) => void }) {
  const ok = candidates.filter((c) => c.probe?.ok);
  const standby = candidates.filter((c) => !c.probe);
  const missing = candidates.filter((c) => c.probe && !c.probe.ok);
  const best = ok.reduce((m, c) => Math.min(m, c.probe!.latencyMs), Infinity);
  const row = (c: StreamCandidate) => {
    const i = candidates.indexOf(c);
    const state = c.probe?.ok ? "ok" : c.probe ? "off" : "standby";
    const now = i === idx;
    const busy = checking === (c.pageUrl ?? c.url);
    const ms = c.probe?.latencyMs;
    const bars = state !== "ok" || ms == null ? 0 : ms < 1500 ? 3 : ms < 5000 ? 2 : 1;
    const tag = audioTag(c);
    const q = c.probe?.quality ?? c.quality;
    return (
      <button key={c.pageUrl ?? c.url} className={`srv ${now ? "now" : ""} ${state}`} disabled={state === "off" || busy} onClick={() => onPick(i)} style={{ ["--i" as any]: Math.min(i, 12) }}>
        <span className={`srv-sig b${bars}`} aria-hidden><i /><i /><i /></span>
        <span className="srv-main">
          <span className="srv-name">
            {c.providerName}
            {i === 0 && state === "ok" && <em className="srv-auto">AUTO</em>}
          </span>
          <span className="srv-sub">
            {busy
              ? "Checking this server…"
              : state === "standby"
                ? "Not checked yet · tap to check and play"
                : state === "off"
                  ? c.probe?.error === "no stream" || c.probe?.error === "not found" ? "No stream found" : `Found, but it won't play (${c.probe?.error})`
                  : [c.via === "direct" ? "Direct" : c.via === "sniffed" ? "Ad-free" : kindOf(c), ms === best ? "fastest" : null].filter(Boolean).join(" · ")}
          </span>
        </span>
        {q && state === "ok" ? <span className="srv-tag">{q >= 2160 ? "4K" : `${q}p`}</span> : null}
        {state === "ok" && <span className="srv-tag">{c.kind === "hls" ? "HLS" : c.kind === "file" ? "MP4" : "WEB"}</span>}
        {tag && <span className={`srv-tag ${tag === "JP?" ? "warn" : ""}`} title={tag === "JP?" ? "This server can't switch audio" : undefined}>{tag}</span>}
        {busy ? <span className="mini-spin" /> : now ? <span className="eq" aria-label="Playing"><i /><i /><i /><i /></span> : state !== "off" && <Icon name="play" size={13} />}
      </button>
    );
  };
  return (
    <div className="ps-section">
      <p className="ps-note">Every server below plays in AbixCine's own player, so there are no ads. Switching keeps your place.</p>
      {ok.length > 0 && <div className="srv-group"><div className="ps-label">Ready · {ok.length}</div><div className="srv-list">{ok.map(row)}</div></div>}
      {standby.length > 0 && <div className="srv-group"><div className="ps-label">On standby · {standby.length}</div><div className="srv-list">{standby.map(row)}</div></div>}
      {missing.length > 0 && <div className="srv-group"><div className="ps-label">Unavailable · {missing.length}</div><div className="srv-list">{missing.map(row)}</div></div>}
    </div>
  );
});

/* ----------------------------------------------------------------- episodes */

const PAGE = 50;

const EpisodeSheet = memo(function EpisodeSheet({ nav, onPick }: { nav: EpisodeNav; onPick: (s: number | undefined, e: number) => void }) {
  const [season, setSeason] = useState(nav.season);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const curRef = useRef<HTMLButtonElement>(null);
  const total = nav.count ?? 0;
  // Long-running anime (1000+ episodes) is paged in blocks of 50 around the current one.
  const [page, setPage] = useState(() => Math.floor((nav.episode - 1) / PAGE));
  const [known, setKnown] = useState<Map<number, Episode>>(new Map());
  useEffect(() => {
    let live = true;
    nav.loadAll?.().then((list) => live && setKnown(new Map(list.map((e) => [e.number, e])))).catch(() => {});
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (season == null || !nav.loadSeason) return setEps(null);
    let live = true;
    setEps(null);
    nav.loadSeason(season).then((r) => live && setEps(r)).catch(() => live && setEps([]));
    return () => {
      live = false;
    };
  }, [season]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: "center" });
  }, [eps, page]);

  const list: Episode[] =
    season != null
      ? eps ?? []
      : Array.from({ length: Math.min(PAGE, Math.max(0, total - page * PAGE)) }, (_, i) => known.get(page * PAGE + i + 1) ?? { season: 0, number: page * PAGE + i + 1, title: `Episode ${page * PAGE + i + 1}` });
  const pages = Math.ceil(total / PAGE);

  return (
    <div className="ps-section">
      {nav.seasons && nav.seasons.length > 1 && (
        <div className="season-strip">
          {nav.seasons.map((s) => (
            <button key={s.number} className={s.number === season ? "on" : ""} onClick={() => setSeason(s.number)}>
              {s.name.length <= 10 ? s.name : `S${s.number}`}
            </button>
          ))}
        </div>
      )}
      {season == null && pages > 1 && (
        <div className="season-strip">
          {Array.from({ length: pages }, (_, p) => (
            <button key={p} className={p === page ? "on" : ""} onClick={() => setPage(p)}>
              {p * PAGE + 1}–{Math.min(total, (p + 1) * PAGE)}
            </button>
          ))}
        </div>
      )}
      <div className="ep-list">
        {season != null && !eps && Array.from({ length: 5 }, (_, i) => <div key={i} className="ep-row skeleton" />)}
        {list.map((e, i) => {
          const isCur = e.number === nav.episode && (season ?? undefined) === nav.season;
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
