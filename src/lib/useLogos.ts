import { useEffect, useMemo, useRef, useState } from "react";
import { getDetail } from "./catalog";
import type { Media, MediaDetail } from "./types";

export type Featured = Media & Partial<Pick<MediaDetail, "runtime" | "seasons" | "episodeCount" | "trailerYouTubeId">>;

/** Lazily fetch title-treatment logos (and HD backdrops) for a handful of featured items. */
export function useFeatured(items: Media[]) {
  const [extra, setExtra] = useState<Record<string, Partial<Featured>>>({});
  const fetched = useRef(new Set<string>());
  const keys = items.map((m) => m.key).join("|");
  useEffect(() => {
    let live = true;
    let batch: Record<string, Partial<Featured>> = {};
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!live || !Object.keys(batch).length) return;
      const found = batch;
      batch = {};
      setExtra((x) => ({ ...x, ...found }));
    };
    const jobs = items.map((m) => {
      if (fetched.current.has(m.key)) return Promise.resolve();
      fetched.current.add(m.key);
      return getDetail(m.key)
        .then((d) => {
          if (!live) return;
          batch[m.key] = {
            logo: d.logo,
            backdrop: d.backdrop ?? m.backdrop,
            runtime: d.runtime,
            seasons: d.seasons,
            episodeCount: d.episodeCount,
            trailerYouTubeId: d.trailerYouTubeId,
          };
          flushTimer ??= setTimeout(flush, 100);
        })
        .catch(() => {
          fetched.current.delete(m.key);
        });
    });
    void Promise.allSettled(jobs).then(() => {
      clearTimeout(flushTimer);
      flush();
    });
    return () => {
      live = false;
      clearTimeout(flushTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return useMemo(() => items.map((m) => ({ ...m, ...extra[m.key] }) as Featured), [items, extra]);
}
