import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import { useWatchlist } from "../lib/watchlist";

export function MyList() {
  const list = useWatchlist();
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">My List</h1>
        <span className="muted">{list.length} title{list.length === 1 ? "" : "s"} · synced to your account</span>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <Icon name="bookmark" size={40} />
          <p>Nothing saved yet. Hit <b>Add to list</b> on any title and it shows up here on every device.</p>
          <Link to="/" className="btn btn-glass sm" viewTransition>Browse</Link>
        </div>
      ) : (
        <div className="grid">{list.map((e, i) => <Card key={e.media.key} media={e.media} index={i} />)}</div>
      )}
    </div>
  );
}
