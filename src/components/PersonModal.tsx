import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { anilistStaff } from "../lib/anilist";
import { fmtDate } from "../lib/format";
import { tmdbPerson, type PersonDetail } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { useModalFocusTrap } from "../lib/useModalFocusTrap";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import type { MediaKind } from "../lib/types";
import { Card } from "./Card";
import { Icon } from "./Icon";

export interface PersonTarget {
  id?: number;
  source?: "tmdb" | "anilist";
  name: string;
  photo?: string;
  role?: string;
}

type CreditFilter = "all" | MediaKind;

const FILTERS: { id: CreditFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "movie", label: "Films" },
  { id: "tv", label: "Series" },
  { id: "anime", label: "Anime" },
];

/**
 * Interactive Cast & Filmmaker Spotlight modal:
 * Shows actor/director bio, origin, and clickable filterable filmography cards.
 */
export function PersonModal({ person, onClose }: { person: PersonTarget | null; onClose: () => void }) {
  if (!person) return null;
  return createPortal(<PersonModalBody key={`${person.source ?? "tmdb"}:${person.id ?? person.name}`} person={person} onClose={onClose} />, document.body);
}

function PersonModalBody({ person, onClose }: { person: PersonTarget; onClose: () => void }) {
  const nav = useNavigate();
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const filterInd = useSlidingIndicator();
  const [filter, setFilter] = useState<CreditFilter>("all");
  const [bioFull, setBioFull] = useState(false);

  useModalFocusTrap(true, modalRef);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const res = useAsync(
    async (): Promise<PersonDetail | null> => {
      if (!person.id) return null;
      return person.source === "anilist" ? anilistStaff(person.id, person.name) : tmdbPerson(person.id, person.name);
    },
    [person.id, person.source, person.name],
  );

  const d = res.data;
  const credits = useMemo(() => d?.credits ?? [], [d]);
  const counts = useMemo(() => {
    const c: Record<CreditFilter, number> = { all: credits.length, movie: 0, tv: 0, anime: 0 };
    for (const item of credits) c[item.kind] += 1;
    return c;
  }, [credits]);

  const activeFilter: CreditFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  const shown = useMemo(
    () => (activeFilter === "all" ? credits : credits.filter((c) => c.kind === activeFilter)),
    [credits, activeFilter],
  );

  const displayName = d?.name || person.name;
  const displayPhoto = d?.photo || person.photo;
  const metaParts = [
    d?.knownFor || person.role,
    d?.birthday ? `Born ${fmtDate(d.birthday) ?? d.birthday}${d.deathday ? ` – ${fmtDate(d.deathday) ?? d.deathday}` : ""}` : null,
    d?.placeOfBirth,
  ].filter(Boolean);

  return (
    <div
      className="person-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="person-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${displayName} filmography`}
        tabIndex={-1}
      >
        <div className="pm-head">
          <div className="pm-profile">
            <div className="pm-avatar" style={displayPhoto ? { backgroundImage: `url(${displayPhoto})` } : undefined}>
              {!displayPhoto && <span>{displayName[0] ?? "?"}</span>}
            </div>
            <div className="pm-identity">
              <span className="overline">{person.source === "anilist" ? "Creator · Voice Cast" : "Cast & Crew"}</span>
              <h2>{displayName}</h2>
              {metaParts.length > 0 && <p className="pm-meta">{metaParts.join(" · ")}</p>}
              {d?.biography && (
                <div className="pm-bio-wrap">
                  <p className={`pm-bio ${bioFull ? "expanded" : ""}`}>{d.biography}</p>
                  {d.biography.length > 220 && (
                    <button type="button" className="link-btn pm-bio-toggle" onClick={() => setBioFull((x) => !x)}>
                      {bioFull ? "Show less" : "Read more"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <button ref={closeRef} type="button" className="icon-btn pm-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>

        <div className="pm-body">
          <div className="pm-bar">
            <h3>Known for {credits.length > 0 ? <small>({credits.length})</small> : null}</h3>
            {credits.length > 0 && (
              <div className="seg-pills" role="tablist" aria-label="Filter credits" ref={filterInd}>
                {FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={activeFilter === f.id}
                    className={activeFilter === f.id ? "on" : ""}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {res.loading && !credits.length ? (
            <div className="pm-grid">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="pm-skel skeleton" />
              ))}
            </div>
          ) : shown.length > 0 ? (
            <div className="pm-grid">
              {shown.map((credit, i) => (
                <Card
                  key={credit.key}
                  media={credit}
                  index={i}
                  variant="poster"
                  onOpen={onClose}
                  sub={
                    credit.role ? (
                      <span className="nw-card-why" title={credit.role}>
                        {credit.role}
                      </span>
                    ) : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="pm-empty">
              <p>No detailed filmography is cached for {displayName} yet.</p>
              <button
                type="button"
                className="btn glass sm"
                onClick={() => {
                  onClose();
                  nav(`/search?q=${encodeURIComponent(displayName)}`, { viewTransition: true });
                }}
              >
                <Icon name="search" size={14} /> Search catalog for {displayName}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
