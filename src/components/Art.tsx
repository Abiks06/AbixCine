import { memo, useLayoutEffect, useRef, useState } from "react";
import type { Media } from "../lib/types";

/** sm: thumbnails · md: shelf cards · lg: full-bleed stages (hero, title page, player). */
export type ArtSize = "xs" | "sm" | "md" | "lg";

type FitMode = "cover" | "portrait-in-wide" | "ultrawide";

const TMDB = /^(https:\/\/image\.tmdb\.org\/t\/p\/)[a-z0-9]+(\/.+)$/;
const SIZES: Record<"poster" | "backdrop", Record<ArtSize, string>> = {
  poster: { xs: "w154", sm: "w342", md: "w500", lg: "w780" },
  backdrop: { xs: "w300", sm: "w780", md: "w1280", lg: "w1280" },
};

/** Ask TMDB for an image close to the size it's drawn at, instead of 4K for a 300px card. */
export function sized(url: string | undefined, size: string) {
  const m = url?.match(TMDB);
  return m ? `${m[1]}${size}${m[2]}` : url;
}

/** Poster or backdrop image that fades in cleanly, with HiDPI srcSet and automatic aspect framing. */
export const Art = memo(function Art({
  media,
  variant = "poster",
  size,
  hd,
  priority = false,
  eager = false,
  className = "",
}: {
  media: Pick<Media, "key" | "title" | "poster" | "backdrop" | "hue">;
  variant?: "poster" | "backdrop";
  /** Explicit rendition. Left out, `hd` picks the stage size and everything else gets a card size. */
  size?: ArtSize;
  hd?: boolean;
  /** Above-the-fold stage image: load now, ahead of everything else. */
  priority?: boolean;
  eager?: boolean;
  className?: string;
}) {
  const effectiveSize = size ?? (hd ? "lg" : "md");
  const isHighPriority = priority || eager;

  const attemptKey = `${media.key}|${variant}|${media.backdrop ?? ""}|${media.poster ?? ""}`;
  const [fallbackKey, setFallbackKey] = useState<string | undefined>();
  const usingPosterFallback = fallbackKey === attemptKey;

  const raw = variant === "poster" || usingPosterFallback ? media.poster : media.backdrop ?? media.poster;
  const kind = variant === "poster" || usingPosterFallback || !media.backdrop ? "poster" : "backdrop";
  const src = sized(raw, SIZES[kind][effectiveSize]);
  const isTmdb = TMDB.test(raw ?? "");

  let srcSet: string | undefined;
  let sizesAttr: string | undefined;
  if (isTmdb) {
    if (kind === "backdrop" && effectiveSize === "lg") {
      srcSet = `${sized(raw, "w780")} 780w, ${sized(raw, "w1280")} 1280w`;
      sizesAttr = "(max-width: 1000px) 100vw, 60vw";
    } else if (kind === "backdrop" && effectiveSize === "md") {
      srcSet = `${sized(raw, "w780")} 780w, ${sized(raw, "w1280")} 1280w`;
      sizesAttr = "(max-width: 900px) 360px, 520px";
    } else if (kind === "poster" && (effectiveSize === "md" || effectiveSize === "lg")) {
      srcSet = `${sized(raw, "w342")} 342w, ${sized(raw, "w500")} 500w, ${sized(raw, "w780")} 780w`;
      sizesAttr = effectiveSize === "lg" ? "(max-width: 1100px) 220px, 320px" : "(max-width: 900px) 160px, 220px";
    }
  }

  const [loadedSrc, setLoadedSrc] = useState<string | undefined>();
  const [failedSrc, setFailedSrc] = useState<string | undefined>();
  const [measuredFit, setMeasuredFit] = useState<{ src: string; mode: FitMode }>();
  const imgRef = useRef<HTMLImageElement>(null);

  const loaded = loadedSrc === src;
  const failed = failedSrc === src;
  const hue = media.hue ?? hash(media.key) % 360;

  const needsPortraitFrame =
    variant === "backdrop" &&
    effectiveSize !== "xs" &&
    (!media.backdrop || usingPosterFallback);

  const fitMode: FitMode = needsPortraitFrame
    ? "portrait-in-wide"
    : src && measuredFit && measuredFit.src === src
      ? measuredFit.mode
      : "cover";

  const measureAndLoad = (img: HTMLImageElement, targetSrc: string | undefined) => {
    setLoadedSrc(targetSrc);
    if (!targetSrc || variant !== "backdrop" || effectiveSize === "xs") return;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      const ratio = img.naturalWidth / img.naturalHeight;
      if (ratio < 1.05) {
        setMeasuredFit({ src: targetSrc, mode: "portrait-in-wide" });
      } else if (effectiveSize === "lg" && media.poster && ratio > 2.55) {
        setMeasuredFit({ src: targetSrc, mode: "ultrawide" });
      }
    }
  };

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img && src && img.complete && img.naturalWidth > 0) {
      measureAndLoad(img, src);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, variant, effectiveSize]);

  const handleError = () => {
    if (variant === "backdrop" && !usingPosterFallback && media.poster && media.poster !== raw) {
      setFallbackKey(attemptKey);
      return;
    }
    setFailedSrc(src);
  };

  const posTop = variant === "backdrop" && effectiveSize === "xs" && (!media.backdrop || usingPosterFallback);
  const stageClass = fitMode !== "cover" ? "art-stage" : posTop ? "art-pos-top" : "";
  const posterFg = media.poster ? (sized(media.poster, "w500") ?? media.poster) : undefined;

  return (
    <div className={`art art-${variant} ${stageClass} ${className}`} style={{ ["--h" as string]: hue }}>
      {src && !failed ? (
        <>
          {fitMode === "portrait-in-wide" && (
            <img className="art-amb in" src={src} alt="" aria-hidden decoding="async" draggable={false} />
          )}
          <img
            ref={imgRef}
            src={src}
            srcSet={srcSet}
            sizes={sizesAttr}
            alt=""
            loading={isHighPriority ? "eager" : "lazy"}
            decoding="async"
            // @ts-expect-error React 18 only knows the camelCase-less attribute
            fetchpriority={isHighPriority ? "high" : "low"}
            draggable={false}
            className={
              fitMode === "ultrawide"
                ? `art-amb art-amb-wide ${loaded ? "in" : ""}`
                : fitMode === "portrait-in-wide"
                  ? `art-fg ${loaded ? "in" : ""}`
                  : loaded
                    ? "in"
                    : ""
            }
            onLoad={(e) => measureAndLoad(e.currentTarget, src)}
            onError={handleError}
          />
          {fitMode === "ultrawide" && posterFg && (
            <img
              className="art-fg"
              src={posterFg}
              alt=""
              loading="eager"
              decoding="async"
              draggable={false}
              onLoad={(e) => e.currentTarget.classList.add("in")}
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
        </>
      ) : (
        <div className="art-fallback"><span>{media.title}</span></div>
      )}
    </div>
  );
});

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
