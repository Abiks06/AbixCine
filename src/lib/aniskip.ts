import { cached } from "./cache";

/**
 * Opening / ending / recap times for anime episodes from AniSkip (api.aniskip.com), a free,
 * community-submitted database keyed by MyAnimeList id + episode number. No key needed.
 */
export interface SkipSegment {
  start: number;
  end: number;
  type: "op" | "ed" | "recap";
}

const API = "https://api.aniskip.com/v2/skip-times";
const TYPES = ["op", "ed", "mixed-op", "mixed-ed", "recap"] as const;

/** Map AniSkip's types onto ours; mixed-op is an opening that runs over the episode's first scene. */
const norm = (t: string): SkipSegment["type"] | null => (t === "op" || t === "mixed-op" ? "op" : t === "ed" || t === "mixed-ed" ? "ed" : t === "recap" ? "recap" : null);

export function parseAniSkip(j: any): SkipSegment[] {
  if (!j?.found || !Array.isArray(j.results)) return [];
  const out: SkipSegment[] = [];
  for (const r of j.results) {
    const type = norm(r.skipType);
    const start = Number(r.interval?.startTime);
    const end = Number(r.interval?.endTime);
    if (!type || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 5) continue;
    // One of each kind is plenty; the first is AniSkip's best-voted.
    if (!out.some((s) => s.type === type)) out.push({ start, end, type });
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function skipTimes(malId: number | undefined, episode: number | undefined, episodeLength = 0): Promise<SkipSegment[]> {
  if (!malId || !episode) return [];
  try {
    return await cached(`aniskip:${malId}:${episode}`, 7 * 24 * 3600_000, async () => {
      const qs = TYPES.map((t) => `types[]=${t}`).join("&");
      const res = await fetch(`${API}/${malId}/${episode}?${qs}&episodeLength=${Math.round(episodeLength)}`, { signal: AbortSignal.timeout(5000) });
      // 404 just means nobody has submitted times for this episode yet.
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`AniSkip ${res.status}`);
      return parseAniSkip(await res.json());
    });
  } catch {
    return [];
  }
}
