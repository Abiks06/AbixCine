import { parseSubtitles, type SubtitleCue } from "./subtitles";

/** The parts of a `shaka.text.Cue` the collector reads (kept structural: no Shaka import here). */
export interface ShakaCueLike {
  startTime: number;
  endTime: number;
  payload?: string;
  lineBreak?: boolean;
  nestedCues?: ShakaCueLike[];
}

function cueText(c: ShakaCueLike): string {
  if (c.nestedCues?.length) return c.nestedCues.map((n) => (n.lineBreak ? "\n" : cueText(n))).join("");
  return c.payload ?? "";
}

const vttTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};

/**
 * A Shaka `TextDisplayer` that draws nothing: it collects the cues Shaka parses for the selected
 * DASH text track and hands them to the player's own subtitle renderer (styling, dual subtitles,
 * timing offsets), the same way every other subtitle source is shown.
 */
export class DashCueCollector {
  private byKey = new Map<string, { start: number; end: number; text: string }>();
  private visible = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onCues: (cues: SubtitleCue[]) => void) {}

  /** A different text track was selected: start over. */
  reset(): void {
    this.byKey.clear();
    this.schedule();
  }

  append(cues: ShakaCueLike[]): void {
    for (const c of cues) {
      const text = cueText(c).trim();
      if (!text || !(c.endTime > c.startTime)) continue;
      this.byKey.set(`${c.startTime.toFixed(3)}|${c.endTime.toFixed(3)}|${text}`, { start: c.startTime, end: c.endTime, text });
    }
    this.schedule();
  }

  remove(start: number, end: number): boolean {
    for (const [k, c] of this.byKey) if (c.start >= start && c.end <= end) this.byKey.delete(k);
    this.schedule();
    return true;
  }

  isTextVisible(): boolean {
    return this.visible;
  }

  setTextVisibility(on: boolean): void {
    this.visible = on;
  }

  setTextLanguage(): void {}

  configure(): void {}

  destroy(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.byKey.clear();
    return Promise.resolve();
  }

  /** Shaka appends a segment's cues at a time: batch them into one update. */
  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.onCues(this.snapshot());
    }, 60);
  }

  snapshot(): SubtitleCue[] {
    const entries = [...this.byKey.values()].sort((a, b) => a.start - b.start);
    if (!entries.length) return [];
    // Through the shared parser, so inline markup (<i>, <b>) gets the same spans as any VTT file.
    const vtt = `WEBVTT\n\n${entries.map((e) => `${vttTime(e.start)} --> ${vttTime(e.end)}\n${e.text}`).join("\n\n")}\n`;
    return parseSubtitles(vtt, "vtt").cues;
  }
}
