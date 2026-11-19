import { useMemo } from "react";
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
import { encodeKey } from "../lib/catalog";
import { useFreshness } from "../lib/fresh";
import { removeProgress, restoreProgress, useContinueWatching } from "../lib/progress";
import { toast } from "../lib/toast";
import { watchHref } from "../lib/play";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, TOP10 } from "../lib/tmdb";
import { isFilm, type Media } from "../lib/types";
import { useAsync, useProgressiveFeeds } from "../lib/useAsync";

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
  // A stable array, so the hero doesn't restart its slide every time an unrelated store updates.
  const stage = useMemo(() => (d[0]?.length ? d[0] : (animeTrending.data ?? []).filter((m) => m.backdrop)), [d[0], animeTrending.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // The stage waits for whichever feed can fill it; once both have settled empty, it steps aside.
  const staging = (catalog && !feeds.settled[0] && !d[0]) || (!d[0]?.length && animeTrending.loading && !animeTrending.data);

  return (
    <div className="page-flush">
      <Hero items={stage} label="Tonight" loading={staging} />
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
        {catalog && <FitsTonight pool={pool} loading={poolLoading} />}
        <Row eyebrow="Trending today" title="Top 10 films right now" ranked chart={TOP10.movie.id} items={d[7]} loading={rowLoading(7)} />
        <Row eyebrow="In the last six weeks" title="New releases" to="/movies" items={d[4]} loading={rowLoading(4)} />
        <Row eyebrow="One entry per show · switch sub and dub any time" title="Anime this season" to="/anime" items={anime.data} loading={anime.loading && !anime.data} />
        {!catalog && <Row eyebrow="Everyone's watching" title="Trending anime" to="/anime" items={animeTrending.data} loading={animeTrending.loading && !animeTrending.data} />}
        <DriveSection limit={6} />
        <Row eyebrow="Out now" title="Popular films" to="/movies" items={d[1]} loading={rowLoading(1)} />
        <Row eyebrow="Trending today" title="Top 10 series right now" ranked chart={TOP10.tv.id} items={d[8]} loading={rowLoading(8)} />
        <Row eyebrow="Premiered recently" title="New series" to="/series" items={d[5]} loading={rowLoading(5)} />
        <Row eyebrow="Out now" title="Popular series" to="/series" items={d[2]} loading={rowLoading(2)} />
        <Row eyebrow="In the next two months" title="Coming soon" items={d[6]} loading={rowLoading(6)} />
        <Row eyebrow="The best of the best" title="Critically acclaimed" items={d[3]} loading={rowLoading(3)} />
      </div>
    </div>
  );
}
