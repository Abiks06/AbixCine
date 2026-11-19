/**
 * Hardware media keys, headset buttons and the Windows media flyout (Media Session API).
 * Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { useEffect, useRef, type RefObject } from "react";

export function useMediaSession(opts: {
  video: RefObject<HTMLVideoElement>;
  title: string;
  subtitle?: string;
  artwork?: string;
  hasNext: boolean;
  seek: (d: number) => void;
  goNext: () => void;
}) {
  const { video, title, subtitle, artwork, hasNext } = opts;
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === "undefined") return;
    ms.metadata = new MediaMetadata({
      title: subtitle ? `${title} · ${subtitle}` : title,
      artist: "AbixCine",
      artwork: artwork ? [{ src: artwork }] : [],
    });
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, h);
      } catch {
        /* action not supported here */
      }
    };
    set("play", () => void video.current?.play().catch(() => {}));
    set("pause", () => video.current?.pause());
    set("seekbackward", () => latest.current.seek(-10));
    set("seekforward", () => latest.current.seek(10));
    set("nexttrack", hasNext ? () => latest.current.goNext() : null);
    return () => {
      (["play", "pause", "seekbackward", "seekforward", "nexttrack"] as MediaSessionAction[]).forEach((a) => set(a, null));
      ms.metadata = null;
    };
  }, [title, subtitle, artwork, hasNext]); // eslint-disable-line react-hooks/exhaustive-deps
}
