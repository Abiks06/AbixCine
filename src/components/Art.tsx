import { useState } from "react";
import type { Media } from "../lib/types";

/** Poster or backdrop image that fades in, with a generated gradient fallback. */
export function Art({ media, variant = "poster", className = "" }: { media: Media; variant?: "poster" | "backdrop"; className?: string }) {
  const src = variant === "poster" ? media.poster : media.backdrop ?? media.poster;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const hue = media.hue ?? hash(media.key) % 360;
  return (
    <div
      className={`art art-${variant} ${className}`}
      style={{ ["--h" as any]: hue }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={loaded ? "in" : ""}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="art-fallback"><span>{media.title}</span></div>
      )}
    </div>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
