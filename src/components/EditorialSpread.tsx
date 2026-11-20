import { Link, useNavigate } from "react-router-dom";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import { burst } from "../lib/burst";
import { toggleList, useSaved } from "../lib/watchlist";
import type { Media } from "../lib/types";
import { Art } from "./Art";
import { Card, CardSkeleton, kindLabel, seedState, tagForMorph } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

/**
 * Asymmetric 1+4 Editorial Spread:
 * Pairs one lead feature (unobstructed frame, serif/display typography, synopsis, and quick controls)
 * with a crisp 2×2 grid of framed titles.
 */
export function EditorialSpread({
  eyebrow,
  title,
  accentWord,
  to,
  items,
  loading,
}: {
  eyebrow?: string;
  title: string;
  accentWord?: string;
  to?: string;
  items?: Media[];
  loading?: boolean;
}) {
  const nav = useNavigate();
  const lead = items?.[0];
  const grid = items?.slice(1, 5) ?? [];
  const saved = useSaved(lead?.key ?? "");

  if (!loading && !items?.length) return null;

  return (
    <section className="shelf spread-section">
      <SectionHead eyebrow={eyebrow} title={title} accentWord={accentWord} to={to} />
      {loading && !items?.length ? (
        <div className="spread">
          <div className="spread-lead skeleton" />
          <div className="spread-grid">
            {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)}
          </div>
        </div>
      ) : lead ? (
        <div className="spread">
          <article
            className="spread-lead"
            data-media-key={lead.key}
            onMouseEnter={() => previewLight(lead)}
            onMouseLeave={() => previewLight(null)}
          >
            <Link
              to={`/title/${encodeKey(lead.key)}`}
              state={seedState(lead)}
              viewTransition
              onClick={tagForMorph}
              className="spread-art art-wrap gate-frame"
            >
              <Art media={lead} variant="backdrop" hd eager />
              <span className="gate-brackets" aria-hidden><i /></span>
              <span className="spread-tag">FEATURED SELECTION</span>
            </Link>
            <div className="spread-copy">
              <div className="specs">
                <span className="hi">{kindLabel(lead.kind, lead.format)}</span>
                {lead.year && <span>{lead.year}</span>}
                {lead.rating ? <span className="star">★ {lead.rating.toFixed(1)}</span> : null}
                {lead.genres.slice(0, 2).map((g) => <span key={g}>{g}</span>)}
              </div>
              <h3>
                <Link to={`/title/${encodeKey(lead.key)}`} state={seedState(lead)} viewTransition>
                  {lead.title}
                </Link>
              </h3>
              {lead.overview && <p>{lead.overview}</p>}
              <div className="spread-acts">
                {!isUnreleasedMedia(lead) && (
                  <button
                    type="button"
                    className="btn play sm"
                    onClick={() => nav(playHref(lead), { viewTransition: true, state: { from: "app" } })}
                  >
                    <Icon name="play" size={14} /> Play
                  </button>
                )}
                <button
                  type="button"
                  className="btn glass sm"
                  onClick={() => {
                    registerMedia(lead);
                    openDossier(lead);
                  }}
                >
                  <Icon name="layers" size={14} /> Pass
                </button>
                <button
                  type="button"
                  className={`btn glass sm icon ${saved ? "on" : ""}`}
                  onClick={(e) => {
                    if (!saved) burst(e.currentTarget);
                    toggleList(lead);
                  }}
                  aria-pressed={saved}
                  aria-label={saved ? "Remove from My List" : "Add to My List"}
                >
                  <Icon name={saved ? "check" : "plus"} size={15} />
                </button>
              </div>
            </div>
          </article>

          <div className="spread-grid">
            {grid.map((m, i) => (
              <Card key={m.key} media={m} index={i} variant="landscape" />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
