/**
 * The player's side-sheet lists (servers, episodes) and the Up next card.
 * Split out of Player.tsx (PERF-06); behaviour is unchanged.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isUnairedEpisode } from "../../lib/catalog";
import { UP_NEXT_AT } from "../../lib/playerControls";
import type { Episode } from "../../lib/types";
import type { SessionSnapshot } from "../../sources/session";
import type { StreamCandidate } from "../../sources/types";
import { Icon } from "../Icon";
import { SourceBoard } from "../SourceBoard";
import type { EpisodeNav } from "./shared";

/* ------------------------------------------------------------------ servers */

export const ServerSheet = memo(function ServerSheet({
  snap,
  playingKey,
  busyKey,
  busyNote,
  onPick,
  onCheckAll,
  onStop,
  onRefreshList,
}: {
  snap: SessionSnapshot;
  /** The stream on screen, once it is actually playing. */
  playingKey?: string;
  busyKey: string | null;
  busyNote: string;
  onPick: (c: StreamCandidate) => void;
  onCheckAll: () => void;
  onStop: () => void;
  onRefreshList?: () => void;
}) {
  const checkingMore = snap.busy && snap.checking.size > 0;
  return (
    <div className="ps-section">
      <p className="ps-note">Every server plays in AbixCine's own player, so there are no ads. Switching keeps your place, and a server you pick here stays this show's server.</p>
      {(snap.waiting > 0 || checkingMore || onRefreshList) && (
        <div className="srv-actions">
          {(snap.waiting > 0 || checkingMore) && (
            <button
              type="button"
              className={`srv-act ${checkingMore ? "busy" : ""}`}
              onClick={checkingMore ? onStop : onCheckAll}
              title={checkingMore ? "Stop checking" : "Check the servers on standby without interrupting playback"}
            >
              {checkingMore ? (
                <>
                  <span className="mini-spin" />
                  <span>Checking {snap.checking.size}… stop</span>
                </>
              ) : (
                <>
                  <Icon name="layers" size={14} />
                  <span>Check standby servers ({snap.waiting})</span>
                </>
              )}
            </button>
          )}
          {onRefreshList && (
            <button type="button" className="srv-act" onClick={onRefreshList} title="Throw the list away and look for servers again">
              <Icon name="refresh" size={14} />
              <span>Look again</span>
            </button>
          )}
        </div>
      )}
      <SourceBoard snap={snap} playingKey={playingKey} busyKey={busyKey} busyNote={busyNote} onPick={onPick} />
    </div>
  );
});

/* ----------------------------------------------------------------- episodes */

const PAGE = 50;

export const EpisodeSheet = memo(function EpisodeSheet({ nav, onPick }: { nav: EpisodeNav; onPick: (s: number | undefined, e: number) => void }) {
  const validSeasons = useMemo(() => (nav.seasons ?? []).filter((s) => s.episodeCount > 0), [nav.seasons]);
  const initialSeason = useMemo(() => {
    if (!validSeasons.length) return nav.season;
    if (nav.season != null && validSeasons.some((s) => s.number === nav.season)) return nav.season;
    return validSeasons[0].number;
  }, [validSeasons, nav.season]);

  const [season, setSeason] = useState(initialSeason);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const curRef = useRef<HTMLButtonElement>(null);
  const total = nav.count ?? 0;
  const safeNavEp = Number.isFinite(nav.episode) && nav.episode >= 1 ? Math.floor(nav.episode) : 1;
  // Long-running anime (1000+ episodes) is paged in blocks of 50 around the current one.
  const [page, setPage] = useState(() => Math.max(0, Math.floor((safeNavEp - 1) / PAGE)));
  const [known, setKnown] = useState<Map<number, Episode>>(new Map());
  useEffect(() => {
    if (season != null || !nav.loadAll) return;
    let live = true;
    nav.loadAll().then((list) => live && setKnown(new Map(list.map((e) => [e.number, e])))).catch(() => {});
    return () => {
      live = false;
    };
  }, [season, nav.loadAll]);

  useEffect(() => {
    if (season == null || !nav.loadSeason) return setEps(null);
    let live = true;
    setEps(null);
    nav.loadSeason(season).then((r) => live && setEps(r)).catch(() => live && setEps([]));
    return () => {
      live = false;
    };
  }, [season, nav.loadSeason]);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: "center" });
  }, [eps, page]);

  const fullList: Episode[] =
    season != null
      ? eps ?? []
      : Array.from({ length: Math.max(0, total) }, (_, i) => known.get(i + 1) ?? { season: 0, number: i + 1, title: `Episode ${i + 1}` });
  const pages = Math.max(1, Math.ceil(fullList.length / PAGE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const list = fullList.length > PAGE ? fullList.slice(safePage * PAGE, (safePage + 1) * PAGE) : fullList;

  return (
    <div className="ps-section">
      {validSeasons.length > 1 && (
        <div className="season-strip">
          {validSeasons.map((s) => (
            <button
              key={s.number}
              className={s.number === season ? "on" : ""}
              onClick={() => {
                setSeason(s.number);
                setPage(0);
              }}
            >
              {s.number === 0 ? "Specials" : s.name.length <= 10 ? s.name : `S${s.number}`}
            </button>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="season-strip">
          {Array.from({ length: pages }, (_, p) => (
            <button key={p} className={p === safePage ? "on" : ""} onClick={() => setPage(p)}>
              {p * PAGE + 1}–{Math.min(fullList.length, (p + 1) * PAGE)}
            </button>
          ))}
        </div>
      )}
      <div className="ep-list">
        {season != null && !eps && Array.from({ length: 5 }, (_, i) => <div key={i} className="ep-row skeleton" />)}
        {season != null && eps && list.length === 0 && <p className="ps-note">No episodes available for this season.</p>}
        {list.map((e, i) => {
          const isCur = e.number === safeNavEp && (season ?? undefined) === nav.season;
          const unaired = isUnairedEpisode(e);
          const still = e.still ?? nav.fallbackStill;
          return (
            <button
              key={e.number}
              ref={isCur ? curRef : undefined}
              disabled={unaired}
              className={`ep-row ${isCur ? "cur" : ""} ${unaired ? "unaired" : ""}`}
              style={{ ["--i" as any]: Math.min(i, 10) }}
              title={unaired ? `Not aired yet${e.airDate ? ` (${e.airDate})` : ""}` : undefined}
              onClick={() => !isCur && !unaired && onPick(season, e.number)}
            >
              <span className="ep-th">
                {still ? <img src={still} alt="" loading="lazy" /> : null}
                <b>{e.number}</b>
                {isCur && <span className="eq small" aria-label="Playing"><i /><i /><i /><i /></span>}
              </span>
              <span className="ep-tx">
                <span className="ep-t">{e.title}{unaired ? " · Upcoming" : ""}</span>
                <span className="ep-d">{unaired && e.airDate ? `Airs ${e.airDate}` : [e.runtime ? `${e.runtime}m` : null, e.overview].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ up next */

export function UpNext({ label, still, seconds, auto, onPlay, onDismiss }: { label: string; still?: string; seconds: number; auto: boolean; onPlay: () => void; onDismiss: () => void }) {
  return (
    <div className="upnext" onClick={(e) => e.stopPropagation()}>
      <div className="un-th" style={still ? { backgroundImage: `url(${still})` } : undefined}>
        <button className="un-play" onClick={onPlay} aria-label="Play next episode">
          <svg viewBox="0 0 36 36" className="un-ring" aria-hidden>
            <circle cx="18" cy="18" r="16" style={{ ["--p" as any]: auto ? Math.max(0, Math.min(1, seconds / UP_NEXT_AT)) : 1 }} />
          </svg>
          <Icon name="play" size={16} />
        </button>
      </div>
      <div className="un-tx">
        <small>{auto ? `Up next in ${seconds}s` : "Up next"}</small>
        <strong>{label}</strong>
        <div className="un-acts">
          <button className="btn play sm" onClick={onPlay}>Play now</button>
          <button className="btn glass sm" onClick={onDismiss}>Keep watching</button>
        </div>
      </div>
    </div>
  );
}
