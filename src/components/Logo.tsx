import { useId } from "react";

/**
 * AbixCine emblem: anamorphic aperture "A" sculpted from paired optical blades inside a dark
 * cinema gate with a luminous central play-prism and lens-flare crossbar that opens on launch.
 */
export function MarkGlyph({ slotClass }: { slotClass?: string }) {
  const uid = useId().replace(/:/g, "");
  const gTile = `abx-tile-${uid}`;
  const gBlade = `abx-blade-${uid}`;
  const gBeam = `abx-beam-${uid}`;

  return (
    <svg viewBox="0 0 36 36" aria-hidden>
      <defs>
        <radialGradient id={gTile} cx="35%" cy="22%" r="85%">
          <stop offset="0%" stopColor="#1b1822" />
          <stop offset="100%" stopColor="#09080b" />
        </radialGradient>
        <linearGradient id={gBlade} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#faf7ef" />
          <stop offset="100%" stopColor="#cbc4b6" />
        </linearGradient>
        <linearGradient id={gBeam} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--tone-ink)" />
          <stop offset="100%" stopColor="var(--tone)" />
        </linearGradient>
      </defs>

      <rect
        x="1.25"
        y="1.25"
        width="33.5"
        height="33.5"
        rx="7.5"
        fill={`url(#${gTile})`}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="1"
      />

      {/* Projection gate corner registration ticks */}
      <g stroke="var(--tone-ink)" strokeOpacity="0.52" strokeWidth="1.2" fill="none" strokeLinecap="round">
        <path d="M5.5 8.8V5.5H8.8" />
        <path d="M27.2 5.5H30.5V8.8" />
        <path d="M5.5 27.2V30.5H8.8" />
        <path d="M27.2 30.5H30.5V27.2" />
      </g>

      {/* Sculpted split "A" blades */}
      <path d="M16.9 7.6L9.1 28.4H13.4L18 15.2L16.9 7.6Z" fill={`url(#${gBlade})`} />
      <path d="M19.1 7.6L26.9 28.4H22.6L18 15.2L19.1 7.6Z" fill={`url(#${gBlade})`} />
      <polygon points="16.9,7.6 19.1,7.6 18,12.4" fill={`url(#${gBlade})`} />

      {/* Center luminous cinema play prism + anamorphic flare crossbar */}
      <polygon points="15.9,14.5 21.5,17.8 15.9,21.1" fill={`url(#${gBeam})`} />
      <rect className={slotClass} x="11.2" y="21.9" width="13.6" height="2.2" rx="1.1" fill={`url(#${gBeam})`} />
    </svg>
  );
}

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <span className="mark" style={{ width: size, height: size }}>
      <MarkGlyph />
    </span>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`} aria-label="AbixCine">
      <span className="wm-abix">ABIX</span>
      <span className="wm-dot" aria-hidden />
      <b className="wm-cine">Cine</b>
    </span>
  );
}
