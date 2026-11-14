import { Fragment, useMemo } from "react";
import { Hero } from "../components/Hero";
import { Row } from "../components/Row";
import { useAuth } from "../lib/account";
import { useFreshness } from "../lib/fresh";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";
import { useSettings } from "../lib/settings";
import { FEEDS, loadFeed, TOP10 } from "../lib/tmdb";
import type { Media } from "../lib/types";
import { useAsync } from "../lib/useAsync";

const EYEBROWS = ["Fresh", "Everyone's watching", "All-time", "By genre", "By genre"];
const NONE: Media[] = [];

export function Browse({ kind }: { kind: "movie" | "tv" }) {
  const s = useSettings();
  const auth = useAuth();
  const fresh = useFreshness();
  const feeds = FEEDS[kind];
  // Each shelf settles on its own: one failed feed leaves the others (and the hero) standing.
  const data = useAsync(
    () => Promise.all([...feeds, TOP10[kind]].map((f, i) => loadFeed(f, i + (kind === "tv" ? 20 : 10)).catch(() => NONE))),
    [kind, s.tmdbKey, auth.tmdbProxy, fresh],
    { keepPrevious: true },
  );
  const d = data.data;
  const stage = useMemo(() => d?.[1] ?? NONE, [d]);
  return (
    <div className="page-flush">
      <Hero items={stage} label={kind === "movie" ? "Popular films" : "Popular series"} />
      <div className="shelves pad">
        {feeds.map((f, i) => (
          <Fragment key={f.id}>
            <Row eyebrow={EYEBROWS[i]} title={f.title} variant="landscape" items={d?.[i]} loading={!d} />
            {i === 0 && <Row eyebrow="Trending today" title={TOP10[kind].title} ranked chart={TOP10[kind].id} items={d?.[feeds.length]} loading={!d} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function Anime() {
  const fresh = useFreshness();
  const data = useAsync(() => Promise.all(ANIME_FEEDS.map((f, i) => loadAnimeFeed(f, i).catch(() => NONE))), [fresh], { keepPrevious: true });
  const d = data.data;
  const stage = useMemo(() => d?.[1] ?? NONE, [d]);
  return (
    <div className="page-flush">
      <Hero items={stage} label="This season" />
      <div className="shelves pad">
        {ANIME_FEEDS.map((f, i) =>
          i === 3 ? (
            <Row key={f.id} eyebrow="Ranked by fans" title={f.title} ranked items={d?.[i]} loading={!d} />
          ) : (
            <Row key={f.id} eyebrow={["Right now", "Simulcast", "Essentials"][i]} title={f.title} items={d?.[i]} loading={!d} />
          ),
        )}
      </div>
    </div>
  );
}
