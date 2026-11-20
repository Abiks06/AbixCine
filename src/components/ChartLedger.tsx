import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import { rankMoves, type Move } from "../lib/ranks";
import type { Media } from "../lib/types";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { burst } from "../lib/burst";
import { toggleList, useSaved } from "../lib/watchlist";
import { Art } from "./Art";
import { kindLabel, MoveBadge, seedState } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

export interface ChartTab {
  id: string;
  label: string;
  chart?: string;
  items?: Media[];
  loading?: boolean;
}

/**
 * Interactive Split Chart Ledger:
 * Replaces repetitive giant hollow Top 10 poster carousels with a two-pane cinema chart:
 * a 10-row typographic ledger on the left synchronized with a live artwork + synopsis plinth on the right.
 */
export function ChartLedger({
  eyebrow = "Daily charts",
  title = "Top 10",
  accentWord = "right now",
  tabs,
  defaultTab,
}: {
  eyebrow?: string;
  title?: string;
  accentWord?: string;
  tabs: ChartTab[];
  defaultTab?: string;
}) {
  const nav = useNavigate();
  const tabInd = useSlidingIndicator();
  const visibleTabs = tabs.filter((t) => t.loading || (t.items?.length ?? 0) > 0);
  const [tabId, setTabId] = useState(defaultTab ?? tabs[0]?.id);
  const activeTab = visibleTabs.find((t) => t.id === tabId) ?? visibleTabs[0];
  const list = useMemo(() => (activeTab?.items ?? []).slice(0, 10), [activeTab?.items]);
  const [cursor, setCursor] = useState(0);
  const [moves, setMoves] = useState<Record<string, Move> | null>(null);

  useEffect(() => {
    setCursor(0);
  }, [activeTab?.id]);

  useEffect(() => {
    setMoves(activeTab?.chart && list.length ? rankMoves(activeTab.chart, list) : null);
  }, [activeTab?.chart, list]);

  const activeMedia = list[Math.min(cursor, Math.max(0, list.length - 1))];
  const saved = useSaved(activeMedia?.key ?? "");

  useEffect(() => {
    if (!activeMedia) return;
    registerMedia(activeMedia);
  }, [activeMedia]);

  if (!visibleTabs.length) return null;

  return (
    <section className="shelf ledger-section">
      <SectionHead
        eyebrow={moves ? `${eyebrow} · movement since yesterday` : eyebrow}
        title={title}
        accentWord={accentWord}
        right={
          visibleTabs.length > 1 ? (
            <div className="seg-pills" role="tablist" aria-label="Chart category" ref={tabInd}>
              {visibleTabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab?.id === t.id}
                  className={activeTab?.id === t.id ? "on" : ""}
                  onClick={() => setTabId(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />

      <div className="ledger">
        <div className="ledger-rows" role="list">
          {activeTab?.loading && !list.length
            ? Array.from({ length: 6 }, (_, i) => <div key={i} className="ledger-row skeleton" />)
            : list.map((m, i) => {
                registerMedia(m);
                const on = i === Math.min(cursor, list.length - 1);
                const mv = moves?.[m.key];
                const pick = () => {
                  setCursor(i);
                  previewLight(m);
                };
                return (
                  <div
                    key={m.key}
                    role="listitem"
                    className={`ledger-row ${on ? "on" : ""}`}
                    data-media-key={m.key}
                    onMouseEnter={pick}
                    onFocus={pick}
                  >
                    <span className="lg-num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="lg-thumb" aria-hidden><Art media={m} variant="poster" size="xs" eager /></span>
                    <span className="lg-move">{mv ? <MoveBadge move={mv} /> : <span className="lg-dot" />}</span>
                    <Link
                      to={`/title/${encodeKey(m.key)}`}
                      state={seedState(m)}
                      viewTransition
                      className="lg-title"
                    >
                      {m.title}
                    </Link>
                    <span className="lg-meta">
                      {m.year && <span>{m.year}</span>}
                      {m.genres[0] && <span>{m.genres[0]}</span>}
                    </span>
                    {m.rating ? <span className="star lg-rate">★ {m.rating.toFixed(1)}</span> : <span className="lg-rate" />}
                    <div className="lg-acts">
                      {!isUnreleasedMedia(m) && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Play ${m.title}`}
                          aria-label={`Play ${m.title}`}
                          onClick={() => nav(playHref(m), { viewTransition: true, state: { from: "app" } })}
                        >
                          <Icon name="play" size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        title="Quick dossier"
                        aria-label={`Quick inspect ${m.title}`}
                        onClick={() => openDossier(m)}
                      >
                        <Icon name="layers" size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
        </div>

        <aside className="ledger-preview" aria-label="Selected rank preview">
          {activeMedia ? (
            <div className="lp-card" data-media-key={activeMedia.key}>
              <Link
                to={`/title/${encodeKey(activeMedia.key)}`}
                state={seedState(activeMedia)}
                viewTransition
                className="lp-art gate-frame"
              >
                <Art media={activeMedia} variant="backdrop" hd eager />
                <span className="gate-brackets" aria-hidden><i /></span>
                <span className="lp-rank">№ {String(Math.min(cursor, list.length - 1) + 1).padStart(2, "0")}</span>
              </Link>
              <div className="lp-body">
                <span className="lp-watermark" aria-hidden>{String(Math.min(cursor, list.length - 1) + 1).padStart(2, "0")}</span>
                <div className="specs">
                  <span className="hi">{kindLabel(activeMedia.kind, activeMedia.format)}</span>
                  {activeMedia.year && <span>{activeMedia.year}</span>}
                  {activeMedia.rating ? <span className="star">★ {activeMedia.rating.toFixed(1)}</span> : null}
                  {activeMedia.genres.slice(0, 2).map((g) => <span key={g}>{g}</span>)}
                </div>
                <h3>
                  <Link to={`/title/${encodeKey(activeMedia.key)}`} state={seedState(activeMedia)} viewTransition>
                    {activeMedia.title}
                  </Link>
                </h3>
                {activeMedia.overview && <p>{activeMedia.overview}</p>}
                <div className="lp-acts">
                  {!isUnreleasedMedia(activeMedia) && (
                    <button
                      type="button"
                      className="btn play sm"
                      onClick={() => nav(playHref(activeMedia), { viewTransition: true, state: { from: "app" } })}
                    >
                      <Icon name="play" size={14} /> Play
                    </button>
                  )}
                  <button type="button" className="btn glass sm" onClick={() => openDossier(activeMedia)}>
                    <Icon name="layers" size={14} /> Pass
                  </button>
                  <Link className="btn glass sm" to={`/title/${encodeKey(activeMedia.key)}`} state={seedState(activeMedia)} viewTransition>
                    Dossier <Icon name="arrowUR" size={13} />
                  </Link>
                  <button
                    type="button"
                    className={`btn glass sm icon ${saved ? "on" : ""}`}
                    onClick={(e) => {
                      if (!saved) burst(e.currentTarget);
                      toggleList(activeMedia);
                    }}
                    aria-pressed={saved}
                    aria-label={saved ? "Remove from My List" : "Add to My List"}
                  >
                    <Icon name={saved ? "check" : "plus"} size={15} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="lp-empty skeleton" />
          )}
        </aside>
      </div>
    </section>
  );
}
