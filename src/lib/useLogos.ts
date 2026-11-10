import { useEffect, useState } from "react";
import { getDetail } from "./catalog";
import type { Media } from "./types";

/** Lazily fetch title-treatment logos (and HD backdrops) for a handful of featured items. */
export function useFeatured(items: Media[]) {
  const [extra, setExtra] = useState<Record<string, Partial<Media>>>({});
  const keys = items.map((m) => m.key).join("|");
  useEffect(() => {
    let live = true;
    items.forEach((m) => {
      if (m.key.startsWith("demo:") || extra[m.key]) return;
      getDetail(m.key)
        .then((d) => live && setExtra((x) => ({ ...x, [m.key]: { logo: d.logo, backdrop: d.backdrop ?? m.backdrop } })))
        .catch(() => {});
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return items.map((m) => ({ ...m, ...extra[m.key] }));
}
