import { Fragment, useMemo } from "react";
import { Link } from "react-router-dom";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { useAuth } from "../lib/account";
import { useFreshness } from "../lib/fresh";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, TOP10 } from "../lib/tmdb";
import type { Media } from "../lib/types";
import { useProgressiveFeeds } from "../lib/useAsync";

const EYEBROWS = ["Fresh", "Everyone's watching", "All-time", "By genre", "By genre"];
const NONE: Media[] = [];

/**
 * Every shelf settled empty: say why instead of leaving a bare page. Without a catalog the fix is
 * in Settings; with one, the catalog didn't answer (offline, server asleep), so offer a retry.
 */
function NothingHere({ catalog, busy, onRetry }: { catalog: boolean; busy: boolean; onRetry: () => void }) {
  if (!catalog) {
    return (
      <Link to="/settings#catalog" className="notice" viewTransition>
        <Icon name="info" />
        <span>Films and series need the AbixCine server or your own TMDB key. Anime works either way. Open Settings to connect.</span>
        <Icon name="chevR" />
      </Link>
    );
  }
  return (
    <div className="empty">
      <span className="empty-ic"><Icon name="info" size={28} /></span>
      <h3>Couldn't reach the catalog</h3>
      <p>Check your connection, then try again.</p>
      <button className="btn play sm" onClick={onRetry} disabled={busy}>{busy ? <span className="mini-spin" /> : <Icon name="refresh" size={15} />} Try again</button>
    </div>
  );
}

export function Browse({ kind }: { kind: "movie" | "tv" }) {
  const s = useSettings();
  const auth = useAuth();
  const fresh = useFreshness();
  const feeds = FEEDS[kind];
  // Each shelf settles on its own: one failed feed leaves the others (and the hero) standing.
  const data = useProgressiveFeeds(
    [...feeds, TOP10[kind]].map((f, i) => () => loadFeed(f, i + (kind === "tv" ? 20 : 10)).catch(() => NONE)),
    [kind, s.tmdbKey, auth.tmdbProxy, fresh],
    { keepPrevious: true },
  );
  const d = data.items;
  const stage = useMemo(() => d[1] ?? NONE, [d[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !data.loading && d.every((x) => !x?.length);
  return (
    <div className="page-flush">
      <Hero items={stage} label={kind === "movie" ? "Popular films" : "Popular series"} loading={!data.settled[1] && !d[1]} />
      <div className="shelves pad">
        {empty && <NothingHere catalog={hasTmdb()} busy={data.loading} onRetry={data.reload} />}
        {feeds.map((f, i) => (
          <Fragment key={f.id}>
            <Row eyebrow={EYEBROWS[i]} title={f.title} variant="landscape" items={d[i]} loading={!data.settled[i] && !d[i]} />
            {i === 0 && <Row eyebrow="Trending today" title={TOP10[kind].title} ranked chart={TOP10[kind].id} items={d[feeds.length]} loading={!data.settled[feeds.length] && !d[feeds.length]} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function Anime() {
  const fresh = useFreshness();
  const data = useProgressiveFeeds(
    ANIME_FEEDS.map((f, i) => () => loadAnimeFeed(f, i).catch(() => NONE)),
    [fresh],
    { keepPrevious: true },
  );
  const d = data.items;
  const stage = useMemo(() => d[1] ?? NONE, [d[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !data.loading && d.every((x) => !x?.length);
  return (
    <div className="page-flush">
      <Hero items={stage} label="This season" loading={!data.settled[1] && !d[1]} />
      <div className="shelves pad">
        {empty && <NothingHere catalog busy={data.loading} onRetry={data.reload} />}
        {ANIME_FEEDS.map((f, i) =>
          i === 3 ? (
            <Row key={f.id} eyebrow="Ranked by fans" title={f.title} ranked items={d[i]} loading={!data.settled[i] && !d[i]} />
          ) : (
            <Row key={f.id} eyebrow={["Right now", "Simulcast", "Essentials"][i]} title={f.title} items={d[i]} loading={!data.settled[i] && !d[i]} />
          ),
        )}
      </div>
    </div>
  );
}
