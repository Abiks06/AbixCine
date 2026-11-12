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

export interface SubtitleTrack {
  /** BCP 47 / ISO 639 code when known ("en", "eng", "ja"). */
  lang: string;
  label: string;
  /** WebVTT or SRT; SRT is converted on the fly. */
  url: string;
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
