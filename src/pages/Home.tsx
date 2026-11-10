import { useState } from "react";
import { Link } from "react-router-dom";
import { Ambient } from "../components/Ambient";
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
import { useContinueWatching } from "../lib/progress";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, TOP10 } from "../lib/tmdb";
import type { Media } from "../lib/types";
import { useAsync } from "../lib/useAsync";

export function Home() {
  const s = useSettings();
  const auth = useAuth();
  const fresh = useFreshness();
  const feeds = useAsync(() => Promise.all([...FEEDS.home, TOP10.movie, TOP10.tv].map(loadFeed)), [s.tmdbKey, auth.tmdbProxy, fresh]);
  const anime = useAsync(() => loadAnimeFeed(ANIME_FEEDS[1], 1), [fresh]);
  const cont = useContinueWatching();
  const [active, setActive] = useState<Media>();
  const d = feeds.data;
  const loading = feeds.loading && !d;
  const pool = d ? [...d[4].slice(0, 6), ...d[1].slice(0, 6), ...d[2].slice(0, 4), ...d[3].slice(0, 2)] : [];

  return (
    <div className="page-flush">
      <Ambient media={active} />
      <Hero items={d?.[0] ?? []} label="tonight" onActive={setActive} />
      <div className="rows pad">
        {!hasTmdb() && (
          <Link to="/settings" className="notice" viewTransition>
            <Icon name="info" />
            <span>You're seeing a demo catalog. Add a TMDB key in Settings, or set one on your AbixCine server, to load real movies and series.</span>
            <Icon name="chevR" />
          </Link>
        )}
        {cont.length > 0 && (
          <section className="sec">
            <SectionHead eyebrow="Pick up where you left off" title="Continue watching" />
            <div className="track">
              {cont.map((p, i) => {
                const left = Math.max(1, Math.round((p.duration - p.position) / 60));
                const where = [p.episode != null ? `${p.season != null ? `S${p.season} · ` : ""}E${p.episode}` : null, p.audio ? (p.audio === "dub" ? "Dub" : "Sub") : null, `${left}m left`].filter(Boolean).join(" · ");
                const qs = new URLSearchParams({ ...(p.season != null ? { s: String(p.season) } : {}), ...(p.episode != null ? { e: String(p.episode) } : {}), ...(p.audio ? { a: p.audio } : {}) });
                return <Card key={p.media.key} media={p.media} index={i} progress={(p.position / p.duration) * 100} sub={where} right={<span />} to={`/watch/${encodeKey(p.media.key)}?${qs}`} />;
              })}
            </div>
          </section>
        )}
        <FitsTonight pool={pool} />
        <Row eyebrow="Trending today" title="Top 10 films right now" ranked chart={TOP10.movie.id} items={d?.[7]} loading={loading} />
        <Row eyebrow="In the last six weeks" title="New releases" to="/movies" items={d?.[4]} loading={loading} />
        <Row eyebrow="One entry per show · switch sub and dub any time" title="Anime this season" to="/anime" items={anime.data} loading={anime.loading && !anime.data} />
        <DriveSection limit={6} />
        <Row eyebrow="Out now" title="Popular films" to="/movies" items={d?.[1]} loading={loading} />
        <Row eyebrow="Trending today" title="Top 10 series right now" ranked chart={TOP10.tv.id} items={d?.[8]} loading={loading} />
        <Row eyebrow="Premiered recently" title="New series" to="/series" items={d?.[5]} loading={loading} />
        <Row eyebrow="Out now" title="Popular series" to="/series" items={d?.[2]} loading={loading} />
        <Row eyebrow="In the next two months" title="Coming soon" items={d?.[6]} loading={loading} />
        <Row eyebrow="The best of the best" title="Critically acclaimed" items={d?.[3]} loading={loading} />
      </div>
    </div>
  );
}
