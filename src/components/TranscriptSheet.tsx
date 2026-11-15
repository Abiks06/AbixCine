import { memo, useEffect, useMemo, useRef } from "react";
import { fmtTime } from "../lib/format";
import type { SubtitleCue } from "../lib/subtitles";
import { Icon } from "./Icon";
import { usePlayhead, type PlayheadStore } from "./Playhead";

interface Line {
  start: number;
  end: number;
  text: string;
  second?: string;
}

/** Second-language lines shown beside a main line: those overlapping it in time. */
export function pairTranscript(primary: readonly SubtitleCue[], secondary: readonly SubtitleCue[] | undefined, secOffset = 0, primOffset = 0): Line[] {
  const sec = (secondary ?? []).map((c) => ({ start: c.start + secOffset, end: c.end + secOffset, text: c.text })).sort((a, b) => a.start - b.start);
  let j = 0;
  return primary.map((c) => {
    const start = c.start + primOffset;
    const end = c.end + primOffset;
    while (j < sec.length && sec[j].end <= start) j++;
    const parts: string[] = [];
    for (let k = j; k < sec.length && sec[k].start < end; k++) if (sec[k].end > start) parts.push(sec[k].text);
    return { start, end, text: c.text, ...(parts.length ? { second: parts.join("\n") } : {}) };
  });
}

/** Index of the line showing at `t` (or the last one before it), by binary search. */
function lineAt(lines: readonly Line[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The film's dialogue as a list: the main subtitle with the second language under each line.
 * Tap a line to jump there; "Sync" moves the main subtitle's timing so that line lands now.
 */
export const TranscriptSheet = memo(function TranscriptSheet({
  ph,
  primary,
  secondary,
  primaryOffset,
  secondaryOffset,
  primaryLabel,
  secondaryLabel,
  onSeek,
  onSyncTo,
}: {
  ph: PlayheadStore;
  primary?: readonly SubtitleCue[];
  secondary?: readonly SubtitleCue[];
  primaryOffset: number;
  secondaryOffset: number;
  primaryLabel?: string;
  secondaryLabel?: string;
  onSeek: (t: number) => void;
  /** Set the main subtitle's offset (seconds). */
  onSyncTo: (offsetSec: number) => void;
}) {
  const lines = useMemo(
    () => (primary?.length ? pairTranscript(primary, secondary, secondaryOffset, primaryOffset) : []),
    [primary, secondary, primaryOffset, secondaryOffset],
  );
  // Re-renders only when the current line changes.
  const active = usePlayhead(ph, (t) => (lines.length ? lineAt(lines, t) : -1));
  const listRef = useRef<HTMLOListElement>(null);
  const userScrollUntil = useRef(0);

  useEffect(() => {
    if (active < 0 || Date.now() < userScrollUntil.current) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  if (!primary?.length) {
    return (
      <div className="ps-section">
        <p className="ps-note">
          Turn on a subtitle to see the dialogue here. Subtitle files, online subtitles and those the stream
          sends as files all work; tracks the video only shows line by line don't have a transcript.
        </p>
      </div>
    );
  }

  return (
    <div className="ps-section transcript">
      <div className="transcript-head">
        <span>{primaryLabel ?? "Subtitles"}</span>
        {secondary?.length ? <span className="transcript-second-label">+ {secondaryLabel ?? "second language"}</span> : null}
      </div>
      <ol
        ref={listRef}
        className="transcript-list"
        // Reading ahead or back: let the viewer scroll freely for a few seconds before following again.
        onWheel={() => (userScrollUntil.current = Date.now() + 4000)}
        onTouchMove={() => (userScrollUntil.current = Date.now() + 4000)}
      >
        {lines.map((l, i) => (
          <li key={`${l.start}-${i}`} className={i === active ? "on" : ""}>
            <button type="button" className="transcript-line" onClick={() => onSeek(l.start)}>
              <time>{fmtTime(l.start)}</time>
              <span className="transcript-text">
                {l.text}
                {l.second && <em>{l.second}</em>}
              </span>
            </button>
            <button
              type="button"
              className="transcript-sync"
              title="This line is being said now: shift the subtitles to match"
              aria-label={`Sync subtitles so “${l.text.slice(0, 40)}” is now`}
              onClick={() => onSyncTo(Math.round((ph.get() - (l.start - primaryOffset)) * 10) / 10)}
            >
              <Icon name="clock" size={13} /> Sync
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
});
