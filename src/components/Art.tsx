import { memo, useState } from "react";
import type { Media } from "../lib/types";

/** Poster or backdrop image that fades in, with a generated gradient fallback. */
/**
 * TMDB serves several renditions; cards show at ~300px, so they don't need the 1280px backdrop
 * or the 500px poster. `hd` keeps full size for the hero, title page and player backdrops.
 */
const sized = (src: string | undefined, hd: boolean) =>
  !src || hd ? src : src.replace("/t/p/w1280/", "/t/p/w780/").replace("/t/p/w500/", "/t/p/w342/");

export const Art = memo(function Art({ media, variant = "poster", className = "", hd = false, eager = false }: { media: Media; variant?: "poster" | "backdrop"; className?: string; hd?: boolean; /** Above the fold (hero, title page): load now, ahead of card art. */ eager?: boolean }) {
  const src = sized(variant === "poster" ? media.poster : media.backdrop ?? media.poster, hd);
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
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          // @ts-expect-error React 18 only knows the camelCase-less attribute
          fetchpriority={eager ? "high" : "low"}
          draggable={false}
          className={loaded ? "in" : ""}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
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
