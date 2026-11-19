import { type ReactElement, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { DriveSection } from "../components/Drive";
import { FitsTonight } from "../components/FitsTonight";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { SectionHead } from "../components/SectionHead";
import { useAuth } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";
import { encodeKey, getDetail } from "../lib/catalog";
import { useFreshness } from "../lib/fresh";
import { removeProgress, restoreProgress, useContinueWatching, useProgressStore, type ProgressEntry } from "../lib/progress";
import { mixByTaste, useTaste, type Lane } from "../lib/taste";
import { toast } from "../lib/toast";
import { watchHref } from "../lib/play";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, TOP10 } from "../lib/tmdb";
import { isFilm, type Media } from "../lib/types";
import { useAsync, useProgressiveFeeds } from "../lib/useAsync";

/** How long the hero holds out for films and series before opening on anime alone. */
const CATALOG_GRACE_MS = 2500;
const NO_MEDIA: Media[] = [];

export function Home() {
  const s = useSettings();
  const auth = useAuth();
  const fresh = useFreshness();
  // Each shelf renders as soon as its own feed resolves, so one cold endpoint never stalls the page.
  const feeds = useProgressiveFeeds(
    [...FEEDS.home, TOP10.movie, TOP10.tv].map((f, i) => () => loadFeed(f, i).catch(() => [] as Media[])),
    [s.tmdbKey, auth.tmdbProxy, fresh],
    { keepPrevious: true },
  );
  const anime = useAsync(() => loadAnimeFeed(ANIME_FEEDS[1], 1), [fresh], { keepPrevious: true });
  // The stage never sits empty: without the movie catalog, trending anime takes the hero.
  const animeTrending = useAsync(() => loadAnimeFeed(ANIME_FEEDS[0], 0), [fresh], { keepPrevious: true });
  const cont = useContinueWatching();
  const taste = useTaste();
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setPatient(false), CATALOG_GRACE_MS);
    return () => clearTimeout(t);
  }, []);
  const store = useProgressStore();
  // The newest thing you played (finished or not) seeds a row of titles like it.
  const lastPlayed = useMemo(() => {
    let best: ProgressEntry | undefined;
    for (const p of Object.values(store)) if (!best || p.updatedAt > best.updatedAt) best = p;
    return best?.media;
  }, [store]);
  const likeIt = useAsync(
    () => (lastPlayed ? getDetail(lastPlayed.key).then((x) => x.related.filter((m) => m.key !== lastPlayed.key)) : Promise.resolve([] as Media[])),
    [lastPlayed?.key, fresh],
    { keepPrevious: true },
  );
  const d = feeds.items;
  const catalog = hasTmdb();
  const rowLoading = (i: number) => catalog && !feeds.settled[i] && !d[i];
  const poolLoading = catalog && [1, 2, 3, 4].some((i) => !feeds.settled[i]) && ![1, 2, 3, 4].some((i) => d[i]?.length);
  const pool = useMemo(
    () => [
      ...(d[4] ?? []).slice(0, 6),
      ...(d[1] ?? []).slice(0, 6),
      ...(d[2] ?? []).slice(0, 4),
      ...(d[3] ?? []).slice(0, 2),
    ],
    [d[1], d[2], d[3], d[4]], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The stage is a mix of films, series and anime, weighted toward what you watch and dealt so the
  // kinds alternate. Whatever has loaded fills it (anime alone while the catalog server wakes),
  // and it is a stable array, so the hero doesn't restart its slide when an unrelated store updates.
  const stage = useMemo(() => {
    const art = (xs: Media[] | undefined) => (xs ?? []).filter((m) => m.backdrop);
    const trending = art(d[0]);
    return mixByTaste(
      {
        film: [...trending.filter((m) => m.kind === "movie"), ...art(d[1])],
        series: [...trending.filter((m) => m.kind === "tv"), ...art(d[2])],
        anime: art(animeTrending.data),
      },
      taste,
      6,
    );
  }, [d[0], d[1], d[2], animeTrending.data, taste]); // eslint-disable-line react-hooks/exhaustive-deps
  // The stage waits for whichever feed can fill it; once both have settled empty, it steps aside.
  // It also gives the catalog a moment before the stage settles for anime alone: with last session's copy
  // on disk it lands in well under a second, and the hero shouldn't open on one mix and reshuffle.
  const catalogPending = catalog && !feeds.settled[0] && !d[0];
  const shownStage = catalogPending && patient ? NO_MEDIA : stage;
  const staging = shownStage.length === 0 && (catalogPending || (animeTrending.loading && !animeTrending.data));

  // The shelves, one lane each, dealt in taste order (a row from your favourite lane, then the
  // next...), so the top of the page is always a mix and leans toward what you watch.
  const lanes: Record<Lane, ReactElement[]> = {
    film: [
      <Row key="top10-movie" eyebrow="Trending today" title="Top 10 films right now" ranked chart={TOP10.movie.id} items={d[7]} loading={rowLoading(7)} />,
      <Row key="new-movies" eyebrow="In the last six weeks" title="New releases" to="/movies" items={d[4]} loading={rowLoading(4)} />,
      <Row key="pop-movies" eyebrow="Out now" title="Popular films" to="/movies" items={d[1]} loading={rowLoading(1)} />,
    ],
    series: [
      <Row key="top10-tv" eyebrow="Trending today" title="Top 10 series right now" ranked chart={TOP10.tv.id} items={d[8]} loading={rowLoading(8)} />,
      <Row key="new-tv" eyebrow="Premiered recently" title="New series" to="/series" items={d[5]} loading={rowLoading(5)} />,
      <Row key="pop-tv" eyebrow="Out now" title="Popular series" to="/series" items={d[2]} loading={rowLoading(2)} />,
    ],
    anime: [
      <Row key="anime-season" eyebrow="One entry per show · switch sub and dub any time" title="Anime this season" to="/anime" items={anime.data} loading={anime.loading && !anime.data} />,
      <Row key="anime-trending" eyebrow="Everyone's watching" title="Trending anime" to="/anime" items={animeTrending.data} loading={animeTrending.loading && !animeTrending.data} />,
    ],
  };
  // Without the catalog only anime has anything to show: lead with it.
  const order = catalog ? taste.order : (["anime", ...taste.order.filter((l) => l !== "anime")] as Lane[]);
  const mixed: ReactElement[] = [];
  for (let r = 0; r < 3; r++) for (const l of order) if (lanes[l][r]) mixed.push(lanes[l][r]);

  return (
    <div className="page-flush">
      <Hero items={shownStage} label="Tonight" loading={staging} />
      <div className="shelves pad">
        {!catalog && (
          <Link to="/settings#catalog" className="notice" viewTransition>
            <Icon name="info" />
            <span>Films and series need the AbixCine server or your own TMDB key. Anime works either way. Open Settings to connect.</span>
            <Icon name="chevR" />
          </Link>
        )}
        {cont.length > 0 && (
          <section className="shelf">
            <SectionHead eyebrow="Pick up where you left off" title="Continue watching" />
            <div className="track">
              {cont.map((p, i) => {
                const left = Math.max(1, Math.round((p.duration - p.position) / 60));
                const ep = p.episode != null && !isFilm(p.media) ? `${p.season != null ? `S${p.season} · ` : ""}E${p.episode}` : null;
                const where = [p.upNext ? `Up next${ep ? ` ${ep}` : ""}` : ep, p.audio ? (p.audio === "dub" ? "Dub" : "Sub") : null, p.upNext ? null : `${left}m left`].filter(Boolean).join(" · ");
                return (
                  <Card
                    key={p.media.key}
                    media={p.media}
                    index={i}
                    progress={p.upNext || !(p.duration > 0) ? undefined : (p.position / p.duration) * 100}
                    sub={where}
                    right={<span />}
                    to={watchHref(p.media.key, p.season, p.episode, p.audio)}
                    infoTo={`/title/${encodeKey(p.media.key)}`}
                    removeLabel="Remove from Continue watching"
                    onRemove={() => {
                      const gone = removeProgress(p.media.key);
                      if (gone) toast(`Removed “${p.media.title}” from Continue watching`, { icon: "x", action: { label: "Undo", run: () => restoreProgress(gone) } });
                    }}
                  />
                );
              })}
            </div>
          </section>
        )}
        {lastPlayed && (
          <Row eyebrow="Because you watched" title={`More like ${lastPlayed.title}`} items={likeIt.data} loading={likeIt.loading && !likeIt.data} />
        )}
        {catalog && <FitsTonight pool={pool} loading={poolLoading} />}
        {mixed.slice(0, 3)}
        <DriveSection limit={6} />
        {mixed.slice(3)}
        <Row eyebrow="In the next two months" title="Coming soon" items={d[6]} loading={rowLoading(6)} />
        <Row eyebrow="The best of the best" title="Critically acclaimed" items={d[3]} loading={rowLoading(3)} />
      </div>
    </div>
  );
}
