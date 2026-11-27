import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import { useAuth } from "../lib/account";
import { getTrackingState, useAiringRadar, type TrackingKind } from "../lib/airing";
import { toAiringMs } from "../lib/format";
import { useProgressStore } from "../lib/progress";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import type { MediaKind } from "../lib/types";
import { toggleList, useWatchlist } from "../lib/watchlist";

type Kind = "all" | MediaKind;
type StatusFilter = "all" | TrackingKind;
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "movie", label: "Films" },
  { id: "tv", label: "Series" },
  { id: "anime", label: "Anime" },
];
const STATUSES: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All status" },
  { id: "new-episode", label: "New ep" },
  { id: "watching", label: "Watching" },
  { id: "caught-up", label: "Caught up" },
  { id: "unstarted", label: "Unstarted" },
  { id: "completed", label: "Completed" },
];
const SORTS = [
  { id: "recent", label: "Recently added" },
  { id: "airing", label: "Next airing" },
  { id: "watched", label: "Last watched" },
  { id: "title", label: "A–Z" },
  { id: "rating", label: "Top rated" },
] as const;
type Sort = (typeof SORTS)[number]["id"];

export function MyList() {
  const sortInd = useSlidingIndicator();
  const list = useWatchlist();
  const progressStore = useProgressStore();
  const { user } = useAuth();
  const [kind, setKind] = useState<Kind>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("recent");

  const watchlistMedia = useMemo(() => list.map((e) => e.media), [list]);
  const { airingMap, nowMs } = useAiringRadar(watchlistMedia);

  const enriched = useMemo(
    () =>
      list.map((e) => {
        const entry = progressStore[e.media.key];
        const tracking = getTrackingState(e.media, entry, airingMap[e.media.key], nowMs);
        const pct =
          entry && !entry.finished && !entry.caughtUp && !entry.upNext && entry.duration > 0
            ? Math.round((entry.position / entry.duration) * 100)
            : undefined;
        return { ...e, entry, tracking, pct };
      }),
    [list, progressStore, airingMap, nowMs],
  );

  const count = (k: Kind) => (k === "all" ? enriched.length : enriched.filter((e) => e.media.kind === k).length);
  const active: Kind = kind !== "all" && count(kind) === 0 ? "all" : kind;

  const statusCount = (s: StatusFilter) =>
    s === "all"
      ? enriched.filter((e) => active === "all" || e.media.kind === active).length
      : enriched.filter((e) => (active === "all" || e.media.kind === active) && e.tracking.kind === s).length;
  const activeStatus: StatusFilter = statusFilter !== "all" && statusCount(statusFilter) === 0 ? "all" : statusFilter;

  const shown = useMemo(() => {
    const out = enriched.filter(
      (e) =>
        (active === "all" || e.media.kind === active) &&
        (activeStatus === "all" || e.tracking.kind === activeStatus),
    );
    if (sort === "title") out.sort((a, b) => a.media.title.localeCompare(b.media.title));
    else if (sort === "rating") out.sort((a, b) => (b.media.rating ?? 0) - (a.media.rating ?? 0));
    else if (sort === "watched") out.sort((a, b) => (b.entry?.updatedAt ?? 0) - (a.entry?.updatedAt ?? 0) || b.addedAt - a.addedAt);
    else if (sort === "airing") {
      out.sort((a, b) => {
        const ta = a.tracking.kind === "new-episode" ? 0 : (a.tracking.nextAiring ? toAiringMs(a.tracking.nextAiring.at) : Number.MAX_SAFE_INTEGER);
        const tb = b.tracking.kind === "new-episode" ? 0 : (b.tracking.nextAiring ? toAiringMs(b.tracking.nextAiring.at) : Number.MAX_SAFE_INTEGER);
        return ta - tb || b.addedAt - a.addedAt;
      });
    } else out.sort((a, b) => b.addedAt - a.addedAt);
    return out;
  }, [enriched, active, activeStatus, sort]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">My <em>List</em></h1>
        </div>
        <span className="grow" />
        {list.length > 0 && <span className="shelf-note">{list.length} title{list.length === 1 ? "" : "s"} · {user ? "synced to your account" : "saved on this PC"}</span>}
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <span className="empty-ic"><Icon name="bookmark" size={26} /></span>
          <h3>Nothing saved yet</h3>
          <p>Press the <b>+</b> on any title and it shows up here{user ? ", on every device you sign in to" : ""}.</p>
          <Link to="/" className="btn play sm" viewTransition>Find something to watch</Link>
        </div>
      ) : (
        <>
          <div className="filter-bar">
            <div className="tabs">
              {KINDS.filter((k) => k.id === "all" || count(k.id) > 0).map((k) => (
                <button key={k.id} className={`chip ${active === k.id ? "on" : ""}`} onClick={() => setKind(k.id)}>
                  {k.label}
                  <small>{count(k.id)}</small>
                </button>
              ))}
            </div>
            <div className="tabs">
              {STATUSES.filter((s) => s.id === "all" || statusCount(s.id) > 0).map((s) => (
                <button key={s.id} className={`chip ${activeStatus === s.id ? "on" : ""}`} onClick={() => setStatusFilter(s.id)}>
                  {s.label}
                  {s.id !== "all" && <small>{statusCount(s.id)}</small>}
                </button>
              ))}
            </div>
            <div className="seg-pills" role="radiogroup" aria-label="Sort" ref={sortInd}>
              {SORTS.map((o) => (
                <button key={o.id} role="radio" aria-checked={sort === o.id} className={sort === o.id ? "on" : ""} onClick={() => setSort(o.id)}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="grid">
            {shown.map((e, i) => (
              <Card
                key={e.media.key}
                media={e.media}
                index={i}
                progress={e.pct}
                tracking={e.tracking}
                onRemove={() => toggleList(e.media)}
                removeLabel={`Remove ${e.media.title} from My List`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
