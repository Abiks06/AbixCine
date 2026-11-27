import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ActiveReel } from "../components/ActiveReel";
import { AiringStrip } from "../components/AiringStrip";
import { ChartLedger, type ChartTab } from "../components/ChartLedger";
import { DownloadsVault } from "../components/DownloadsVault";
import { DriveSection } from "../components/Drive";
import { EditorialSpread } from "../components/EditorialSpread";
import { FilmReel } from "../components/FilmReel";
import { FitsTonight } from "../components/FitsTonight";
import { Hero } from "../components/Hero";
import { HomeWelcome, type HomeLens } from "../components/HomeWelcome";
import { Icon } from "../components/Icon";
import { NextWatchDeck } from "../components/NextWatchDeck";
import { Row } from "../components/Row";
import { useAuth } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed, peekAnimeFeed } from "../lib/anilist";
import { getDetail } from "../lib/catalog";
import { dismissRecommendation, undismissRecommendation, useDismissed, useTasteSeeds } from "../lib/dismissed";
import { useHasDownloadedItems } from "../lib/downloads";
import { useFreshness } from "../lib/fresh";
import { useOnlineStatus } from "../lib/online";
import { removeProgress, restoreProgress, useContinueWatching, useProgressStore, type ProgressEntry } from "../lib/progress";
import { buildRecommendations, buildTasteShelves, type RecommendMode, type SeedRelated } from "../lib/recommend";
import { laneOf, mixByTaste, useTaste, type Lane } from "../lib/taste";
import { toast } from "../lib/toast";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, peekFeed, TOP10 } from "../lib/tmdb";
import { type Media } from "../lib/types";
import { useAsync, useProgressiveFeeds } from "../lib/useAsync";
import { useWatchlist } from "../lib/watchlist";

export function Home() {
  const s = useSettings();
  const auth = useAuth();
  const isOnline = useOnlineStatus();
  const hasDownloads = useHasDownloadedItems();
  const fresh = useFreshness();
  const [lens, setLens] = useState<HomeLens>("all");
  const [recMode, setRecMode] = useState<RecommendMode>("for-you");
  const [selectedSeedKey, setSelectedSeedKey] = useState<string | undefined>(undefined);
  const [shuffleOffset, setShuffleOffset] = useState(0);
  const { keys: dismissedKeys, records: dismissedRecords } = useDismissed();
  const tasteSeeds = useTasteSeeds();

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
  const animeTop = useAsync(() => loadAnimeFeed(ANIME_FEEDS[3], 3), [fresh], {
    keepPrevious: true,
    initialData: peekAnimeFeed(ANIME_FEEDS[3]),
  });
  const cont = useContinueWatching();
  const taste = useTaste();
  const watchlist = useWatchlist();
  const store = useProgressStore();
  const progressList = useMemo(() => Object.values(store), [store]);

  // Filter seeds to genuine engaged watches (not accidental 20s clicks) and match active lens when filtered.
  const seeds = useMemo(() => {
    const byRecent = [...progressList]
      .filter((p) => {
        if (lens !== "all" && laneOf(p.media) !== lens) return false;
        const epCount = Object.keys(p.episodes ?? {}).length;
        return Boolean(p.finished || p.caughtUp || p.upNext || p.position > 180 || epCount > 1);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const touchedKeys = new Set(progressList.map((p) => p.media.key));
    const list: Media[] = [];
    const seen = new Set<string>();
    for (const p of byRecent) {
      if (!seen.has(p.media.key)) {
        seen.add(p.media.key);
        list.push(p.media);
      }
      if (list.length >= 3) break;
    }
    for (const w of watchlist) {
      if (lens !== "all" && laneOf(w.media) !== lens) continue;
      if (!touchedKeys.has(w.media.key) && !seen.has(w.media.key)) {
        seen.add(w.media.key);
        list.push(w.media);
        break;
      }
    }
    return list;
  }, [progressList, watchlist, lens]);

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
  const activeSeedKey =
    selectedSeedKey && seedRelated.some((sr) => sr.source.key === selectedSeedKey)
      ? selectedSeedKey
      : seedRelated[0]?.source.key;
  const activeSeedTitle = seedRelated.find((sr) => sr.source.key === activeSeedKey)?.source.title ?? seeds[0]?.title;

  const effectiveRecMode: RecommendMode =
    recMode === "queue" && watchlist.length === 0
      ? "for-you"
      : recMode === "because" && !seedRelated.length
        ? "for-you"
        : recMode;

  const dismissedGenres = useMemo(() => dismissedRecords.flatMap((r) => r.genres), [dismissedRecords]);

  const recs = useMemo(
    () =>
      buildRecommendations({
        progress: progressList,
        watchlist,
        seedRelated,
        catalogPools: [
          { label: "fresh", items: [...(d[4] ?? []), ...(d[5] ?? [])] },
          { label: "popular", items: [...(d[0] ?? []), ...(d[1] ?? []), ...(d[2] ?? [])] },
          { label: "acclaimed", items: [...(d[3] ?? []), ...(d[7] ?? []), ...(d[8] ?? []), ...(animeTop.data ?? [])] },
          { label: "airing", items: [...(anime.data ?? []), ...(animeTrending.data ?? [])] },
        ],
        lens,
        mode: effectiveRecMode,
        dismissed: dismissedKeys,
        dismissedGenres,
        seedGenres: tasteSeeds,
        seedKey: activeSeedKey,
        shuffleOffset,
        limit: 5,
      }),
    [progressList, watchlist, seedRelated, d, anime.data, animeTrending.data, animeTop.data, lens, effectiveRecMode, dismissedKeys, dismissedGenres, tasteSeeds, activeSeedKey, shuffleOffset],
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

  const catalogPending = catalog && !feeds.settled[0] && !d[0] && !d[1] && !d[2];
  const staging = stage.length === 0 && (catalogPending || (animeTrending.loading && !animeTrending.data));

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

  const tasteShelves = useMemo(() => {
    const exclude = new Set([
      ...recs.picks.map((p) => p.media.key),
      ...cont.map((c) => c.media.key),
      ...dismissedKeys,
    ]);
    return buildTasteShelves({
      topGenres: recs.topGenres,
      hasSignals: recs.hasSignals,
      progress: progressList,
      candidates: [
        ...seedRelated.flatMap((sr) => sr.items),
        ...(d[1] ?? []),
        ...(d[2] ?? []),
        ...(d[3] ?? []),
        ...(animeTrending.data ?? []),
        ...(animeTop.data ?? []),
      ],
      excludeKeys: exclude,
      lens,
    });
  }, [recs.topGenres, recs.hasSignals, recs.picks, cont, dismissedKeys, progressList, seedRelated, d, animeTrending.data, animeTop.data, lens]);

  const handleRemoveReel = useCallback((p: ProgressEntry) => {
    const gone = removeProgress(p.media.key);
    if (gone) toast(`Removed “${p.media.title}” from Continue watching`, { icon: "x", action: { label: "Undo", run: () => restoreProgress(gone) } });
  }, []);

  const heroLabel = lens === "all" ? "Tonight" : lens === "film" ? "Films" : lens === "series" ? "Series" : "Anime";
  const recsLoading = (catalog ? rowLoading(1) && rowLoading(4) : anime.loading && !anime.data) && !recs.picks.length;

  return (
    <div className="page-flush">
      <Hero items={stage} label={heroLabel} loading={staging} />

      <HomeWelcome
        lens={lens}
        onLens={setLens}
        catalog={catalog}
        filmPct={filmPct}
        seriesPct={seriesPct}
        animePct={animePct}
        topGenres={recs.topGenres}
        hasSignals={recs.hasSignals}
        hasDownloads={hasDownloads}
      />

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

        <AiringStrip lens={lens} />

        <NextWatchDeck
          picks={recs.picks}
          topGenres={recs.topGenres}
          hasSignals={recs.hasSignals}
          loading={recsLoading}
          mode={effectiveRecMode}
          onMode={setRecMode}
          seeds={seedRelated.map((sr) => ({ key: sr.source.key, title: sr.source.title }))}
          selectedSeedKey={activeSeedKey}
          onSelectSeed={setSelectedSeedKey}
          seedTitle={activeSeedTitle}
          hasWatchlist={watchlist.length > 0}
          hasBecause={seedRelated.length > 0}
          onShuffle={() => setShuffleOffset((n) => n + 1)}
          onDismiss={(media) => {
            dismissRecommendation(media);
            toast(`Hid “${media.title}”`, {
              icon: "info",
              action: {
                label: "Undo",
                run: () => undismissRecommendation(media.key),
              },
            });
          }}
        />

        {(catalog || pool.some((m) => !isNaN(m.year ?? NaN))) && <FitsTonight pool={pool} loading={poolLoading} />}

        {tasteShelves.map((shelf) => (
          <Row
            key={shelf.id}
            eyebrow={shelf.eyebrow}
            title={shelf.title}
            accentWord={shelf.accentWord}
            variant="poster"
            frames
            items={shelf.items}
          />
        ))}

        <ChartLedger
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

        {lens === "series" && catalog && (
          <Row
            eyebrow="Top 10 series today"
            title="Critically rated"
            accentWord="series"
            to="/series"
            variant="poster"
            frames
            items={(d[8] ?? []).filter((m) => (m.rating ?? 0) >= 7.5)}
            loading={rowLoading(8)}
          />
        )}

        {lens === "anime" && (
          <Row
            eyebrow="Highest rated anime"
            title="Critically acclaimed"
            accentWord="anime"
            to="/anime"
            variant="poster"
            frames
            items={animeTop.data}
            loading={animeTop.loading && !animeTop.data}
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
