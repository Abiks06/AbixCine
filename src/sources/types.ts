import type { Settings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";

export type StreamKind = "hls" | "file";

/** One playable option a provider found for a request. */
export interface StreamCandidate {
  providerId: string;
  providerName: string;
  label: string;
  url: string;
  kind: StreamKind;
  /** Vertical resolution if known (from filename, manifest, or server metadata). */
  quality?: number;
  subtitles?: { lang: string; label: string; url: string }[];
  /** Filled in by the ranker. */
  probe?: { ok: boolean; latencyMs: number; quality?: number; error?: string };
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
  /** "local" sources are on this PC; "external" ones are servers you add later. */
  category: "local" | "external";
  /** Higher wins ties. Local files beat network sources by default. */
  priority: number;
  isEnabled(s: Settings): boolean;
  find(req: PlaybackRequest, s: Settings, signal: AbortSignal): Promise<StreamCandidate[]>;
}
