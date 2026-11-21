import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ActiveReel } from "../components/ActiveReel";
import { ChartLedger, type ChartTab } from "../components/ChartLedger";
import { DownloadsVault } from "../components/DownloadsVault";
import { DriveSection } from "../components/Drive";
import { EditorialSpread } from "../components/EditorialSpread";
import { FilmReel } from "../components/FilmReel";
import { FitsTonight } from "../components/FitsTonight";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { NextWatchDeck } from "../components/NextWatchDeck";
import { Row } from "../components/Row";
import { useAuth } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed, peekAnimeFeed } from "../lib/anilist";
import { getDetail } from "../lib/catalog";
import { useHasDownloadedItems } from "../lib/downloads";
import { useFreshness } from "../lib/fresh";
import { useOnlineStatus } from "../lib/online";
import { removeProgress, restoreProgress, useContinueWatching, useProgressStore, type ProgressEntry } from "../lib/progress";
import { buildRecommendations, type RecommendMode, type SeedRelated } from "../lib/recommend";
import { laneOf, mixByTaste, useTaste, type Lane } from "../lib/taste";
import { toast } from "../lib/toast";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, peekFeed, TOP10 } from "../lib/tmdb";
import { type Media } from "../lib/types";
import { useAsync, useProgressiveFeeds } from "../lib/useAsync";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { useWatchlist } from "../lib/watchlist";

/** How long the hero holds out for films and series before opening on anime alone. */
const CATALOG_GRACE_MS = 2500;
const NO_MEDIA: Media[] = [];

type Lens = "all" | Lane;
const LENSES: { id: Lens; label: string }[] = [
  { id: "all", label: "All" },
  { id: "film", label: "Films" },
  { id: "series", label: "Series" },
  { id: "anime", label: "Anime" },
];

export function Home() {
  const s = useSettings();
  const auth = useAuth();
  const isOnline = useOnlineStatus();
  const hasDownloads = useHasDownloadedItems();
  const fresh = useFreshness();
  const lensInd = useSlidingIndicator();
  const [lens, setLens] = useState<Lens>("all");
  const [recMode, setRecMode] = useState<RecommendMode>("for-you");
  const [shuffleOffset, setShuffleOffset] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const homeFeedsList = useMemo(() => [...FEEDS.home, TOP10.movie, TOP10.tv], []);
  const feeds = useProgressiveFeeds(
    homeFeedsList.map((f, i) => () => loadFeed(f, i).catch(() => [] as Media[])),
    [s.tmdbKey, auth.tmdbProxy, fresh],
    {
      keepPrevious: true,
      initialItems: homeFeedsList.map((f) => peekFeed(f)),
    },
  );
  const anime = useAsync(() => loadAnimeFeed(ANIME_FEEDS[1], 1), [fresh], {
    keepPrevious: true,
    initialData: peekAnimeFeed(ANIME_FEEDS[1]),
  });
  const animeTrending = useAsync(() => loadAnimeFeed(ANIME_FEEDS[0], 0), [fresh], {
    keepPrevious: true,
    initialData: peekAnimeFeed(ANIME_FEEDS[0]),
  });
  const cont = useContinueWatching();
  const taste = useTaste();
  const watchlist = useWatchlist();
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setPatient(false), CATALOG_GRACE_MS);
    return () => clearTimeout(t);
  }, []);
  const store = useProgressStore();
  const progressList = useMemo(() => Object.values(store), [store]);
  const seeds = useMemo(() => {
    const byRecent = [...progressList].sort((a, b) => b.updatedAt - a.updatedAt);
    const touchedKeys = new Set(progressList.map((p) => p.media.key));
    const list: Media[] = [];
    const seen = new Set<string>();
    for (const p of byRecent) {
      if (!seen.has(p.media.key)) {
        seen.add(p.media.key);
        list.push(p.media);
      }
      if (list.length >= 2) break;
    }
    for (const w of watchlist) {
      if (!touchedKeys.has(w.media.key) && !seen.has(w.media.key)) {
        seen.add(w.media.key);
        list.push(w.media);
        break;
      }
    }
    return list;
  }, [progressList, watchlist]);
  const seedSig = seeds.map((x) => x.key).join("|");
  const seedRelatedRes = useAsync(
    async (): Promise<SeedRelated[]> => {
      if (!seeds.length) return [];
      const res = await Promise.allSettled(seeds.map((src) => getDetail(src.key).then((det) => ({ source: src, items: det.related }))));
      return res
        .filter((r): r is PromiseFulfilledResult<SeedRelated> => r.status === "fulfilled" && r.value.items.length > 0)
        .map((r) => r.value);
    },
    [seedSig, fresh],
    { keepPrevious: true },
  );
  const d = feeds.items;
  const catalog = hasTmdb();
  const rowLoading = (i: number) => catalog && !feeds.settled[i] && !d[i];
  const poolLoading = catalog && [1, 2, 3, 4].some((i) => !feeds.settled[i]) && ![1, 2, 3, 4].some((i) => d[i]?.length);

  const seedRelated = useMemo(() => seedRelatedRes.data ?? [], [seedRelatedRes.data]);
  const effectiveRecMode: RecommendMode =
    recMode === "queue" && watchlist.length === 0
      ? "for-you"
      : recMode === "because" && !seedRelated.length
        ? "for-you"
        : recMode;

  const recs = useMemo(
    () =>
      buildRecommendations({
        progress: progressList,
        watchlist,
        seedRelated,
        catalogPools: [
          { label: "fresh", items: [...(d[4] ?? []), ...(d[5] ?? [])] },
          { label: "popular", items: [...(d[0] ?? []), ...(d[1] ?? []), ...(d[2] ?? [])] },
          { label: "acclaimed", items: [...(d[3] ?? []), ...(d[7] ?? []), ...(d[8] ?? [])] },
          { label: "airing", items: [...(anime.data ?? []), ...(animeTrending.data ?? [])] },
        ],
        lens,
        mode: effectiveRecMode,
        dismissed,
        shuffleOffset,
        limit: 5,
      }),
    [progressList, watchlist, seedRelated, d, anime.data, animeTrending.data, lens, effectiveRecMode, dismissed, shuffleOffset],
  );

  const pool = useMemo(() => {
    const raw = [
      ...watchlist.map((w) => w.media),
      ...recs.picks.map((p) => p.media),
      ...(d[4] ?? []).slice(0, 6),
      ...(d[1] ?? []).slice(0, 6),
      ...(d[2] ?? []).slice(0, 4),
      ...(d[3] ?? []).slice(0, 2),
      ...(anime.data ?? []).slice(0, 4),
    ];
    const seen = new Set<string>();
    return raw.filter((m) => {
      if (seen.has(m.key)) return false;
      seen.add(m.key);
      return lens === "all" || laneOf(m) === lens;
    });
  }, [watchlist, recs.picks, d, anime.data, lens]);

  const stage = useMemo(() => {
    const art = (xs: Media[] | undefined) => (xs ?? []).filter((m) => m.backdrop || m.poster);
    const trending = art(d[0]);
    const pools = {
      film: [...trending.filter((m) => m.kind === "movie"), ...art(d[1])],
      series: [...trending.filter((m) => m.kind === "tv"), ...art(d[2])],
      anime: art(animeTrending.data),
    };
    if (lens !== "all") return pools[lens].slice(0, 6);
    return mixByTaste(pools, taste, 6);
  }, [d[0], d[1], d[2], animeTrending.data, taste, lens]); // eslint-disable-line react-hooks/exhaustive-deps

  const catalogPending = catalog && !feeds.settled[0] && !d[0];
  const shownStage = catalogPending && patient ? NO_MEDIA : stage;
  const staging = shownStage.length === 0 && (catalogPending || (animeTrending.loading && !animeTrending.data));

  const chartTabs: ChartTab[] = useMemo(
    () => [
      ...(catalog
        ? [
            { id: "film", label: "Films", chart: TOP10.movie.id, items: d[7], loading: rowLoading(7) },
            { id: "series", label: "Series", chart: TOP10.tv.id, items: d[8], loading: rowLoading(8) },
          ]
        : []),
      { id: "anime", label: "Anime", chart: "anime-trending", items: animeTrending.data, loading: animeTrending.loading && !animeTrending.data },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, d[7], d[8], feeds.settled[7], feeds.settled[8], animeTrending.data, animeTrending.loading],
  );

  const defaultChart = lens !== "all" ? lens : catalog ? taste.order[0] : "anime";
  const showLane = (l: Lane) => lens === "all" || lens === l;

  const filmPct = Math.round(taste.share.film * 100);
  const seriesPct = Math.round(taste.share.series * 100);
  const animePct = Math.max(0, 100 - filmPct - seriesPct);

  const handleRemoveReel = useCallback((p: ProgressEntry) => {
    const gone = removeProgress(p.media.key);
    if (gone) toast(`Removed “${p.media.title}” from Continue watching`, { icon: "x", action: { label: "Undo", run: () => restoreProgress(gone) } });
  }, []);

  const heroLabel = lens === "all" ? "Tonight" : lens === "film" ? "Films" : lens === "series" ? "Series" : "Anime";
  const recsLoading = (catalog ? rowLoading(1) && rowLoading(4) : anime.loading && !anime.data) && !recs.picks.length;

  return (
    <div className="page-flush">
      <Hero items={shownStage} label={heroLabel} loading={staging} />

      <div className="taste-ribbon pad">
        <div className="taste-meter" title="Your automatic Home programme calibration from recent watches and My List">
          <span className="taste-kicker">CALIBRATED MIX</span>
          <div className="taste-bar" aria-hidden>
            <i className="tb-film" style={{ width: `${filmPct}%` }} />
            <i className="tb-series" style={{ width: `${seriesPct}%` }} />
            <i className="tb-anime" style={{ width: `${animePct}%` }} />
          </div>
          <span className="taste-stats">{filmPct}% FILM · {seriesPct}% SERIES · {animePct}% ANIME</span>
          {recs.topGenres.length > 0 && (
            <span className="taste-genres">
              {recs.topGenres.slice(0, 3).map((g) => (
                <span key={g} className="badge dim">{g}</span>
              ))}
            </span>
          )}
        </div>
        <div className="seg-pills" role="tablist" aria-label="Filter home programme" ref={lensInd}>
          {LENSES.filter((l) => catalog || l.id === "all" || l.id === "anime").map((l) => (
            <button
              key={l.id}
              role="tab"
              aria-selected={lens === l.id}
              className={lens === l.id ? "on" : ""}
              onClick={() => setLens(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="shelves pad">
        {!isOnline && hasDownloads && <DownloadsVault compact limit={8} />}

        {!catalog && (
          <Link to="/settings#catalog" className="notice" viewTransition>
            <Icon name="info" />
            <span>Films and series need the AbixCine server or your own TMDB key. Anime works either way. Open Settings to connect.</span>
            <Icon name="chevR" />
          </Link>
        )}

        <ActiveReel items={cont} onRemove={handleRemoveReel} />

        <NextWatchDeck
          picks={recs.picks}
          topGenres={recs.topGenres}
          hasSignals={recs.hasSignals}
          loading={recsLoading}
          mode={effectiveRecMode}
          onMode={setRecMode}
          seedTitle={seedRelated[0]?.source.title ?? seeds[0]?.title}
          hasWatchlist={watchlist.length > 0}
          hasBecause={seedRelated.length > 0}
          onShuffle={() => setShuffleOffset((n) => n + 1)}
          onDismiss={(key) => {
            setDismissed((prev) => new Set(prev).add(key));
            toast("Recommendation skipped for this session", {
              icon: "info",
              action: {
                label: "Reset",
                run: () => setDismissed(new Set()),
              },
            });
          }}
        />

        {(catalog || pool.some((m) => !isNaN(m.year ?? NaN))) && <FitsTonight pool={pool} loading={poolLoading} />}

        <ChartLedger
          key={defaultChart}
          eyebrow="Daily charts"
          title="Top 10"
          accentWord="right now"
          tabs={chartTabs}
          defaultTab={defaultChart}
        />

        {showLane("anime") && (
          <FilmReel
            eyebrow="Simulcast · Airing weekly · switch sub & dub any time"
            title="Airing"
            accentWord="this season"
            to="/anime"
            variant="poster"
            edgeLabel="SIMULCAST"
            items={anime.data}
            loading={anime.loading && !anime.data}
          />
        )}

        {showLane("film") && catalog && (
          <EditorialSpread
            eyebrow="In the last six weeks"
            title="New"
            accentWord="releases"
            to="/movies"
            items={d[4]}
            loading={rowLoading(4)}
          />
        )}

        {isOnline && hasDownloads && <DownloadsVault compact limit={6} />}

        <DriveSection limit={6} />

        {showLane("series") && catalog && (
          <EditorialSpread
            eyebrow="Premiered recently"
            title="New"
            accentWord="series"
            to="/series"
            items={d[5]}
            loading={rowLoading(5)}
          />
        )}

        {showLane("film") && catalog && (
          <Row
            eyebrow="Out now"
            title="Popular"
            accentWord="films"
            to="/movies"
            variant="poster"
            frames
            items={d[1]}
            loading={rowLoading(1)}
          />
        )}

        {showLane("series") && catalog && (
          <Row
            eyebrow="Out now"
            title="Popular"
            accentWord="series"
            to="/series"
            variant="poster"
            frames
            items={d[2]}
            loading={rowLoading(2)}
          />
        )}

        {showLane("film") && catalog && (
          <Row
            eyebrow="In the next two months"
            title="Coming"
            accentWord="soon"
            variant="poster"
            frames
            items={d[6]}
            loading={rowLoading(6)}
          />
        )}

        {showLane("film") && catalog && (
          <Row
            eyebrow="The best of the best"
            title="Critically"
            accentWord="acclaimed"
            variant="poster"
            frames
            items={d[3]}
            loading={rowLoading(3)}
          />
        )}
      </div>
    </div>
  );
}
