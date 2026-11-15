/**
 * Pre-amp boost, night mode, dialogue boost, and brickwall safety limiting on Web Audio.
 *
 *   video → lowcut (HPF) → dialogue (EQ ~2.2 kHz) → night (compressor) → makeup/boost → limiter → speakers
 *
 * Routing a <video> through an AudioContext is permanent for that element (a disconnected
 * MediaElementSource is silence), so the graph is only built the first time any effect or boost
 * (>100%) is turned on and is then kept with its stages set to neutral when off. Every stream
 * plays with crossOrigin="anonymous", so the audio is never CORS-tainted (which would also be silence).
 */
export interface AudioFx {
  /** Compress loud and quiet passages together: explosions down, whispers up. */
  night: boolean;
  /** Lift the speech band so voices sit above music and effects. */
  dialogue: boolean;
  /** Linear pre-amp gain above 100% (1 = 100%, up to 2 = 200%). Optional; defaults to 1. */
  boost?: number;
}

export const AUDIO_FX_OFF: AudioFx = { night: false, dialogue: false };
const KEY = "abx.audiofx.v1";

function clampBoost(b?: number): number {
  return typeof b === "number" && Number.isFinite(b) && b > 1 ? Math.min(2.5, b) : 1;
}

function isActiveFx(fx: AudioFx): boolean {
  return fx.night || fx.dialogue || clampBoost(fx.boost) > 1.001;
}

export function loadAudioFx(): AudioFx {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AudioFx> | null;
    return { night: raw?.night === true, dialogue: raw?.dialogue === true };
  } catch {
    return { ...AUDIO_FX_OFF };
  }
}

export function saveAudioFx(fx: AudioFx): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ night: fx.night, dialogue: fx.dialogue }));
  } catch {
    /* storage blocked */
  }
}

interface Graph {
  source: MediaElementAudioSourceNode;
  lowcut: BiquadFilterNode;
  dialogue: BiquadFilterNode;
  night: DynamicsCompressorNode;
  makeup: GainNode;
  limiter: DynamicsCompressorNode;
}

let ctx: AudioContext | null = null;
const graphs = new WeakMap<HTMLMediaElement, Graph>();

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return null;
  ctx = new Ctor({ latencyHint: "playback" });
  try {
    if (ctx.destination && ctx.destination.maxChannelCount >= 2) {
      ctx.destination.channelCount = 2;
    }
  } catch {
    /* destination channelCount may be read-only in some environments */
  }
  return ctx;
}

function apply(g: Graph, fx: AudioFx, at: number) {
  const active = isActiveFx(fx);
  // Trim sub-bass rumble when enhancing so speakers keep headroom for voices and midband punch.
  g.lowcut.frequency.setTargetAtTime(fx.night || fx.dialogue ? 65 : 10, at, 0.05);
  // Dialogue: a broad presence lift; 0 dB is a straight wire.
  g.dialogue.gain.setTargetAtTime(fx.dialogue ? 7.5 : 0, at, 0.05);
  // Night: controlled compression paired with strong makeup gain so average dialogue rises clearly.
  g.night.threshold.setTargetAtTime(fx.night ? -24 : 0, at, 0.05);
  g.night.ratio.setTargetAtTime(fx.night ? 4.5 : 1, at, 0.05);
  g.makeup.gain.setTargetAtTime((fx.night ? 2.6 : 1) * (fx.dialogue ? 1.35 : 1) * clampBoost(fx.boost), at, 0.05);
  // Brickwall safety limiter prevents digital clipping when boosting quiet sources up to 200%.
  g.limiter.threshold.setTargetAtTime(active ? -1.0 : 0, at, 0.02);
  g.limiter.ratio.setTargetAtTime(active ? 20 : 1, at, 0.02);
}

/** True once this element's audio runs through the effects graph. */
export function hasAudioFx(el: HTMLMediaElement): boolean {
  return graphs.has(el);
}

/**
 * Apply effects to an element, building its graph on first use. Turning everything off on an
 * element that never had effects does nothing at all (no AudioContext is created).
 */
export function setAudioFx(el: HTMLMediaElement, fx: AudioFx): boolean {
  let g = graphs.get(el);
  if (!g) {
    if (!isActiveFx(fx)) return true;
    const c = context();
    if (!c) return false;
    try {
      const source = c.createMediaElementSource(el);
      const lowcut = c.createBiquadFilter();
      lowcut.type = "highpass";
      lowcut.frequency.value = 10;
      lowcut.Q.value = 0.707;
      const dialogue = c.createBiquadFilter();
      dialogue.type = "peaking";
      dialogue.frequency.value = 2200;
      dialogue.Q.value = 0.75;
      dialogue.gain.value = 0;
      const night = c.createDynamicsCompressor();
      night.knee.value = 12;
      night.attack.value = 0.003;
      night.release.value = 0.2;
      night.threshold.value = 0;
      night.ratio.value = 1;
      const makeup = c.createGain();
      const limiter = c.createDynamicsCompressor();
      limiter.knee.value = 0;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.06;
      limiter.threshold.value = 0;
      limiter.ratio.value = 1;
      source.connect(lowcut).connect(dialogue).connect(night).connect(makeup).connect(limiter).connect(c.destination);
      g = { source, lowcut, dialogue, night, makeup, limiter };
      graphs.set(el, g);
    } catch {
      return false;
    }
  }
  const c = ctx!;
  if (c.state === "suspended") void c.resume().catch(() => {});
  apply(g, fx, c.currentTime);
  return true;
}

/** The element is going away: release its nodes. */
export function releaseAudioFx(el: HTMLMediaElement): void {
  const g = graphs.get(el);
  if (!g) return;
  try {
    g.source.disconnect();
    g.makeup.disconnect();
    g.limiter.disconnect();
  } catch {
    /* already gone */
  }
  graphs.delete(el);
}

/** Autoplay policy: a context created before a gesture starts suspended. Call on play. */
export function resumeAudioFx(): void {
  if (ctx?.state === "suspended") void ctx.resume().catch(() => {});
}
