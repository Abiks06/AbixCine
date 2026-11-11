import { useEffect, useRef } from "react";

/**
 * The player's control surface. The <Player> attaches itself here while it is on screen; anything
 * else in the app (command palette, a remote-control plugin, a "watch together" sync, a test) drives
 * it by sending typed commands and listens to typed events, without importing the component or
 * reaching into the <video> element.
 *
 *   playerBus.send({ type: "seekBy", seconds: 10 });
 *   const off = playerBus.on("timeupdate", (e) => console.log(e.currentTime, e.duration));
 *
 * It is in-process only. Nothing here listens to window.postMessage, so a web page or iframe
 * can't drive the player.
 */

export type PlayerCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  /** Absolute position in seconds. */
  | { type: "seek"; time: number }
  /** Relative jump in seconds (negative goes back). */
  | { type: "seekBy"; seconds: number }
  /** 0..1 */
  | { type: "setVolume"; volume: number }
  /** Omit `muted` to toggle. */
  | { type: "mute"; muted?: boolean }
  | { type: "setSpeed"; rate: number }
  /** Switch to the best ready source from this provider, keeping the playhead. */
  | { type: "setProvider"; provider: string }
  /** Switch to sources[index] from the state, keeping the playhead. */
  | { type: "setSource"; index: number }
  /** Index into state.subtitles, or -1 for off. */
  | { type: "setSubtitle"; index: number }
  /** A stream height such as 1080, or -1 for automatic (HLS sources only). */
  | { type: "setQuality"; height: number }
  /** Omit `on` to toggle. */
  | { type: "fullscreen"; on?: boolean }
  | { type: "next" }
  | { type: "back" };

export interface SourceInfo {
  index: number;
  providerId: string;
  providerName: string;
  label: string;
  quality?: number;
  kind: "hls" | "file";
}

export interface PlayerState {
  title: string;
  /** "Season 1 · Episode 3" style line, when there is one. */
  subtitle?: string;
  playing: boolean;
  waiting: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  speed: number;
  source?: SourceInfo;
  sources: SourceInfo[];
  subtitles: { index: number; lang: string; label: string }[];
  /** Index of the subtitle track showing, -1 when off. */
  subtitleTrack: number;
  /** Stream heights the current HLS source offers (empty for plain files). */
  qualities: number[];
  /** -1 for automatic. */
  quality: number;
  /** Which engine is drawing: the built-in player or mpv. */
  engine?: "html" | "mpv";
}

export interface PlayerEventMap {
  /** A player mounted and is ready for commands. */
  attach: { state: PlayerState };
  /** Metadata for the current source arrived. */
  ready: { duration: number; source?: SourceInfo };
  play: { currentTime: number };
  pause: { currentTime: number };
  /** About four times a second while the playhead moves. */
  timeupdate: { currentTime: number; duration: number; buffered: number };
  /** The stream stalled (buffering) or recovered. */
  buffering: { waiting: boolean };
  ended: { duration: number };
  volumechange: { volume: number; muted: boolean };
  ratechange: { rate: number };
  /** The playing source changed. `failover` means the previous one died and the next ready one took over. */
  sourcechange: { from?: SourceInfo; to: SourceInfo; reason: "user" | "failover" | "command" };
  /** Every source failed. */
  error: { message: string };
  subtitlechange: { index: number };
  qualitychange: { height: number };
  /** The player unmounted. */
  detach: Record<string, never>;
}

export type PlayerEventType = keyof PlayerEventMap;
type Listener<K extends PlayerEventType> = (e: PlayerEventMap[K]) => void;
type AnyListener = <K extends PlayerEventType>(type: K, e: PlayerEventMap[K]) => void;

export interface PlayerHandle {
  run(cmd: PlayerCommand): void;
  state(): PlayerState;
}

export function createPlayerBus() {
  let handle: PlayerHandle | null = null;
  const listeners = new Map<PlayerEventType, Set<Listener<any>>>();
  const any = new Set<AnyListener>();

  const bus = {
    /** Send a command to the player on screen. Returns false when no player is attached. */
    send(cmd: PlayerCommand): boolean {
      if (!handle) return false;
      handle.run(cmd);
      return true;
    },
    /** A snapshot of the player on screen, or null when nothing is playing. */
    state(): PlayerState | null {
      return handle ? handle.state() : null;
    },
    get attached() {
      return !!handle;
    },
    on<K extends PlayerEventType>(type: K, fn: Listener<K>): () => void {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => void set!.delete(fn);
    },
    /** Every event, for loggers and bridges. */
    onAny(fn: AnyListener): () => void {
      any.add(fn);
      return () => void any.delete(fn);
    },
    emit<K extends PlayerEventType>(type: K, e: PlayerEventMap[K]) {
      // A broken listener (say, a plugin) must never break playback or the other listeners.
      for (const fn of listeners.get(type) ?? []) {
        try {
          fn(e);
        } catch (err) {
          console.error(`[player] ${type} listener failed`, err);
        }
      }
      for (const fn of any) {
        try {
          fn(type, e);
        } catch (err) {
          console.error("[player] listener failed", err);
        }
      }
    },
    /** Called by <Player>. The newest player wins; detaching an old one doesn't unplug the new one. */
    attach(h: PlayerHandle): () => void {
      handle = h;
      bus.emit("attach", { state: h.state() });
      return () => {
        if (handle !== h) return;
        handle = null;
        bus.emit("detach", {});
      };
    },
  };
  return bus;
}

export type PlayerBus = ReturnType<typeof createPlayerBus>;

/** The app-wide bus. */
export const playerBus = createPlayerBus();

/** Subscribe to a player event for the life of a component. */
export function usePlayerEvent<K extends PlayerEventType>(type: K, fn: Listener<K>, bus: PlayerBus = playerBus) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => bus.on(type, (e) => ref.current(e)), [type, bus]);
}

// Handy in the dev console: abix.player.send({ type: "seekBy", seconds: 30 }). Dev builds only.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { abix?: { player: PlayerBus } }).abix = { player: playerBus };
}
