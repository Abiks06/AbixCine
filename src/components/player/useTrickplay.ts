/**
 * Scrub previews (lib/trickplay): one engine per stream, opened lazily on the first hover of
 * the seek bar. Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { TrickplayEngine } from "../../lib/trickplay";
import type { StreamCandidate } from "../../sources/types";
import { useHover, type createHoverStore } from "../Playhead";

export function useTrickplay(opts: {
  video: RefObject<HTMLVideoElement>;
  curRef: MutableRefObject<StreamCandidate | undefined>;
  hoverStore: ReturnType<typeof createHoverStore>;
  sourceUrl: string | undefined;
  retrySeq: number;
  isEmbed: boolean;
}): string | null {
  const { video, curRef, hoverStore, sourceUrl, retrySeq, isEmbed } = opts;
  const trickRef = useRef<TrickplayEngine | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const hoverBucket = useHover(hoverStore, (p) => (p ? Math.floor(p.t / 5) : -1));

  useEffect(() => {
    setThumb(null);
    return () => {
      trickRef.current?.dispose();
      trickRef.current = null;
    };
  }, [sourceUrl, retrySeq]);
  useEffect(() => {
    if (hoverBucket < 0) return;
    const c = curRef.current;
    const v = video.current;
    if (!c || !v || isEmbed || /^magnet:/i.test(c.url)) return;
    const kind = c.kind === "hls" ? "hls" : c.kind === "file" ? "file" : null;
    if (!kind) return;
    // Files play from what the player actually loaded (a converted copy, a torrent's local URL).
    const src = kind === "file" ? v.currentSrc || c.url : c.url;
    if (!src) return;
    let live = true;
    const t = window.setTimeout(() => {
      trickRef.current ??= new TrickplayEngine(kind, src);
      void trickRef.current.frameAt(hoverBucket * 5 + 2.5).then((url) => {
        if (live && url) setThumb(url);
      });
    }, 90);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [hoverBucket, isEmbed]); // eslint-disable-line react-hooks/exhaustive-deps
  return thumb;
}
