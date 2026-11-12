import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { normTitle } from "../lib/format";
import type { PlaybackRequest } from "../lib/types";
import type { SourceProvider, StreamCandidate, SubtitleTrack } from "./types";

export interface LibFile {
  path: string;
  name: string;
  size: number;
  /** Sidecar .srt/.vtt files found next to the video. */
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
    .filter(Boolean)
    .some((t) => {
      const n = normTitle(t!);
      return n.length > 1 && f.includes(` ${n} `);
    });
}

const LANGS: Record<string, [string, string]> = {
  en: ["en", "English"], eng: ["en", "English"], english: ["en", "English"],
  ja: ["ja", "Japanese"], jp: ["ja", "Japanese"], jpn: ["ja", "Japanese"], japanese: ["ja", "Japanese"],
  fr: ["fr", "French"], fre: ["fr", "French"], fra: ["fr", "French"], french: ["fr", "French"],
  es: ["es", "Spanish"], spa: ["es", "Spanish"], spanish: ["es", "Spanish"],
  de: ["de", "German"], ger: ["de", "German"], deu: ["de", "German"], german: ["de", "German"],
  pt: ["pt", "Portuguese"], por: ["pt", "Portuguese"], it: ["it", "Italian"], ita: ["it", "Italian"],
  ar: ["ar", "Arabic"], ara: ["ar", "Arabic"], zh: ["zh", "Chinese"], chi: ["zh", "Chinese"],
  ko: ["ko", "Korean"], kor: ["ko", "Korean"], ru: ["ru", "Russian"], rus: ["ru", "Russian"],
  portuguese: ["pt", "Portuguese"], italian: ["it", "Italian"], arabic: ["ar", "Arabic"],
  chinese: ["zh", "Chinese"], korean: ["ko", "Korean"], russian: ["ru", "Russian"],
};

/** "Show.S01E02.en.forced.srt" next to "Show.S01E02.mkv" -> English (forced). */
export function sidecarTrack(subPath: string, videoName: string): SubtitleTrack {
  const file = subPath.split(/[\\/]/).pop() ?? subPath;
  const stem = file.slice(0, file.lastIndexOf("."));
  // Only the part after the video's own name says anything about the track.
  const rest = stem.toLowerCase().startsWith(videoName.toLowerCase()) ? stem.slice(videoName.length) : stem;
  const tags = rest.toLowerCase().split(/[ ._-]+/).filter(Boolean);
  const lang = tags.map((t) => LANGS[t]).find(Boolean);
  const extra = tags.filter((t) => t === "forced" || t === "sdh" || t === "signs").map((t) => (t === "sdh" ? "SDH" : t));
  const name = lang?.[1] ?? (rest.replace(/^[ ._-]+/, "") || "Subtitles");
  return { lang: lang?.[0] ?? "und", label: extra.length ? `${name} (${extra.join(", ")})` : name, url: convertFileSrc(subPath) };
}

/** Does this file hold the requested episode? Handles multi-episode files and anime absolute numbering. */
export function episodeMatches(ep: EpisodeInfo, req: Pick<PlaybackRequest, "season" | "episode" | "absolute">) {
  if (req.episode == null || ep.episode == null) return false;
  const inFile = (n: number) => n >= ep.episode! && n <= (ep.last ?? ep.episode!);
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
  async find(req, s) {
    const files = await scanLibrary(s.libraryPaths);
    const out: StreamCandidate[] = [];
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
      out.push({
        providerId: "local",
        providerName: "Local library",
        label: f.name + (req.audio ? (audio === "dual" ? " · dual audio" : ` · ${audio}`) : ""),
        url: convertFileSrc(f.path),
        kind: f.path.toLowerCase().endsWith(".m3u8") ? "hls" : "file",
        ...(f.path.toLowerCase().endsWith(".m3u8") ? {} : { localPath: f.path }),
        quality: qualityOf(f.name),
        audio: req.audio ? audio : undefined,
        subtitles: f.subs?.map((p) => sidecarTrack(p, f.name)),
      });
    }
    return out;
  },
};
