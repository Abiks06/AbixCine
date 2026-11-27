import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getTrackingState, useAiringRadar } from "../lib/airing";
import { encodeKey } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { fmtEpCode } from "../lib/format";
import { previewLight } from "../lib/light";
import { watchHref } from "../lib/play";
import { useCaughtUp, type ProgressEntry } from "../lib/progress";
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
  const [showAll, setShowAll] = useState(false);
  const caughtUpRaw = useCaughtUp();
  const trackedMedia = useMemo(
    () => [...items.map((x) => x.media), ...caughtUpRaw.map((x) => x.media)],
    [items, caughtUpRaw],
  );
  const { airingMap, nowMs } = useAiringRadar(trackedMedia);

  // Separate auto-promoted "new episode out now" shows (promoted into ActiveReel!) from still-waiting caught-up shows.
  const { promoted, waitingCaughtUp } = useMemo(() => {
    const prom: { entry: ProgressEntry; nextPlay: { season?: number; episode: number }; badge: string }[] = [];
    const wait: { entry: ProgressEntry; badge: string; detail?: string }[] = [];
    for (const p of caughtUpRaw) {
      const st = getTrackingState(p.media, p, airingMap[p.media.key], nowMs);
      if (st.kind === "new-episode" && st.nextPlay) {
        prom.push({ entry: p, nextPlay: st.nextPlay, badge: st.badge ?? "NEW EP" });
      } else {
        wait.push({ entry: p, badge: st.badge ?? "Caught up", detail: st.detail });
      }
    }
    return { promoted: prom, waitingCaughtUp: wait };
  }, [caughtUpRaw, airingMap, nowMs]);

  type ReelEntry = { entry: ProgressEntry; isNewEp?: boolean; newBadge?: string; targetSeason?: number; targetEpisode?: number };
  const mergedItems: ReelEntry[] = useMemo(() => {
    const out: ReelEntry[] = promoted.map((x) => ({
      entry: x.entry,
      isNewEp: true,
      newBadge: x.badge,
      targetSeason: x.nextPlay.season ?? x.entry.season,
      targetEpisode: x.nextPlay.episode,
    }));
    const promKeys = new Set(out.map((x) => x.entry.media.key));
    for (const p of items) {
      if (!promKeys.has(p.media.key)) out.push({ entry: p });
    }
    return out;
  }, [promoted, items]);

  if (!mergedItems.length && !waitingCaughtUp.length) return null;

  const leadObj = mergedItems[0];
  const lead = leadObj?.entry;
  const maxQueue = showAll ? mergedItems.length : 7;
  const queue = mergedItems.slice(1, maxQueue);
  const leadMeta = lead ? fmtWhere(lead) : null;
  const leadPct = lead && !lead.upNext && !leadObj.isNewEp && lead.duration > 0 ? Math.min(1, Math.max(0.02, lead.position / lead.duration)) : 0;
  const leadMin = lead && lead.duration > 0 ? Math.round(lead.position / 60) : 0;
  const leadTotalMin = lead && lead.duration > 0 ? Math.round(lead.duration / 60) : 0;
  if (lead) registerMedia(lead.media);
  const leadSeason = leadObj?.targetSeason ?? lead?.season;
  const leadEpisode = leadObj?.targetEpisode ?? lead?.episode;

  return (
    <section className="shelf active-reel" id="active-reel" aria-label="Continue watching">
      <SectionHead
        eyebrow="Pick up where you left off"
        title="On the"
        accentWord="reel"
        right={
          <div className="reel-head-right">
            {waitingCaughtUp.length > 0 && (
              <span className="shelf-note caught-up-note">{waitingCaughtUp.length} CAUGHT UP</span>
            )}
            {mergedItems.length > 0 && <span className="shelf-note">{mergedItems.length} ACTIVE</span>}
            {mergedItems.length > 7 && (
              <button type="button" className="chip" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${mergedItems.length}`}
              </button>
            )}
          </div>
        }
      />

      {lead && (
      <div className="reel-grid">
        <article
          className="reel-lead"
          data-media-key={lead.media.key}
          onMouseEnter={() => previewLight(lead.media)}
          onMouseLeave={() => previewLight(null)}
        >
          <Link
            to={watchHref(lead.media.key, leadSeason, leadEpisode, lead.audio)}
            state={{ from: "app" }}
            viewTransition
            className="reel-lead-art gate-frame"
          >
            <Art media={lead.media} variant="backdrop" hd eager />
            <span className="gate-brackets" aria-hidden><i /></span>
            <span className={`reel-code ${leadObj.isNewEp ? "new-ep" : ""}`}>
              {leadObj.isNewEp ? (leadObj.newBadge ?? "NEW EPISODE") : "ACTIVE REEL"}
            </span>
            {!lead.upNext && !leadObj.isNewEp && lead.duration > 0 && (
              <div className="reel-prog"><i style={{ transform: `scaleX(${leadPct})` }} /></div>
            )}
          </Link>

          <div className="reel-lead-body">
            <div className="reel-kicker">
              <span className="badge">{kindLabel(lead.media.kind, lead.media.format)}</span>
              <span>
                {leadObj.isNewEp
                  ? `${fmtEpCode(leadSeason, leadEpisode)} · Just aired`
                  : leadMeta?.line || "In progress"}
              </span>
            </div>
            <h3>
              <Link to={`/title/${encodeKey(lead.media.key)}`} state={seedState(lead.media)} viewTransition>
                {lead.media.title}
              </Link>
            </h3>
            {!lead.upNext && !leadObj.isNewEp && leadTotalMin > 0 && leadMeta && (
              <div className="reel-timecode">
                <b>{leadMin}m</b> / {leadTotalMin}m · {leadMeta.left}m remaining
              </div>
            )}
            <div className="reel-acts">
              <button
                type="button"
                className="btn play sm"
                onClick={() => nav(watchHref(lead.media.key, leadSeason, leadEpisode, lead.audio), { viewTransition: true, state: { from: "app" } })}
              >
                <Icon name="play" size={14} /> {leadObj.isNewEp ? `Play ${fmtEpCode(leadSeason, leadEpisode)}` : lead.upNext ? "Play next" : "Resume"}
              </button>
              <button type="button" className="btn glass sm" onClick={() => openDossier(lead.media)}>
                <Icon name="layers" size={14} /> Quick view
              </button>
              <Link className="btn glass sm icon" to={`/title/${encodeKey(lead.media.key)}`} state={seedState(lead.media)} viewTransition title="Details" aria-label={`Details for ${lead.media.title}`}>
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
            {queue.map(({ entry: p, isNewEp, newBadge, targetSeason, targetEpisode }) => {
              registerMedia(p.media);
              const meta = fmtWhere(p);
              const sNum = targetSeason ?? p.season;
              const eNum = targetEpisode ?? p.episode;
              const pct = isNewEp || p.upNext || !(p.duration > 0) ? null : Math.min(1, Math.max(0.03, p.position / p.duration));
              const airInfo = airingMap[p.media.key]?.nextAiring ?? p.media.nextAiring;
              const subLine = isNewEp
                ? (newBadge ?? `NEW ${fmtEpCode(sNum, eNum)}`)
                : [meta.line, airInfo ? `Next ${fmtEpCode(airInfo.season ?? p.season, airInfo.episode)}` : null].filter(Boolean).join(" · ");
              return (
                <div
                  key={p.media.key}
                  className={`reel-item ${isNewEp ? "new-ep" : ""}`}
                  data-media-key={p.media.key}
                  onMouseEnter={() => previewLight(p.media)}
                  onMouseLeave={() => previewLight(null)}
                >
                  <Link
                    to={watchHref(p.media.key, sNum, eNum, p.audio)}
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
                      <span>{subLine}</span>
                    </div>
                  </Link>
                  <div className="reel-item-acts">
                    <button type="button" className="icon-btn" onClick={() => openDossier(p.media)} title="Quick view" aria-label={`Quick view ${p.media.title}`}>
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
      )}

      {waitingCaughtUp.length > 0 && (
        <div className="reel-caught-strip" id="caught-up-strip" aria-label="Caught up shows waiting for next episode">
          <span className="reel-caught-lbl">
            <Icon name="check" size={13} /> Caught up · waiting for next episode
          </span>
          <div className="reel-caught-list">
            {waitingCaughtUp.map(({ entry: p, badge, detail }) => {
              registerMedia(p.media);
              return (
                <Link
                  key={p.media.key}
                  to={`/title/${encodeKey(p.media.key)}`}
                  state={seedState(p.media)}
                  viewTransition
                  className="reel-caught-pill"
                  data-media-key={p.media.key}
                  title={detail || badge}
                  onMouseEnter={() => previewLight(p.media)}
                  onMouseLeave={() => previewLight(null)}
                >
                  <span className="reel-caught-th"><Art media={p.media} variant="poster" size="xs" /></span>
                  <span className="reel-caught-tx">
                    <b>{p.media.title}</b>
                    <small>{[p.episode != null ? `${fmtEpCode(p.season, p.episode)} done` : null, badge].filter(Boolean).join(" · ")}</small>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
