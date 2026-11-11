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

let index: { at: number; key: string; files: LibFile[] } | null = null;

/** Scan the library folders (Rust side walks the disk) with a 5 minute cache. */
export async function scanLibrary(paths: string[], force = false): Promise<LibFile[]> {
  if (!isTauri() || !paths.length) return [];
  const key = paths.join("|");
  if (!force && index && index.key === key && Date.now() - index.at < 300_000) return index.files;
  const files = await invoke<LibFile[]>("scan_library", { paths });
  index = { at: Date.now(), key, files };
  return files;
}

const QUALITY_RX = /(2160|1080|720|576|480)p|\b4k\b/i;
function qualityOf(name: string) {
  const m = name.match(QUALITY_RX);
  if (!m) return undefined;
  return m[0].toLowerCase() === "4k" ? 2160 : Number(m[1]);
}

/** Pull season/episode from common naming schemes: S01E02, 1x02, "Show - 02", "Ep 02". */
export function parseEpisode(name: string): { season?: number; episode?: number } {
  let m = name.match(/s(\d{1,2})[ ._-]*e(\d{1,4})/i) || name.match(/\b(\d{1,2})x(\d{2,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = name.match(/(?:ep(?:isode)?|e)[ ._]?(\d{1,4})\b/i) || name.match(/ - (\d{1,4})(?:v\d)?\b/);
  if (m) return { episode: Number(m[1]) };
  return {};
}

function titleMatches(fileName: string, req: PlaybackRequest) {
  const f = normTitle(fileName);
  return [req.media.title, req.media.originalTitle]
    .filter(Boolean)
    .some((t) => {
      const n = normTitle(t!);
      return n.length > 1 && f.includes(n);
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
      // Match against the file name plus its parent folder, since many libraries are "Show/Season 1/01.mkv".
      const hay = f.path.split(/[\\/]/).slice(-3).join(" ");
      if (!titleMatches(hay, req)) continue;
      if (req.episode != null) {
        const ep = parseEpisode(f.name);
        if (ep.episode !== req.episode) continue;
        if (ep.season != null && req.season != null && ep.season !== req.season) continue;
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
        quality: qualityOf(f.name),
        audio: req.audio ? audio : undefined,
        subtitles: f.subs?.map((p) => sidecarTrack(p, f.name)),
      });
    }
    return out;
  },
};
