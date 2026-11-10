import { normTitle } from "./format";
import { cached } from "./cache";
import { searchAll } from "./search";
import type { Media } from "./types";
import { useEffect, useState } from "react";
import { parseEpisode, scanLibrary, type LibFile } from "../sources/local";
import { useSettings } from "./settings";

/** One title on disk: a movie file, or every episode file of a show grouped together. */
export interface DriveTitle {
  id: string;
  title: string;
  year?: number;
  files: LibFile[];
  size: number;
  quality?: number;
  hdr?: string;
  audio?: string;
  dual: boolean;
  isShow: boolean;
  season?: number;
  media?: Media;
}

const TAG_RX = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dolby[ ._-]?vision|x26[45]|h\.?26[45]|hevc|avc|web[ ._-]?(dl|rip)?|blu[ ._-]?ray|bdrip|brrip|remux|dts(-?hd)?|truehd|atmos|aac|ac3|eac3|ddp?5\.1|5\.1|7\.1|dual[ ._-]?audio|multi|dub(bed)?|proper|repack|extended|10bit|s\d{1,2}e\d{1,4}|s\d{1,2}|e\d{1,4}|\d{1,2}x\d{2,3})\b.*$/i;

/** "Neon.Ronin.S01E04.1080p.WEB.x265-GRP.mkv" → { title: "Neon Ronin" }, "Dust Prophet (2024).mkv" → { title, year } */
export function parseName(file: string) {
  let base = file.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/\[[^\]]*\]/g, " ").replace(/_/g, " ");
  let year: number | undefined;
  // The release year is the LAST plausible year: "Blade Runner 2049 (2017)" is from 2017.
  const ys = [...base.matchAll(/[ ._(\[-]((?:19|20)\d{2})(?=[ ._)\]-]|$)/g)].filter((m) => Number(m[1]) <= new Date().getFullYear() + 1);
  const y = ys.at(-1);
  if (y && y.index != null && y.index > 0) {
    year = Number(y[1]);
    base = base.slice(0, y.index);
  }
  base = base.replace(TAG_RX, "").replace(/ - \d{1,4}(v\d)?\b.*$/, "");
  const title = base.replace(/[._]+/g, " ").replace(/\s*[-(]+\s*$/, "").replace(/\s+/g, " ").trim();
  return { title, year };
}

const tags = (s: string) => {
  const q = s.match(/(2160|1080|720|576|480)p|\b(4k|uhd)\b/i);
  const quality = q ? (q[1] ? Number(q[1]) : 2160) : undefined;
  const hdr = /\b(dv|dolby[ ._-]?vision)\b/i.test(s) ? "DV" : /\bhdr10\+/i.test(s) ? "HDR10+" : /\bhdr(10)?\b/i.test(s) ? "HDR10" : undefined;
  const audio = /atmos/i.test(s) ? "Atmos" : /truehd/i.test(s) ? "TrueHD" : /dts-?hd/i.test(s) ? "DTS-HD" : /\bdts\b/i.test(s) ? "DTS" : /e?ac3|ddp?5\.1/i.test(s) ? "Dolby 5.1" : /aac/i.test(s) ? "AAC" : undefined;
  return { quality, hdr, audio, dual: /dual[ ._-]?audio|multi[ ._-]?audio/i.test(s) };
};

/** Group raw files into titles: episodes collapse into their show, using the folder name when the file name is just "01.mkv". */
export function groupDrive(files: LibFile[]): DriveTitle[] {
  const map = new Map<string, DriveTitle>();
  for (const f of files) {
    const parts = f.path.split(/[\\/]/);
    const ep = parseEpisode(f.name, f.path);
    const isShow = ep.episode != null;
    let { title, year } = parseName(f.name);
    if (isShow && title.length < 2) {
      // "Show/Season 1/01.mkv": walk up past "Season N" folders.
      const folder = parts.slice(0, -1).reverse().find((p) => !/^(season|s)\s*\d+$/i.test(p.trim()));
      ({ title, year } = parseName(folder ?? f.name));
    }
    if (title.length < 2) continue;
    const id = normTitle(title) + (isShow ? ":show" : `:${year ?? ""}`);
    const t = tags(f.path);
    const cur = map.get(id);
    if (cur) {
      cur.files.push(f);
      cur.size += f.size;
      cur.quality = Math.max(cur.quality ?? 0, t.quality ?? 0) || undefined;
      cur.hdr ??= t.hdr;
      cur.audio ??= t.audio;
      cur.dual ||= t.dual;
    } else {
      map.set(id, { id, title, year, files: [f], size: f.size, isShow, season: ep.season, ...t });
    }
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** Find the catalog entry for a title on disk, cached for a week. */
export async function matchDrive(t: DriveTitle): Promise<Media | undefined> {
  return cached(`drive:${t.id}`, 7 * 24 * 3600_000, async () => {
    const res = await searchAll(t.title);
    const n = normTitle(t.title);
    const fit = (m: Media) =>
      (normTitle(m.title) === n || normTitle(m.originalTitle ?? "") === n) && (!t.year || !m.year || Math.abs(m.year - t.year) <= 1);
    const kindOk = (m: Media) => (t.isShow ? m.kind !== "movie" : m.kind === "movie");
    // No results usually means offline: throw so the miss isn't cached for a week.
    if (!res.length) throw new Error("no results");
    // Only accept a near title (no "first result of any kind" guess, which matched Sample.mkv to random shows).
    const near = (m: Media) => {
      const mt = normTitle(m.title);
      return (mt.startsWith(n) || n.startsWith(mt)) && Math.min(mt.length, n.length) >= 3 && (!t.year || !m.year || Math.abs(m.year - t.year) <= 1);
    };
    return res.find((m) => fit(m) && kindOk(m)) ?? res.find(fit) ?? res.find((m) => near(m) && kindOk(m)) ?? null;
  }).then((m) => m ?? undefined);
}

export const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
export const qualityBadge = (q?: number) => (q && q >= 2160 ? "4K" : q && q >= 720 ? "HD" : "SD");


/** Everything on the user's drive, grouped and matched to the catalog. */
export function useDrive(force = 0) {
  const s = useSettings();
  const [state, setState] = useState<{ loading: boolean; titles: DriveTitle[]; files: number; at?: number; error?: string }>({ loading: true, titles: [], files: 0 });
  const paths = s.libraryPaths.join("|");
  useEffect(() => {
    let live = true;
    if (!s.libraryPaths.length) {
      setState({ loading: false, titles: [], files: 0 });
      return;
    }
    setState((x) => ({ ...x, loading: true }));
    scanLibrary(s.libraryPaths, force > 0)
      .then((files) => {
        if (!live) return;
        const titles = groupDrive(files);
        setState({ loading: false, titles, files: files.length, at: Date.now() });
        titles.forEach((t) =>
          matchDrive(t)
            .then((media) => live && media && setState((x) => ({ ...x, titles: x.titles.map((y) => (y.id === t.id ? { ...y, media } : y)) })))
            .catch(() => {}),
        );
      })
      .catch((e) => live && setState({ loading: false, titles: [], files: 0, error: String(e?.message ?? e) }));
    return () => {
      live = false;
    };
  }, [paths, force]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
