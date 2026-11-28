import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import { useAuth } from "../lib/account";
import { computeActivityStats } from "../lib/activityStats";
import { getTrackingState, useAiringRadar, type TrackingKind } from "../lib/airing";
import { createCollection, deleteCollection, toggleInCollection, useCollections } from "../lib/collections";
import { fmtAgo, fmtEpCode, toAiringMs } from "../lib/format";
import { getDetail } from "../lib/catalog";
import { useProgressStore, type ProgressEntry } from "../lib/progress";
import { toast } from "../lib/toast";
import { isFilm, type MediaKind } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { toggleList, useWatchlist } from "../lib/watchlist";

type MainTab = "list" | "history";
type Kind = "all" | MediaKind;
type StatusFilter = "all" | TrackingKind;
type HistoryFilter = "all" | "watching" | "caught-up" | "completed";

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

const HISTORY_FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "watching", label: "In progress" },
  { id: "caught-up", label: "Caught up" },
  { id: "completed", label: "Completed" },
];

export function MyList() {
  const [params, setParams] = useSearchParams();
  const mainTab: MainTab = params.get("tab") === "history" ? "history" : "list";
  const tabInd = useSlidingIndicator();
  const sortInd = useSlidingIndicator();
  const histInd = useSlidingIndicator();

  const list = useWatchlist();
  const progressStore = useProgressStore();
  const collections = useCollections();
  const { user } = useAuth();

  const [kind, setKind] = useState<Kind>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [activeCollectionId, setActiveCollectionId] = useState<string>("all");
  const [addingCol, setAddingCol] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");

  const stats = useMemo(
    () => computeActivityStats(Object.values(progressStore), list.length),
    [progressStore, list.length],
  );

  // Also resolve media metadata for keys stored inside custom collections even if not in My List
  const extraCollectionKeys = useMemo(() => {
    const wlKeys = new Set(list.map((e) => e.media.key));
    const missing: string[] = [];
    for (const c of collections) {
      for (const k of c.keys) {
        if (!wlKeys.has(k) && !progressStore[k] && !missing.includes(k)) missing.push(k);
      }
    }
    return missing.slice(0, 24);
  }, [collections, list, progressStore]);

  const extraSig = extraCollectionKeys.join("|");
  const extraMediaRes = useAsync(
    async () => {
      if (!extraCollectionKeys.length) return {};
      const settled = await Promise.allSettled(extraCollectionKeys.map((k) => getDetail(k)));
      const map: Record<string, ProgressEntry["media"]> = {};
      for (const r of settled) {
        if (r.status === "fulfilled" && r.value?.key) map[r.value.key] = r.value;
      }
      return map;
    },
    [extraSig],
    { keepPrevious: true },
  );

  const selectedCollection = collections.find((c) => c.id === activeCollectionId) ?? null;
  const effectiveCollectionId = selectedCollection ? selectedCollection.id : "all";

  const collectionMediaEntries = useMemo(() => {
    if (!selectedCollection) return list;
    const byKey = new Map(list.map((e) => [e.media.key, e]));
    const extraMap = extraMediaRes.data ?? {};
    return selectedCollection.keys
      .map((k) => {
        const wl = byKey.get(k);
        if (wl) return wl;
        const fromProg = progressStore[k]?.media;
        const fromExtra = extraMap[k];
        const media = fromProg ?? fromExtra;
        return media ? { media, addedAt: selectedCollection.updatedAt } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [selectedCollection, list, progressStore, extraMediaRes.data]);

  const radarMedia = useMemo(() => {
    const seen = new Set<string>();
    const out: ProgressEntry["media"][] = [];
    for (const e of collectionMediaEntries) {
      if (!seen.has(e.media.key)) {
        seen.add(e.media.key);
        out.push(e.media);
      }
    }
    for (const p of stats.history) {
      if (!seen.has(p.media.key)) {
        seen.add(p.media.key);
        out.push(p.media);
      }
    }
    return out;
  }, [collectionMediaEntries, stats.history]);
  const { airingMap, nowMs } = useAiringRadar(radarMedia);

  const enriched = useMemo(
    () =>
      collectionMediaEntries.map((e) => {
        const entry = progressStore[e.media.key];
        const tracking = getTrackingState(e.media, entry, airingMap[e.media.key], nowMs);
        const pct =
          entry && !entry.finished && !entry.caughtUp && !entry.upNext && entry.duration > 0
            ? Math.round((entry.position / entry.duration) * 100)
            : undefined;
        return { ...e, entry, tracking, pct };
      }),
    [collectionMediaEntries, progressStore, airingMap, nowMs],
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

  const enrichedHistory = useMemo(
    () =>
      stats.history.map((entry) => {
        const tracking = getTrackingState(entry.media, entry, airingMap[entry.media.key], nowMs);
        const pct =
          !entry.finished && !entry.caughtUp && !entry.upNext && entry.duration > 0
            ? Math.round((entry.position / entry.duration) * 100)
            : entry.finished
              ? 100
              : undefined;
        const bucket: HistoryFilter = entry.finished
          ? "completed"
          : entry.caughtUp
            ? "caught-up"
            : "watching";
        return { entry, tracking, pct, bucket };
      }),
    [stats.history, airingMap, nowMs],
  );

  const shownHistory = useMemo(
    () =>
      historyFilter === "all"
        ? enrichedHistory
        : enrichedHistory.filter((h) => h.bucket === historyFilter),
    [enrichedHistory, historyFilter],
  );

  const handleCreateCollection = (e: React.FormEvent) => {
    e.preventDefault();
    const created = createCollection(newColName);
    if (!created) return;
    setNewColName("");
    setAddingCol(false);
    setActiveCollectionId(created.id);
    toast(`Created collection “${created.name}”`, { icon: "folder" });
  };

  const setTab = (t: MainTab) => {
    if (t === "history") setParams({ tab: "history" }, { replace: true });
    else setParams({}, { replace: true });
  };

  const showStats = stats.history.length > 0 || list.length > 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {mainTab === "history" ? <>Watch <em>History</em></> : <>My <em>List</em></>}
          </h1>
        </div>
        <div className="seg-pills" role="tablist" aria-label="List view" ref={tabInd}>
          <button type="button" role="tab" aria-selected={mainTab === "list"} className={mainTab === "list" ? "on" : ""} onClick={() => setTab("list")}>
            My List <small>{list.length}</small>
          </button>
          <button type="button" role="tab" aria-selected={mainTab === "history"} className={mainTab === "history" ? "on" : ""} onClick={() => setTab("history")}>
            History <small>{stats.history.length}</small>
          </button>
        </div>
        <span className="grow" />
        {(list.length > 0 || stats.history.length > 0) && (
          <span className="shelf-note">{user ? "Synced to your account" : "Saved on this PC"}</span>
        )}
      </div>

      {showStats && (
        <section className="ml-stats" aria-label="Viewing activity summary">
          <div className="ml-stat">
            <span>Hours watched</span>
            <strong>{stats.totalHours}h</strong>
            <small>{stats.history.length} title{stats.history.length === 1 ? "" : "s"} tracked</small>
          </div>
          <div className="ml-stat">
            <span>Completed</span>
            <strong>{stats.completedEpisodes} ep · {stats.finishedFilms} film{stats.finishedFilms === 1 ? "" : "s"}</strong>
            <small>Across your history</small>
          </div>
          <div className="ml-stat">
            <span>Ongoing radar</span>
            <strong>{stats.caughtUpShows} caught up</strong>
            <small>{stats.activeShows} active in queue</small>
          </div>
          <div className="ml-stat">
            <span>Top taste</span>
            <strong>{stats.topGenres[0]?.genre ?? "Ready"}</strong>
            <small>
              {stats.topGenres[0]
                ? `${stats.topGenres[0].pct}% affinity${stats.topGenres[1] ? ` · ${stats.topGenres[1].genre}` : ""}`
                : `${list.length} in My List`}
            </small>
          </div>
        </section>
      )}

      {mainTab === "list" ? (
        <>
          <div className="ml-collections" aria-label="Custom collections">
            <button
              type="button"
              className={`chip ml-col-chip ${effectiveCollectionId === "all" ? "on" : ""}`}
              onClick={() => setActiveCollectionId("all")}
            >
              All saved <small>{list.length}</small>
            </button>
            {collections.map((c) => {
              const on = effectiveCollectionId === c.id;
              return (
                <span key={c.id} className={`ml-col-pill ${on ? "on" : ""}`}>
                  <button
                    type="button"
                    className={`chip ml-col-chip ${on ? "on" : ""}`}
                    onClick={() => setActiveCollectionId(c.id)}
                  >
                    <Icon name="folder" size={12} />
                    <span>{c.name}</span>
                    <small>{c.keys.length}</small>
                  </button>
                  <button
                    type="button"
                    className="ml-col-del"
                    aria-label={`Delete collection ${c.name}`}
                    title={`Delete ${c.name}`}
                    onClick={() => {
                      deleteCollection(c.id);
                      if (effectiveCollectionId === c.id) setActiveCollectionId("all");
                      toast(`Deleted collection “${c.name}”`, { icon: "trash" });
                    }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              );
            })}
            {addingCol ? (
              <form className="ml-col-form" onSubmit={handleCreateCollection}>
                <input
                  type="text"
                  autoFocus
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  placeholder="Collection name…"
                  maxLength={48}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setAddingCol(false);
                      setNewColName("");
                    }
                  }}
                />
                <button type="submit" className="btn glass sm" disabled={!newColName.trim()}>Create</button>
              </form>
            ) : (
              <button type="button" className="chip ml-col-new" onClick={() => setAddingCol(true)}>
                <Icon name="plus" size={12} /> New collection
              </button>
            )}
          </div>

          {collectionMediaEntries.length === 0 ? (
            <div className="empty">
              <span className="empty-ic"><Icon name={selectedCollection ? "folder" : "bookmark"} size={26} /></span>
              <h3>{selectedCollection ? `Nothing in “${selectedCollection.name}” yet` : "Nothing saved yet"}</h3>
              <p>
                {selectedCollection
                  ? "Open any title and click Collect to add films, series, or anime to this collection."
                  : `Press the + button on any title and it shows up here${user ? ", on every device you sign in to" : ""}.`}
              </p>
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
                    onRemove={() =>
                      selectedCollection
                        ? toggleInCollection(selectedCollection.id, e.media.key)
                        : toggleList(e.media)
                    }
                    removeLabel={
                      selectedCollection
                        ? `Remove ${e.media.title} from ${selectedCollection.name}`
                        : `Remove ${e.media.title} from My List`
                    }
                  />
                ))}
              </div>
            </>
          )}
        </>
      ) : stats.history.length === 0 ? (
        <div className="empty">
          <span className="empty-ic"><Icon name="clock" size={26} /></span>
          <h3>No watch history yet</h3>
          <p>Start watching a film, series, or anime and your activity, hours watched, and episode positions will appear here.</p>
          <Link to="/" className="btn play sm" viewTransition>Browse something to watch</Link>
        </div>
      ) : (
        <>
          <div className="filter-bar">
            <div className="seg-pills" role="tablist" aria-label="Filter watch history" ref={histInd}>
              {HISTORY_FILTERS.map((f) => {
                const n = f.id === "all" ? enrichedHistory.length : enrichedHistory.filter((h) => h.bucket === f.id).length;
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={historyFilter === f.id}
                    className={historyFilter === f.id ? "on" : ""}
                    onClick={() => setHistoryFilter(f.id)}
                  >
                    {f.label} <small>{n}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid">
            {shownHistory.map(({ entry, tracking, pct }, i) => {
              const epText = !isFilm(entry.media) && entry.episode != null ? fmtEpCode(entry.season, entry.episode) : null;
              return (
                <Card
                  key={entry.media.key}
                  media={entry.media}
                  index={i}
                  progress={pct}
                  tracking={tracking}
                  sub={
                    <span>
                      {[epText, entry.finished ? "Completed" : null, entry.updatedAt ? fmtAgo(entry.updatedAt) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  }
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
