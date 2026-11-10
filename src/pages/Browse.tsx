import { Fragment, useState } from "react";
import { Ambient } from "../components/Ambient";
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

export function Browse({ kind }: { kind: "movie" | "tv" }) {
  const s = useSettings();
  const auth = useAuth();
  const fresh = useFreshness();
  const feeds = FEEDS[kind];
  const data = useAsync(
    () => Promise.all([...feeds, TOP10[kind]].map((f, i) => loadFeed(f, i + (kind === "tv" ? 20 : 10)))),
    [kind, s.tmdbKey, auth.tmdbProxy, fresh],
  );
  const [active, setActive] = useState<Media>();
  const d = data.data;
  return (
    <div className="page page-flush">
      <Ambient media={active} />
      <Hero items={d?.[1] ?? []} label={kind === "movie" ? "Popular movie" : "Popular series"} onActive={setActive} />
      <div className="rows pad">
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
  const data = useAsync(() => Promise.all(ANIME_FEEDS.map(loadAnimeFeed)), [fresh]);
  const [active, setActive] = useState<Media>();
  return (
    <div className="page page-flush">
      <Ambient media={active} />
      <Hero items={data.data?.[1] ?? []} label="This season" onActive={setActive} />
      <div className="rows pad">
        {ANIME_FEEDS.map((f, i) =>
          i === 3 ? (
            <Row key={f.id} eyebrow="Ranked by fans" title={f.title} ranked items={data.data?.[i]} loading={!data.data} />
          ) : (
            <Row key={f.id} eyebrow={["Right now", "Simulcast", "Essentials"][i]} title={f.title} items={data.data?.[i]} loading={!data.data} />
          ),
        )}
      </div>
    </div>
  );
}
