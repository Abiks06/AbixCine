import { memo, useState } from "react";
import type { Media } from "../lib/types";

/** sm: thumbnails · md: shelf cards · lg: full-bleed stages (hero, title page, player). */
export type ArtSize = "xs" | "sm" | "md" | "lg";

const TMDB = /^(https:\/\/image\.tmdb\.org\/t\/p\/)[a-z0-9]+(\/.+)$/;
const SIZES: Record<"poster" | "backdrop", Record<ArtSize, string>> = {
  poster: { xs: "w92", sm: "w185", md: "w342", lg: "w780" },
  backdrop: { xs: "w300", sm: "w300", md: "w780", lg: "w1280" },
};

/** Ask TMDB for an image close to the size it's drawn at, instead of 4K for a 300px card. */
export function sized(url: string | undefined, size: string) {
  const m = url?.match(TMDB);
  return m ? `${m[1]}${size}${m[2]}` : url;
}

/** Poster or backdrop image that fades in, with a generated gradient fallback. */
export const Art = memo(function Art({
  media,
  variant = "poster",
  size = "md",
  hd,
  priority = false,
  eager = false,
  className = "",
}: {
  media: Media;
  variant?: "poster" | "backdrop";
  size?: ArtSize;
  hd?: boolean;
  /** Above-the-fold stage image: load now, ahead of everything else. */
  priority?: boolean;
  eager?: boolean;
  className?: string;
}) {
  const effectiveSize = size ?? (hd ? "lg" : "md");
  const isHighPriority = priority || eager;
  const raw = variant === "poster" ? media.poster : media.backdrop ?? media.poster;
  const kind = variant === "poster" || !media.backdrop ? "poster" : "backdrop";
  const src = sized(raw, SIZES[kind][effectiveSize]);
  // Big stages get the original on large/high-DPI screens, w1280 elsewhere.
  const srcSet = effectiveSize === "lg" && kind === "backdrop" && TMDB.test(raw ?? "") ? `${sized(raw, "w1280")} 1280w, ${sized(raw, "original")} 3840w` : undefined;
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>();
  const [failedSrc, setFailedSrc] = useState<string | undefined>();
  const loaded = loadedSrc === src;
  const failed = failedSrc === src;
  const hue = media.hue ?? hash(media.key) % 360;
  return (
    <div className={`art art-${variant} ${className}`} style={{ ["--h" as string]: hue }}>
      {src && !failed ? (
        <img
          src={src}
          srcSet={srcSet}
          sizes={srcSet ? "100vw" : undefined}
          alt=""
          loading={isHighPriority ? "eager" : "lazy"}
          decoding="async"
          // @ts-expect-error React 18 only knows the camelCase-less attribute
          fetchpriority={isHighPriority ? "high" : "low"}
          draggable={false}
          className={loaded ? "in" : ""}
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
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
