import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import type { MediaKind } from "../lib/types";
import { useWatchlist } from "../lib/watchlist";

type Kind = "all" | MediaKind;
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "movie", label: "Films" },
  { id: "tv", label: "Series" },
  { id: "anime", label: "Anime" },
];
const SORTS = [
  { id: "recent", label: "Recently added" },
  { id: "title", label: "A–Z" },
  { id: "rating", label: "Top rated" },
] as const;
type Sort = (typeof SORTS)[number]["id"];

export function MyList() {
  const list = useWatchlist();
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const count = (k: Kind) => (k === "all" ? list.length : list.filter((e) => e.media.kind === k).length);
  // Removing the last title of a kind falls back to All instead of an empty grid.
  const active: Kind = kind !== "all" && count(kind) === 0 ? "all" : kind;
  const shown = useMemo(() => {
    const out = list.filter((e) => active === "all" || e.media.kind === active);
    if (sort === "title") out.sort((a, b) => a.media.title.localeCompare(b.media.title));
    else if (sort === "rating") out.sort((a, b) => (b.media.rating ?? 0) - (a.media.rating ?? 0));
    else out.sort((a, b) => b.addedAt - a.addedAt);
    return out;
  }, [list, active, sort]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h5>Saved for later</h5>
          <h1 className="page-title">My List</h1>
        </div>
        <span className="muted">{list.length} title{list.length === 1 ? "" : "s"} · synced to your account</span>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <span className="empty-ic"><Icon name="bookmark" size={26} /></span>
          <h3>Nothing saved yet</h3>
          <p>Press the <b>+</b> on any title and it shows up here, on every device you sign in to.</p>
          <Link to="/" className="btn glass sm" viewTransition>Find something to watch</Link>
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
            <div className="seg-pills" role="radiogroup" aria-label="Sort">
              {SORTS.map((o) => (
                <button key={o.id} role="radio" aria-checked={sort === o.id} className={sort === o.id ? "on" : ""} onClick={() => setSort(o.id)}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="grid" key={`${active}-${sort}`}>{shown.map((e, i) => <Card key={e.media.key} media={e.media} index={i} />)}</div>
        </>
      )}
    </div>
  );
}
