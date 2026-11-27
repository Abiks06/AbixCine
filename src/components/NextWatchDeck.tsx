import { Link, useNavigate } from "react-router-dom";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import { burst } from "../lib/burst";
import type { RecommendMode, RecommendedPick } from "../lib/recommend";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { toggleList, useSaved } from "../lib/watchlist";
import { Art } from "./Art";
import { Card, CardSkeleton, kindLabel, seedState, tagForMorph } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

const BADGE_LABEL: Record<RecommendedPick["badge"], string> = {
  queue: "IN MY LIST",
  because: "SIMILAR",
  taste: "TOP MATCH",
  fresh: "FRESH",
  gem: "ACCLAIMED",
};

/**
 * Personalized Next-Watch Curator Deck:
 * Combines explanation-backed recommendations (Unwatched My List queue, Seeded "Because you watched",
 * Genre/Lane calibration, Acclaimed, and Surprise discoveries) into an interactive 1+4 spotlight layout.
 */
export function NextWatchDeck({
  picks,
  topGenres,
  hasSignals,
  loading,
  mode,
  onMode,
  seeds,
  selectedSeedKey,
  onSelectSeed,
  seedTitle,
  hasWatchlist,
  hasBecause,
  onShuffle,
  onDismiss,
}: {
  picks: RecommendedPick[];
  topGenres: string[];
  hasSignals: boolean;
  loading?: boolean;
  mode: RecommendMode;
  onMode: (m: RecommendMode) => void;
  seeds?: { key: string; title: string }[];
  selectedSeedKey?: string;
  onSelectSeed?: (key: string) => void;
  seedTitle?: string;
  hasWatchlist: boolean;
  hasBecause: boolean;
  onShuffle: () => void;
  onDismiss: (media: RecommendedPick["media"]) => void;
}) {
  const nav = useNavigate();
  const modeInd = useSlidingIndicator();
  const lead = picks[0];
  const rest = picks.slice(1, 5);
  const leadSaved = useSaved(lead?.media.key ?? "");

  if (!loading && !picks.length) return null;

  const modes: { id: RecommendMode; label: string }[] = [
    { id: "for-you", label: "For you" },
    ...(hasWatchlist ? [{ id: "queue" as const, label: "My List" }] : []),
    ...(hasBecause
      ? [
          {
            id: "because" as const,
            label: seedTitle ? `Like ${seedTitle.length > 15 ? `${seedTitle.slice(0, 14)}…` : seedTitle}` : "Similar",
          },
        ]
      : []),
    { id: "acclaimed", label: "Acclaimed" },
    { id: "surprise", label: "Surprise" },
  ];

  const eyebrow = hasSignals
    ? topGenres.length
      ? `Personal curator · tuned to ${topGenres.slice(0, 3).join(" · ")}`
      : "Personal curator · updated from your activity"
    : "Curated discovery · watch or save titles to sharpen picks";

  const leadMedia = lead?.media;
  if (leadMedia) registerMedia(leadMedia);

  return (
    <section className="shelf next-watch" aria-label="Next watch recommendations">
      <SectionHead
        eyebrow={eyebrow}
        title="Next"
        accentWord="up for you"
        right={
          <div className="nw-ctrls">
            {mode === "because" && seeds && seeds.length > 1 && onSelectSeed && (
              <div className="nw-seed-pills" role="group" aria-label="Because you watched">
                {seeds.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={`chip ${selectedSeedKey === s.key ? "on" : ""}`}
                    onClick={() => onSelectSeed(s.key)}
                  >
                    {s.title.length > 18 ? `${s.title.slice(0, 17)}…` : s.title}
                  </button>
                ))}
              </div>
            )}
            <div className="seg-pills" role="tablist" aria-label="Recommendation focus" ref={modeInd}>
              {modes.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.id}
                  className={mode === m.id ? "on" : ""}
                  onClick={() => onMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="nav-btn nw-shuffle"
              onClick={onShuffle}
              title="Shuffle next-watch picks"
              aria-label="Shuffle next-watch picks"
            >
              <Icon name="shuffle" size={14} />
            </button>
          </div>
        }
      />

      {loading && !picks.length ? (
        <div className="nw-layout">
          <div className="nw-spotlight skeleton" />
          <div className="nw-grid">
            {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)}
          </div>
        </div>
      ) : lead && leadMedia ? (
        <div className="nw-layout">
          <article
            className="nw-spotlight"
            data-media-key={leadMedia.key}
            onMouseEnter={() => previewLight(leadMedia)}
            onMouseLeave={() => previewLight(null)}
          >
            <Link
              to={`/title/${encodeKey(leadMedia.key)}`}
              state={seedState(leadMedia)}
              viewTransition
              onClick={tagForMorph}
              className="nw-spot-art art-wrap gate-frame"
            >
              <Art media={leadMedia} variant="backdrop" hd eager />
              <span className="gate-brackets" aria-hidden><i /></span>
              {lead.showMatchPct && <span className="nw-match">{lead.matchPct}% MATCH</span>}
              <span className="nw-reason-tag">{BADGE_LABEL[lead.badge]}</span>
            </Link>

            <div className="nw-spot-body">
              <div className="nw-why">{lead.reason}</div>
              <h3>
                <Link to={`/title/${encodeKey(leadMedia.key)}`} state={seedState(leadMedia)} viewTransition>
                  {leadMedia.title}
                </Link>
              </h3>
              <div className="specs">
                <span className="hi">{kindLabel(leadMedia.kind, leadMedia.format)}</span>
                {leadMedia.year && <span>{leadMedia.year}</span>}
                {leadMedia.rating ? <span className="star">★ {leadMedia.rating.toFixed(1)}</span> : null}
                {leadMedia.genres.slice(0, 2).map((g) => <span key={g}>{g}</span>)}
              </div>
              {leadMedia.overview && <p>{leadMedia.overview}</p>}

              <div className="nw-acts">
                {!isUnreleasedMedia(leadMedia) && (
                  <button
                    type="button"
                    className="btn play sm"
                    onClick={() => nav(playHref(leadMedia), { viewTransition: true, state: { from: "app" } })}
                  >
                    <Icon name="play" size={14} /> Play now
                  </button>
                )}
                <button type="button" className="btn glass sm" onClick={() => openDossier(leadMedia)}>
                  <Icon name="layers" size={14} /> Quick view
                </button>
                <Link className="btn glass sm" to={`/title/${encodeKey(leadMedia.key)}`} state={seedState(leadMedia)} viewTransition>
                  Details <Icon name="arrowUR" size={13} />
                </Link>
                <button
                  type="button"
                  className={`btn glass sm icon ${leadSaved ? "on" : ""}`}
                  onClick={(e) => {
                    if (!leadSaved) burst(e.currentTarget);
                    toggleList(leadMedia);
                  }}
                  aria-pressed={leadSaved}
                  aria-label={leadSaved ? "Remove from My List" : "Add to My List"}
                  title={leadSaved ? "In My List" : "Add to My List"}
                >
                  <Icon name={leadSaved ? "check" : "plus"} size={15} />
                </button>
                <button
                  type="button"
                  className="btn glass sm icon nw-skip"
                  onClick={() => onDismiss(leadMedia)}
                  aria-label={`Not interested in ${leadMedia.title}`}
                  title="Not interested"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>
          </article>

          <div className="nw-grid">
            {rest.map((pick, i) => (
              <Card
                key={pick.media.key}
                media={pick.media}
                index={i}
                variant="landscape"
                extra={
                  <span className="nw-tag" title={pick.reason}>
                    {pick.badge === "taste" && pick.showMatchPct ? `${pick.matchPct}%` : BADGE_LABEL[pick.badge]}
                  </span>
                }
                sub={
                  <span className="nw-card-why" title={pick.reason}>
                    {pick.reason}
                  </span>
                }
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
