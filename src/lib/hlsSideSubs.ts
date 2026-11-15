import { parseSubtitles, type SubtitleCue } from "./subtitles";

/**
 * A second HLS subtitle track, loaded beside hls.js.
 *
 * hls.js downloads segments for one subtitle track at a time, so dual subtitles with two HLS tracks
 * showed only one. This fetches the other track's WebVTT playlist and segments itself and hands the
 * cues to the player as an ordinary parsed track. Long playlists are loaded around the playhead
 * (and topped up as it moves) rather than all at once.
 */

interface Segment {
  url: string;
  start: number;
  end: number;
}

const WINDOW_BEHIND_SEC = 30;
const WINDOW_AHEAD_SEC = 120;
const LOAD_ALL_MAX_SEGMENTS = 40;
const CONCURRENCY = 4;

/** Parse a media playlist into segment URLs with their timeline positions. */
export function parseSubtitlePlaylist(text: string, playlistUrl: string): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  let pendingDur: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const d = parseFloat(line.slice(8));
      pendingDur = Number.isFinite(d) && d >= 0 ? d : 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    const dur = pendingDur ?? 0;
    let url: string;
    try {
      url = new URL(line, playlistUrl).toString();
    } catch {
      continue;
    }
    out.push({ url, start: t, end: t + dur });
    t += dur;
    pendingDur = null;
  }
  return out;
}

/**
 * Seconds to add to a segment's cue times so they line up with the video: WebVTT segments carry
 * `X-TIMESTAMP-MAP=MPEGTS:<pts>,LOCAL:<time>`, mapping their local clock onto the stream's PTS,
 * and the video's own clock starts at the stream's first PTS (`initPtsSec`).
 */
export function vttTimestampShift(vtt: string, initPtsSec: number | null): number {
  const m = vtt.match(/X-TIMESTAMP-MAP=([^\r\n]+)/i);
  if (!m) return 0;
  const mpegts = m[1].match(/MPEGTS:(\d+)/i);
  const local = m[1].match(/LOCAL:((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)/i);
  if (!mpegts) return 0;
  const toSec = (s: string) => s.split(":").reduce((acc, part) => acc * 60 + parseFloat(part), 0);
  const localSec = local ? toSec(local[1]) : 0;
  const ptsSec = Number(mpegts[1]) / 90_000;
  // Without the stream's first PTS, assume the common 10 s (MPEGTS:900000) start.
  const base = initPtsSec ?? (Number(mpegts[1]) === 900_000 ? 10 : ptsSec);
  return ptsSec - localSec - base;
}

export interface HlsSideLoader {
  /** Make sure the cues around `timeSec` are loaded. Cheap to call often. */
  ensure(timeSec: number): void;
  dispose(): void;
}

export function createHlsSideLoader(opts: {
  playlistUrl: string;
  getInitPtsSec: () => number | null;
  onCues: (cues: SubtitleCue[]) => void;
  fetchText?: (url: string, signal: AbortSignal) => Promise<string>;
}): HlsSideLoader {
  const ctl = new AbortController();
  const fetchText =
    opts.fetchText ??
    (async (url: string, signal: AbortSignal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
  let segments: Segment[] | null = null;
  let playlistPromise: Promise<void> | null = null;
  const done = new Set<number>();
  const loading = new Set<number>();
  const byStart = new Map<number, SubtitleCue[]>();
  let lastTime = 0;

  const publish = () => {
    const all: SubtitleCue[] = [];
    for (const [, cues] of [...byStart.entries()].sort((a, b) => a[0] - b[0])) all.push(...cues);
    // Segments repeat a cue that spans their boundary: keep one copy.
    const seen = new Set<string>();
    const unique = all.filter((c) => {
      const k = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    unique.sort((a, b) => a.start - b.start);
    opts.onCues(unique);
  };

  const loadSegment = async (i: number) => {
    if (!segments || done.has(i) || loading.has(i)) return;
    loading.add(i);
    try {
      const text = await fetchText(segments[i].url, ctl.signal);
      if (ctl.signal.aborted) return;
      const shift = vttTimestampShift(text, opts.getInitPtsSec());
      const cues = parseSubtitles(text, "vtt").cues.map((c) => ({ ...c, start: c.start + shift, end: c.end + shift }));
      byStart.set(segments[i].start, cues);
      done.add(i);
      publish();
    } catch {
      /* a missing segment just leaves a gap; it's retried when the playhead comes back */
    } finally {
      loading.delete(i);
    }
  };

  const fillWindow = async () => {
    if (!segments || ctl.signal.aborted) return;
    const all = segments.length <= LOAD_ALL_MAX_SEGMENTS;
    const from = lastTime - WINDOW_BEHIND_SEC;
    const to = lastTime + WINDOW_AHEAD_SEC;
    const wanted = segments
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => !done.has(i) && !loading.has(i) && (all || (s.end > from && s.start < to)))
      .map(({ i }) => i);
    // Nearest the playhead first, a few at a time.
    wanted.sort((a, b) => Math.abs(segments![a].start - lastTime) - Math.abs(segments![b].start - lastTime));
    let next = 0;
    const worker = async () => {
      while (next < wanted.length && !ctl.signal.aborted) await loadSegment(wanted[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
  };

  const loadPlaylist = () => {
    playlistPromise ??= fetchText(opts.playlistUrl, ctl.signal)
      .then((text) => {
        segments = parseSubtitlePlaylist(text, opts.playlistUrl);
      })
      .catch(() => {
        playlistPromise = null; // try again on the next ensure()
      });
    return playlistPromise;
  };

  return {
    ensure(timeSec: number) {
      if (ctl.signal.aborted) return;
      lastTime = Number.isFinite(timeSec) ? timeSec : 0;
      void loadPlaylist().then(() => fillWindow());
    },
    dispose() {
      ctl.abort();
    },
  };
}
