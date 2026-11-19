import { useEffect, useRef, type RefObject } from "react";

/** Samples per second while playing; paused, the glow holds and checks back once a second. */
const PLAY_MS = 160;
const PAUSE_MS = 1000;

/**
 * Cinema glow: bias lighting in the letterbox and pillarbox bars. The picture is drawn into a
 * 32×18 canvas a few times a second, and that canvas, stretched to the whole screen and blurred
 * (styles/player.css), sits under the video, so each bar takes the colour of the frame's edge
 * beside it. Drawing only, never reading pixels back, so it works on every stream the <video>
 * plays, cross-origin or not. Off unless asked for, and nothing runs while it is off.
 */
export function Ambilight({ video, playing }: { video: RefObject<HTMLVideoElement | null>; playing: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    const ctx = c?.getContext("2d", { alpha: false });
    if (!c || !ctx) return;
    let dead = false;
    const draw = () => {
      // The <video> is swapped per source, so it is looked up on every frame.
      const v = video.current;
      if (dead || document.hidden || !v || v.readyState < 2 || !v.videoWidth) return;
      try {
        ctx.drawImage(v, 0, 0, c.width, c.height);
      } catch {
        dead = true; // a source the canvas can't draw: the bars just stay dark
      }
    };
    draw();
    const t = window.setInterval(draw, playing ? PLAY_MS : PAUSE_MS);
    return () => window.clearInterval(t);
  }, [video, playing]);
  return <canvas ref={cv} className="ambi" width={32} height={18} aria-hidden />;
}
