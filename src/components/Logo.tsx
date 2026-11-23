import { useId } from "react";

/**
 * AbixCine emblem: monolithic architectural "A" set in warm ivory inside a dark cinema
 * tile with a nestled accent-gold play prism that opens on launch.
 */
export function MarkGlyph({ slotClass }: { slotClass?: string }) {
  const uid = useId().replace(/:/g, "");
  const gTile = `abx-tile-${uid}`;
  const gGlow = `abx-glow-${uid}`;
  const gBlade = `abx-blade-${uid}`;
  const gBeam = `abx-beam-${uid}`;

  return (
    <svg viewBox="0 0 64 64" aria-hidden>
      <defs>
        <radialGradient id={gTile} cx="30%" cy="18%" r="85%">
          <stop offset="0%" stopColor="#221d2d" />
          <stop offset="100%" stopColor="#09080c" />
        </radialGradient>
        <radialGradient id={gGlow} cx="50%" cy="62%" r="48%">
          <stop offset="0%" stopColor="var(--tone)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--tone)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={gBlade} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fbf8f1" />
          <stop offset="100%" stopColor="#cfc7b7" />
        </linearGradient>
        <linearGradient id={gBeam} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--tone-ink)" />
          <stop offset="100%" stopColor="var(--tone)" />
        </linearGradient>
      </defs>

      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="15"
        fill={`url(#${gTile})`}
        stroke="#ffffff"
        strokeOpacity="0.14"
        strokeWidth="1.2"
      />
      <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${gGlow})`} />

      {/* Monolithic architectural "A" */}
      <path d="M 28.8 12 H 35.2 L 51.5 51 H 42.0 L 32 26 L 22.0 51 H 12.5 Z" fill={`url(#${gBlade})`} />

      {/* Nestled accent play prism */}
      <path
        className={slotClass}
        d="M 28.8 41.2 L 37.2 45.8 L 28.8 50.4 Z"
        fill={`url(#${gBeam})`}
        stroke={`url(#${gBeam})`}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
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
