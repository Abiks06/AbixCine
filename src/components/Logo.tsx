/**
 * AbixCine mark: a soft "A" that is also a screen in the dark, with a single slot of light
 * for the crossbar. Sits on the violet-to-cyan tile. The slot is what opens on launch.
 */
export function MarkGlyph({ slotClass }: { slotClass?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 4.2c.5 0 .9.3 1.2.8l6.6 12.6c.5 1-.2 2.1-1.3 2.1H5.5c-1.1 0-1.8-1.1-1.3-2.1L10.8 5c.3-.5.7-.8 1.2-.8z" fill="#fff" />
      <rect className={slotClass} x="8.6" y="13.6" width="6.8" height="2" rx="1" fill="#0B0A14" />
    </svg>
  );
}

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <span className="mark" style={{ width: size, height: size, borderRadius: size * 0.3 }}>
      <MarkGlyph />
    </span>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`} aria-label="AbixCine">
      Abix<b>Cine</b>
    </span>
  );
}
