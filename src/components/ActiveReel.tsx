import { Link, useNavigate } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { previewLight } from "../lib/light";
import { watchHref } from "../lib/play";
import type { ProgressEntry } from "../lib/progress";
import { isFilm } from "../lib/types";
import { Art } from "./Art";
import { kindLabel, seedState } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

function fmtWhere(p: ProgressEntry) {
  const left = Math.max(1, Math.round((p.duration - p.position) / 60));
  const ep =
    p.episode != null && !isFilm(p.media)
      ? `${p.season != null ? `S${String(p.season).padStart(2, "0")}·` : ""}E${String(p.episode).padStart(2, "0")}`
      : null;
  return {
    ep,
    left,
    line: [
      p.upNext ? `UP NEXT${ep ? ` ${ep}` : ""}` : ep,
      p.audio ? (p.audio === "dub" ? "DUB" : "SUB") : null,
      p.upNext ? null : `${left}M LEFT`,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * "On the reel": active continue-watching desk separating live sessions from catalog shelves.
 * Features the most recent item as a lead reel card alongside a compact queue strip.
 */
export function ActiveReel({ items, onRemove }: { items: ProgressEntry[]; onRemove: (entry: ProgressEntry) => void }) {
  const nav = useNavigate();
  if (!items.length) return null;
  const lead = items[0];
  const queue = items.slice(1, 7);
  const leadMeta = fmtWhere(lead);
  const leadPct = lead.upNext || !(lead.duration > 0) ? 0 : Math.min(1, Math.max(0.02, lead.position / lead.duration));
  const leadMin = lead.duration > 0 ? Math.round(lead.position / 60) : 0;
  const leadTotalMin = lead.duration > 0 ? Math.round(lead.duration / 60) : 0;
  registerMedia(lead.media);

  return (
    <section className="shelf active-reel" aria-label="Continue watching">
      <SectionHead
        eyebrow="Pick up where you left off"
        title="On the"
        accentWord="reel"
        right={<span className="shelf-note">{items.length} ACTIVE</span>}
      />

      <div className="reel-grid">
        <article
          className="reel-lead"
          data-media-key={lead.media.key}
          onMouseEnter={() => previewLight(lead.media)}
          onMouseLeave={() => previewLight(null)}
        >
          <Link
            to={watchHref(lead.media.key, lead.season, lead.episode, lead.audio)}
            state={{ from: "app" }}
            viewTransition
            className="reel-lead-art gate-frame"
          >
            <Art media={lead.media} variant="backdrop" hd eager />
            <span className="gate-brackets" aria-hidden><i /></span>
            <span className="reel-code">ACTIVE REEL</span>
            {!lead.upNext && lead.duration > 0 && (
              <div className="reel-prog"><i style={{ transform: `scaleX(${leadPct})` }} /></div>
            )}
          </Link>

          <div className="reel-lead-body">
            <div className="reel-kicker">
              <span className="badge">{kindLabel(lead.media.kind, lead.media.format)}</span>
              <span>{leadMeta.line || "In progress"}</span>
            </div>
            <h3>
              <Link to={`/title/${encodeKey(lead.media.key)}`} state={seedState(lead.media)} viewTransition>
                {lead.media.title}
              </Link>
            </h3>
            {!lead.upNext && leadTotalMin > 0 && (
              <div className="reel-timecode">
                <b>{leadMin}m</b> / {leadTotalMin}m · {leadMeta.left}m remaining
              </div>
            )}
            <div className="reel-acts">
              <button
                type="button"
                className="btn play sm"
                onClick={() => nav(watchHref(lead.media.key, lead.season, lead.episode, lead.audio), { viewTransition: true, state: { from: "app" } })}
              >
                <Icon name="play" size={14} /> {lead.upNext ? "Play next" : "Resume"}
              </button>
              <button type="button" className="btn glass sm" onClick={() => openDossier(lead.media)}>
                <Icon name="layers" size={14} /> Pass
              </button>
              <Link className="btn glass sm icon" to={`/title/${encodeKey(lead.media.key)}`} state={seedState(lead.media)} viewTransition title="Full dossier" aria-label={`Details for ${lead.media.title}`}>
                <Icon name="info" size={15} />
              </Link>
              <button type="button" className="btn glass sm icon reel-x" onClick={() => onRemove(lead)} title="Remove from Continue watching" aria-label={`Remove ${lead.media.title} from Continue watching`}>
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
        </article>

        {queue.length > 0 && (
          <div className="reel-queue">
            {queue.map((p) => {
              registerMedia(p.media);
              const meta = fmtWhere(p);
              const pct = p.upNext || !(p.duration > 0) ? null : Math.min(1, Math.max(0.03, p.position / p.duration));
              return (
                <div
                  key={p.media.key}
                  className="reel-item"
                  data-media-key={p.media.key}
                  onMouseEnter={() => previewLight(p.media)}
                  onMouseLeave={() => previewLight(null)}
                >
                  <Link
                    to={watchHref(p.media.key, p.season, p.episode, p.audio)}
                    state={{ from: "app" }}
                    viewTransition
                    className="reel-item-hit"
                  >
                    <div className="reel-item-th">
                      <Art media={p.media} variant="backdrop" size="sm" />
                      {pct != null && <div className="reel-prog"><i style={{ transform: `scaleX(${pct})` }} /></div>}
                    </div>
                    <div className="reel-item-tx">
                      <strong>{p.media.title}</strong>
                      <span>{meta.line}</span>
                    </div>
                  </Link>
                  <div className="reel-item-acts">
                    <button type="button" className="icon-btn" onClick={() => openDossier(p.media)} title="Quick dossier" aria-label={`Quick inspect ${p.media.title}`}>
                      <Icon name="layers" size={14} />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => onRemove(p)} title="Remove" aria-label={`Remove ${p.media.title}`}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
