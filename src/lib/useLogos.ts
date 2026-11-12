import { useEffect, useMemo, useRef, useState } from "react";
import { getDetail } from "./catalog";
import type { Media, MediaDetail } from "./types";

export type Featured = Media & Partial<Pick<MediaDetail, "runtime" | "seasons" | "episodeCount">>;

/** Lazily fetch title-treatment logos (and HD backdrops) for a handful of featured items. */
export function useFeatured(items: Media[]) {
  const [extra, setExtra] = useState<Record<string, Partial<Featured>>>({});
  const fetched = useRef(new Set<string>());
  const keys = items.map((m) => m.key).join("|");
  useEffect(() => {
    let live = true;
    items.forEach((m) => {
      if (fetched.current.has(m.key)) return;
      fetched.current.add(m.key);
      getDetail(m.key)
        .then(
          (d) =>
            live &&
            setExtra((x) => ({
              ...x,
              [m.key]: {
                logo: d.logo,
                backdrop: d.backdrop ?? m.backdrop,
                runtime: d.runtime,
                seasons: d.seasons,
                episodeCount: d.episodeCount,
              },
            })),
        )
        .catch(() => {
          fetched.current.delete(m.key);
        });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return useMemo(() => items.map((m) => ({ ...m, ...extra[m.key] }) as Featured), [items, extra]);
}
