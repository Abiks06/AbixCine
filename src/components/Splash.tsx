import { useEffect, useState } from "react";
import { MarkGlyph, Wordmark } from "./Logo";

/**
 * Launch aperture: the mark springs in, its slot of light opens like a projector gate,
 * then the mark scales past the camera and the app is behind it. ~1.7s, once per launch.
 */
export function Splash({ skip }: { skip: boolean }) {
  const [gone, setGone] = useState(skip);
  useEffect(() => {
    if (skip) return;
    const t = setTimeout(() => setGone(true), 1800);
    return () => clearTimeout(t);
  }, [skip]);
  if (gone) return null;
  return (
    <div className="launch" aria-hidden>
      <div className="launch-mk">
        <MarkGlyph slotClass="launch-slot" />
      </div>
      <Wordmark className="launch-wm" />
    </div>
  );
}
