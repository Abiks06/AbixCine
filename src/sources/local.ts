import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { normTitle } from "../lib/format";
import type { PlaybackRequest } from "../lib/types";
import type { SourceProvider, StreamCandidate } from "./types";

export interface LibFile {
  path: string;
  name: string;
  size: number;
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
      });
    }
    return out;
  },
};
