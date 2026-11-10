import type { Audio } from "../lib/settings";

/** Sub/Dub switch: a lit thumb springs between the two. One anime entry, two ways to watch it. */
export function AudioToggle({ value, onChange, compact }: { value: Audio; onChange: (a: Audio) => void; compact?: boolean }) {
  return (
    <div className={`sd ${value === "dub" ? "dub" : ""} ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Audio">
      <span className="th2" />
      {(["sub", "dub"] as const).map((a) => (
        <button key={a} role="radio" aria-checked={value === a} className={value === a ? "on" : ""} onClick={() => value !== a && onChange(a)}>
          {a === "sub" ? "SUB" : "DUB"}
        </button>
      ))}
    </div>
  );
}
