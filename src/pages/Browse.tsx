import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Ambient } from "../components/Ambient";
import { Card, CardSkeleton } from "../components/Card";
import { ChartLedger } from "../components/ChartLedger";
import { FilmReel } from "../components/FilmReel";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { useAuth } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";
import { useFreshness } from "../lib/fresh";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, TOP10 } from "../lib/tmdb";
import type { Media } from "../lib/types";
import { useProgressiveFeeds } from "../lib/useAsync";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";

const EYEBROWS = ["Fresh", "Everyone's watching", "All-time", "By genre", "By genre"];
const NONE: Media[] = [];
type Sort = "featured" | "rating" | "year" | "title";
type ViewMode = "editorial" | "archive";

const SORTS: { id: Sort; label: string }[] = [
  { id: "featured", label: "Featured" },
  { id: "rating", label: "Top rated" },
  { id: "year", label: "Newest" },
  { id: "title", label: "A–Z" },
];

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

function useCatalogFilter(lists: (Media[] | undefined)[]) {
  const [genre, setGenre] = useState("All");
  const [sort, setSort] = useState<Sort>("featured");
  const [view, setView] = useState<ViewMode>("editorial");

  const genres = useMemo(() => {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const xs of lists) {
      for (const m of xs ?? []) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        for (const g of m.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([g]) => g);
    return ["All", ...top];
  }, [lists]);

  const activeGenre = genres.includes(genre) ? genre : "All";

  const filtered = useMemo(() => {
    const map = new Map<string, Media>();
    for (const xs of lists) {
      for (const m of xs ?? []) {
        if (!map.has(m.key)) map.set(m.key, m);
      }
    }
    let out = [...map.values()];
    if (activeGenre !== "All") out = out.filter((m) => m.genres.includes(activeGenre));
    if (sort === "rating") out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    else if (sort === "year") out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else if (sort === "title") out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }, [lists, activeGenre, sort]);

  const archiveMode = view === "archive" || activeGenre !== "All" || sort !== "featured";
  return { genres, activeGenre, setGenre, sort, setSort, view, setView, filtered, archiveMode };
}

function BrowseToolbar({
  kicker,
  title,
  accent,
  filter,
  count,
}: {
  kicker: string;
  title: string;
  accent: string;
  filter: ReturnType<typeof useCatalogFilter>;
  count: number;
}) {
  const sortInd = useSlidingIndicator();
  const viewInd = useSlidingIndicator();
  return (
    <div className="browse-bar pad">
      <div className="browse-bar-top">
        <div>
          <p className="overline">{kicker}</p>
          <h1 className="browse-title">{title} <em>{accent}</em></h1>
        </div>
        <div className="browse-ctrls">
          <div className="seg-pills" role="radiogroup" aria-label="Sort titles" ref={sortInd}>
            {SORTS.map((o) => (
              <button key={o.id} role="radio" aria-checked={filter.sort === o.id} className={filter.sort === o.id ? "on" : ""} onClick={() => filter.setSort(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="view-pick" role="group" aria-label="Layout mode" ref={viewInd}>
            <button className={filter.view === "editorial" ? "on" : ""} aria-pressed={filter.view === "editorial"} title="Editorial spreads" aria-label="Editorial spreads" onClick={() => filter.setView("editorial")}>
              <Icon name="rows" size={15} />
            </button>
            <button className={filter.view === "archive" ? "on" : ""} aria-pressed={filter.view === "archive"} title="Poster archive wall" aria-label="Poster archive wall" onClick={() => filter.setView("archive")}>
              <Icon name="grid" size={15} />
            </button>
          </div>
        </div>
      </div>
      {filter.genres.length > 1 && (
        <div className="browse-genres">
          <div className="tabs">
            {filter.genres.map((g) => (
              <button
                key={g}
                type="button"
                className={`chip ${filter.activeGenre === g ? "on" : ""}`}
                onClick={() => filter.setGenre(g)}
              >
                {g}
              </button>
            ))}
          </div>
          {filter.archiveMode && <span className="shelf-note">{count} TITLES</span>}
        </div>
      )}
    </div>
  );
}

export function Browse({ kind }: { kind: "movie" | "tv" }) {
  const s = useSettings();
  const auth = useAuth();
  const fresh = useFreshness();
  const feeds = FEEDS[kind];
  const data = useProgressiveFeeds(
    [...feeds, TOP10[kind]].map((f, i) => () => loadFeed(f, i + (kind === "tv" ? 20 : 10)).catch(() => NONE)),
    [kind, s.tmdbKey, auth.tmdbProxy, fresh],
    { keepPrevious: true },
  );
  const d = data.items;
  const filter = useCatalogFilter(d);
  const stage = useMemo(() => d[1] ?? NONE, [d[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !data.loading && d.every((x) => !x?.length);

  return (
    <div className="page-flush">
      {filter.archiveMode && filter.filtered[0] && <Ambient media={filter.filtered[0]} />}
      {!filter.archiveMode && (
        <Hero items={stage} label={kind === "movie" ? "Popular films" : "Popular series"} loading={!data.settled[1] && !d[1]} />
      )}
      <BrowseToolbar
        kicker={kind === "movie" ? "Edition // Catalog" : "Edition // Television"}
        title={kind === "movie" ? "Screening" : "Television"}
        accent={kind === "movie" ? "Catalog" : "Index"}
        filter={filter}
        count={filter.filtered.length}
      />

      <div className="shelves pad">
        {empty && <NothingHere catalog={hasTmdb()} busy={data.loading} onRetry={data.reload} />}

        {filter.archiveMode && !empty ? (
          filter.filtered.length === 0 && data.loading ? (
            <div className="grid">{Array.from({ length: 12 }, (_, i) => <CardSkeleton key={i} variant="poster" />)}</div>
          ) : filter.filtered.length === 0 ? (
            <div className="empty">
              <h3>No titles match {filter.activeGenre}</h3>
              <button className="btn glass sm" onClick={() => filter.setGenre("All")}>Reset filter</button>
            </div>
          ) : (
            <div className="grid">
              {filter.filtered.map((m, i) => (
                <Card key={m.key} media={m} index={i} variant="poster" />
              ))}
            </div>
          )
        ) : (
          <>
            {!empty && (
              <ChartLedger
                eyebrow="Trending today"
                title={kind === "movie" ? "Top 10" : "Top 10"}
                accentWord={kind === "movie" ? "films" : "series"}
                tabs={[{ id: kind, label: kind === "movie" ? "Films" : "Series", chart: TOP10[kind].id, items: d[feeds.length], loading: !data.settled[feeds.length] && !d[feeds.length] }]}
                defaultTab={kind}
              />
            )}
            {feeds.map((f, i) => (
              <Fragment key={f.id}>
                {i === 0 ? (
                  <FilmReel
                    eyebrow={EYEBROWS[i]}
                    title={f.title}
                    variant="landscape"
                    edgeLabel={kind === "movie" ? "THEATRICAL" : "ON AIR"}
                    items={d[i]}
                    loading={!data.settled[i] && !d[i]}
                  />
                ) : (
                  <Row
                    eyebrow={EYEBROWS[i]}
                    title={f.title}
                    variant={kind === "movie" ? "poster" : "landscape"}
                    frames={kind === "movie"}
                    items={d[i]}
                    loading={!data.settled[i] && !d[i]}
                  />
                )}
              </Fragment>
            ))}
          </>
        )}
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
  const filter = useCatalogFilter(d);
  const stage = useMemo(() => d[1] ?? NONE, [d[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !data.loading && d.every((x) => !x?.length);

  return (
    <div className="page-flush">
      {filter.archiveMode && filter.filtered[0] && <Ambient media={filter.filtered[0]} />}
      {!filter.archiveMode && <Hero items={stage} label="This season" loading={!data.settled[1] && !d[1]} />}
      <BrowseToolbar
        kicker="Edition // Simulcast · Sub & Dub"
        title="Simulcast"
        accent="Board"
        filter={filter}
        count={filter.filtered.length}
      />

      <div className="shelves pad">
        {empty && <NothingHere catalog busy={data.loading} onRetry={data.reload} />}

        {filter.archiveMode && !empty ? (
          filter.filtered.length === 0 && data.loading ? (
            <div className="grid">{Array.from({ length: 12 }, (_, i) => <CardSkeleton key={i} variant="poster" />)}</div>
          ) : (
            <div className="grid">
              {filter.filtered.map((m, i) => (
                <Card key={m.key} media={m} index={i} variant="poster" />
              ))}
            </div>
          )
        ) : (
          <>
            {!empty && (
              <ChartLedger
                eyebrow="Ranked by viewers"
                title="Highest"
                accentWord="rated"
                tabs={[{ id: "anime-top", label: "Top Rated", chart: ANIME_FEEDS[3].id, items: d[3], loading: !data.settled[3] && !d[3] }]}
                defaultTab="anime-top"
              />
            )}
            <FilmReel
              eyebrow="Simulcast · Airing weekly"
              title="Airing"
              accentWord="this season"
              variant="poster"
              edgeLabel="SIMULCAST"
              items={d[1]}
              loading={!data.settled[1] && !d[1]}
            />
            <Row
              eyebrow="Right now"
              title={ANIME_FEEDS[0].title}
              variant="poster"
              frames
              items={d[0]}
              loading={!data.settled[0] && !d[0]}
            />
            <Row
              eyebrow="Essentials"
              title={ANIME_FEEDS[2].title}
              variant="poster"
              frames
              items={d[2]}
              loading={!data.settled[2] && !d[2]}
            />
          </>
        )}
      </div>
    </div>
  );
}
