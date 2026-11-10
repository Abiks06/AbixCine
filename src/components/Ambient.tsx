import { useEffect } from "react";
import { setStageLight } from "../lib/light";
import type { Media } from "../lib/types";

/** Hands the page's featured title to the stage light, which tints the whole app around it. */
export function Ambient({ media }: { media?: Media }) {
  useEffect(() => {
    if (media) setStageLight(media);
  }, [media?.key, media?.backdrop]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
