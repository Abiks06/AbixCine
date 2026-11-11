import { fmtTime } from "../lib/format";
import { providerStatus, type ProviderState } from "../sources/health";
import { candLine, TIERS, tierOf } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";

export interface FailoverEntry {
  /** Playhead when it happened. */
  at: number;
  from: string;
  to?: string;
  why: string;
}

const STATE_LABEL: Record<ProviderState, string> = {
  healthy: "Healthy",
  degraded: "Shaky",
  down: "Down",
  new: "New",
};

/**
 * The player's source panel: every ready copy in the order AbixCine will fall back through,
 * each with its tier, its provider's health, and what it measured this time. Below it, a log of
 * any automatic switches made during this episode.
 */
export function SourcePanel({ candidates, idx, onPick, log }: { candidates: StreamCandidate[]; idx: number; onPick: (i: number) => void; log: FailoverEntry[] }) {
  // Fallback order = list order, skipping sources already known to be dead.
  let order = 0;
  return (
    <div className="glass menu src-menu" role="dialog" aria-label="Sources">
      <div className="src-head">
        <span className="menu-sep">Fallback chain</span>
        <span className="src-auto"><i className="dot" /> Auto fallback on</span>
      </div>
      {candidates.map((c, i) => {
        const dead = c.probe?.ok === false;
        const n = dead ? null : ++order;
        const tier = TIERS[tierOf(c.providerId)];
        const st = c.providerId === "manual" ? null : providerStatus(c.providerId);
        const state: ProviderState | "dead" = dead ? "dead" : st?.state ?? "new";
        return (
          <button key={c.url} className={`src-row ${i === idx ? "on" : ""}`} disabled={dead} onClick={() => i !== idx && onPick(i)} aria-current={i === idx}>
            <span className="src-ord" aria-label={n ? `Fallback ${n}` : "Unavailable"}>{n ?? "×"}</span>
            <span className="src-main">
              <span className="src-name">
                {c.providerName}
                <span className="tier" title={tier.name}>Tier {tier.roman}</span>
              </span>
              <small className="src-file">{c.label}</small>
            </span>
            <span className="src-side">
              <span className={`health ${state}`} title={st ? `${Math.round(st.reliability * 100)}% reliable${st.latency != null ? ` · ~${st.latency} ms` : ""}` : undefined}>
                <i />
                {state === "dead" ? "Offline" : STATE_LABEL[state]}
              </span>
              <small>{i === idx ? "NOW" : candLine(c) || "ready"}</small>
            </span>
          </button>
        );
      })}
      {log.length > 0 && (
        <div className="src-log" aria-live="polite">
          <span className="menu-sep">Switches this episode</span>
          {log.map((l, k) => (
            <small key={k}>
              {fmtTime(l.at)} · {l.from} → {l.to ?? "none left"} <em>({l.why})</em>
            </small>
          ))}
        </div>
      )}
      <small className="src-foot">If a source stalls, AbixCine moves to the next one and keeps your place.</small>
    </div>
  );
}
