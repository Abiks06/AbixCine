import type { Audio } from "../lib/settings";

/** Sub/Dub switch with a sliding thumb. One anime entry, two ways to watch it. */
export function AudioToggle({ value, onChange, compact }: { value: Audio; onChange: (a: Audio) => void; compact?: boolean }) {
  return (
    <div className={`seg ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Audio">
      <span className="seg-thumb" style={{ transform: `translateX(${value === "sub" ? 0 : 100}%)` }} />
      {(["sub", "dub"] as const).map((a) => (
        <button key={a} role="radio" aria-checked={value === a} className={value === a ? "on" : ""} onClick={() => onChange(a)}>
          {a === "sub" ? "SUB" : "DUB"}
        </button>
      ))}
    </div>
  );
}
