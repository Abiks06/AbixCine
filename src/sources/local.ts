import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { normTitle } from "../lib/format";
import type { PlaybackRequest } from "../lib/types";
import {
  codecToSubtitleFormat,
  inferSubtitleMeta,
  type EmbeddedSubtitle,
  type SourceProvider,
  type StreamCandidate,
  type SubtitleTrack,
} from "./types";

export interface LibFile {
  path: string;
  name: string;
  size: number;
  /** Sidecar .srt/.vtt/.ass/.ssa files found next to the video (or in Subs/ subfolders). */
  subs?: string[];
}

let index: { at: number; key: string; files: LibFile[]; errors: ScanError[] } | null = null;

export interface ScanError {
  path: string;
  message: string;
}

/** Folders that failed on the last scan (unplugged drive, permissions). */
export const scanErrors = () => index?.errors ?? [];

/** Scan the library folders (Rust side walks the disk) with a 5 minute cache. */
export async function scanLibrary(paths: string[], force = false): Promise<LibFile[]> {
  if (!isTauri() || !paths.length) return [];
  const key = paths.join("|");
  if (!force && index && index.key === key && Date.now() - index.at < 300_000) return index.files;
  const r = await invoke<{ files: LibFile[]; errors: ScanError[] }>("scan_library", { paths });
  index = { at: Date.now(), key, files: r.files, errors: r.errors };
  return r.files;
}

/** Strip a real video extension only ("Dune.2021" is a stem, not "Dune" + ".2021"). */
export const stripExt = (name: string) => name.replace(/\.(mkv|mp4|m4v|webm|mov|ts|m3u8|avi)$/i, "");

const QUALITY_RX = /(2160|1080|720|576|480)p|\b4k\b/i;
export function qualityOf(name: string) {
  const m = name.match(QUALITY_RX);
  if (!m) return undefined;
  return m[0].toLowerCase() === "4k" ? 2160 : Number(m[1]);
}

export interface EpisodeInfo {
  season?: number;
  episode?: number;
  /** Last episode in a multi-episode file ("S01E01E02", "S01E01-E03"). */
  last?: number;
}

/**
 * Pull season/episode from common naming schemes:
 * "S01E02", "S01E01E02", "1x02", "Show - 02", "[Group] Show - 02 [1080p]", "Ep 02", and a bare
 * "01.mkv" inside a "Season 1" folder (pass the full path so the folder can supply the season).
 * Years ("Stargate.1994") and codec tags ("x264") are never read as episode numbers.
 */
export function parseEpisode(name: string, path = ""): EpisodeInfo {
  const base = stripExt(name).replace(/_/g, " ").replace(/\[[^\]]*\]/g, " ");
  let m = base.match(/\bs(\d{1,2})[ ._-]*e(\d{1,4})(?:[ ._-]*-?[ ._-]*e(\d{1,4}))?(?!\d)/i)
    || base.match(/(?<![a-z\d])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), ...(m[3] ? { last: Number(m[3]) } : {}) };
  const folder = path.match(/[\\/](?:season|series|s)[ ._-]*(\d{1,2})[\\/][^\\/]*$/i)?.[1];
  const season = folder ? Number(folder) : undefined;
  const notYear = (n: string) => !/^(19|20)\d{2}$/.test(n);
  m = base.match(/(?<![a-z])(?:ep(?:isode)?|e)[ .]?(\d{1,4})\b/i) || base.match(/ - (\d{1,4})(?:v\d)?\b/)
    || base.trim().match(/^(\d{1,3})(?:v\d)?$/)
    || (season != null ? base.trim().match(/^(\d{1,3})\b/) : null);
  if (m && notYear(m[1])) return { ...(season != null ? { season } : {}), episode: Number(m[1]) };
  return season != null ? { season } : {};
}

/** Title appears in the file/folder names as whole words ("Up" doesn't match "Upgrade" or "Backup"). */
export function titleMatches(hay: string, req: Pick<PlaybackRequest, "media">) {
  const f = ` ${normTitle(hay)} `;
  return [req.media.title, req.media.originalTitle]
    .filter((t): t is string => Boolean(t))
    .some((t) => {
      const n = normTitle(t);
      return n.length > 1 && f.includes(` ${n} `);
    });
}

/** "Show.S01E02.en.forced.ass" next to "Show.S01E02.mkv" -> English · Forced (ass, sidecar). */
export function sidecarTrack(subPath: string, videoName: string): SubtitleTrack {
  const file = subPath.split(/[\\/]/).pop() ?? subPath;
  const dot = file.lastIndexOf(".");
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  const ext = dot >= 0 ? file.slice(dot) : "";
  const videoStem = stripExt(videoName);
  // Only the part after the video's own name says anything about the track.
  const rest = stem.toLowerCase().startsWith(videoStem.toLowerCase()) ? stem.slice(videoStem.length) : stem;
  const cleanedRest = rest.replace(/^[ ._-]+/, "");
  const meta = inferSubtitleMeta(`${cleanedRest || "sub"}${ext}`);
  const isTagOnly = /^(?:forced|sdh|hi|cc|signs|default)$/i.test(cleanedRest);
  const label = meta.lang === "und" && cleanedRest && !isTagOnly ? cleanedRest : meta.label;
  return {
    lang: meta.lang,
    label,
    url: convertFileSrc(subPath),
    ...(meta.format ? { format: meta.format } : {}),
    isDefault: meta.isDefault,
    isForced: meta.isForced,
    isHearingImpaired: meta.isHearingImpaired,
    source: "sidecar",
  };
}

function embeddedTrack(s: EmbeddedSubtitle): SubtitleTrack {
  const rawTitle = s.title?.trim() || undefined;
  const meta = inferSubtitleMeta("", s.lang ?? undefined, rawTitle);
  const format = codecToSubtitleFormat(s.codec) ?? meta.format;
  const isDefault = Boolean(s.isDefault || meta.isDefault);
  const isForced = Boolean(s.isForced || meta.isForced);
  const isHearingImpaired = Boolean(s.isHearingImpaired || meta.isHearingImpaired);

  const langOnlyLabel = meta.lang !== "und" ? inferSubtitleMeta("", meta.lang).label : "Subtitles";
  let label = meta.label;
  if (rawTitle && meta.lang !== "und" && !rawTitle.toLowerCase().includes(langOnlyLabel.toLowerCase())) {
    label = `${langOnlyLabel} · ${rawTitle}`;
  }
  if (isForced && !/forced|signs/i.test(label)) label = `${label} · Forced`;
  if (isHearingImpaired && !/\b(?:sdh|hi|cc)\b|hearing/i.test(label)) label = `${label} · SDH`;

  return {
    lang: meta.lang,
    label,
    url: `embedded://${s.index}`,
    ...(format ? { format } : {}),
    isDefault,
    isForced,
    isHearingImpaired,
    source: "embedded",
    streamIndex: s.index,
  };
}

/** Does this file hold the requested episode? Handles multi-episode files and anime absolute numbering. */
export function episodeMatches(ep: EpisodeInfo, req: Pick<PlaybackRequest, "season" | "episode" | "absolute">) {
  const epNum = ep.episode;
  if (req.episode == null || epNum == null) return false;
  const inFile = (n: number) => n >= epNum && n <= (ep.last ?? epNum);
  if (ep.season != null && req.season != null) return ep.season === req.season && inFile(req.episode);
  // File has no season ("Show - 26.mkv"): it's absolute numbering, or season 1.
  if (ep.season == null && req.season != null && req.season > 1) return req.absolute != null && inFile(req.absolute);
  return inFile(req.episode) || (req.absolute != null && inFile(req.absolute));
}

const YEAR_RX = /[ ._(\[-]((?:19|20)\d{2})(?=[ ._)\]-]|$)/g;
const fileYear = (name: string) => {
  const ys = [...name.matchAll(YEAR_RX)].map((m) => Number(m[1])).filter((y) => y <= new Date().getFullYear() + 1);
  return ys.at(-1);
};
const DUB_RX = /\b(dub|dubbed|eng(lish)?[ ._-]?dub)\b/i;
const DUAL_RX = /\b(dual[ ._-]?audio|multi[ ._-]?audio)\b/i;

/** What audio a file (or its folder) carries, from common release naming. */
export function audioOf(path: string): "sub" | "dub" | "dual" {
  if (DUAL_RX.test(path)) return "dual";
  return DUB_RX.test(path) ? "dub" : "sub";
}

export const localProvider: SourceProvider = {
  id: "local",
  name: "Local library",
  category: "local",
  priority: 30,
  isEnabled: (s) => s.libraryPaths.length > 0,
  async find(req, s, signal) {
    if (signal?.aborted) return [];
    const files = await scanLibrary(s.libraryPaths);
    if (signal?.aborted) return [];
    const matched: { file: LibFile; audio: "sub" | "dub" | "dual" }[] = [];
    for (const f of files) {
      // Match against the file name plus its parent folders, since many libraries are "Show/Season 1/01.mkv".
      const hay = f.path.split(/[\\/]/).slice(-3).join(" ");
      if (!titleMatches(hay, req)) continue;
      const ep = parseEpisode(f.name, f.path);
      if (req.episode != null) {
        if (!episodeMatches(ep, req)) continue;
      } else {
        // A film request never plays an episode file, nor a same-named film from another year (Dune 1984 vs 2021).
        if (ep.episode != null) continue;
        const y = fileYear(hay);
        if (y && req.media.year && Math.abs(y - req.media.year) > 1) continue;
      }
      // One anime entry, two audio tracks: keep files that carry the audio the user picked.
      const audio = audioOf(hay);
      if (req.audio && audio !== "dual" && audio !== req.audio) continue;
      matched.push({ file: f, audio });
    }

    const canProbe = isTauri();
    return Promise.all(
      matched.map(async ({ file: f, audio }): Promise<StreamCandidate> => {
        const isHls = f.path.toLowerCase().endsWith(".m3u8");
        const sidecars = f.subs?.map((p) => sidecarTrack(p, f.name)) ?? [];
        const rawEmbedded =
          canProbe && !isHls && !signal?.aborted
            ? await invoke<EmbeddedSubtitle[]>("probe_local_subtitles", { path: f.path }).catch(() => [])
            : [];
        const embedded = Array.isArray(rawEmbedded)
          ? rawEmbedded
              .filter((sub) => sub && sub.isText !== false && typeof sub.index === "number")
              .map(embeddedTrack)
          : [];
        const subtitles = [...sidecars, ...embedded];
        return {
          providerId: "local",
          providerName: "Local library",
          label: f.name + (req.audio ? (audio === "dual" ? " · dual audio" : ` · ${audio}`) : ""),
          url: convertFileSrc(f.path),
          kind: isHls ? "hls" : "file",
          ...(isHls ? {} : { localPath: f.path }),
          quality: qualityOf(f.name),
          audio: req.audio ? audio : undefined,
          ...(f.subs !== undefined || subtitles.length ? { subtitles } : {}),
        };
      }),
    );
  },
};
