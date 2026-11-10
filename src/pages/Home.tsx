import { useState } from "react";
import { Link } from "react-router-dom";
import { Ambient } from "../components/Ambient";
import { Art } from "../components/Art";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { SectionHead } from "../components/SectionHead";
import { useAuth } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";
import { encodeKey } from "../lib/catalog";
import { useContinueWatching } from "../lib/progress";
import { useSettings } from "../lib/settings";
import { FEEDS, hasTmdb, loadFeed, TOP10 } from "../lib/tmdb";
import type { Media } from "../lib/types";
import { useAsync } from "../lib/useAsync";

export function Home() {
  const s = useSettings();
  const auth = useAuth();
  const feeds = useAsync(() => Promise.all([...FEEDS.home, TOP10.movie, TOP10.tv].map(loadFeed)), [s.tmdbKey, auth.tmdbProxy]);
  const anime = useAsync(() => loadAnimeFeed(ANIME_FEEDS[0], 0), []);
  const cont = useContinueWatching();
  const [active, setActive] = useState<Media>();
  const d = feeds.data;
  const loading = feeds.loading && !d;

  return (
    <div className="page page-flush">
      <Ambient media={active} />
      <Hero items={d?.[0] ?? []} label="Trending" onActive={setActive} />
      <div className="shelves">
        {!hasTmdb() && (
          <Link to="/settings" className="notice" viewTransition>
            <Icon name="info" />
            <span>You're seeing a demo catalog. Add a TMDB key in Settings, or set one on your AbixCine server, to load real movies and series.</span>
            <Icon name="chevR" />
          </Link>
        )}
        {cont.length > 0 && (
          <section className="row">
            <SectionHead eyebrow="Pick up where you left off" title="Continue watching" />
            <div className="row-track">
              {cont.map((p, i) => (
                <Link
                  key={p.media.key}
                  className="wide-card"
                  style={{ ["--i" as any]: i }}
                  viewTransition
                  to={`/watch/${encodeKey(p.media.key)}?${new URLSearchParams({ ...(p.season != null ? { s: String(p.season) } : {}), ...(p.episode != null ? { e: String(p.episode) } : {}), ...(p.audio ? { a: p.audio } : {}) })}`}
                >
                  <Art media={p.media} variant="backdrop" />
                  <div className="wide-card-body">
                    <div className="card-title">{p.media.title}</div>
                    <div className="card-sub">
                      {p.episode != null && <span className="type-pill">{p.season != null ? `S${p.season} · ` : ""}E{p.episode}</span>}
                      {p.audio && <span className="type-pill">{p.audio.toUpperCase()}</span>}
                      <span>{Math.max(1, Math.round((p.duration - p.position) / 60))} min left</span>
                    </div>
                  </div>
                  <div className="card-progress"><i style={{ width: `${(p.position / p.duration) * 100}%` }} /></div>
                  <span className="wide-play"><Icon name="play" size={18} /></span>
                </Link>
              ))}
            </div>
          </section>
        )}
        <Row eyebrow="Out now" title="Popular movies" to="/movies" variant="landscape" items={d?.[1]} loading={loading} />
        <Row eyebrow="Trending today" title="Top 10 movies" ranked items={d?.[4]} loading={loading} />
        <Row eyebrow="Out now" title="Popular series" to="/series" variant="landscape" items={d?.[2]} loading={loading} />
        <Row eyebrow="Trending today" title="Top 10 series" ranked items={d?.[5]} loading={loading} />
        <Row eyebrow="Simulcast and classics" title="Trending anime" to="/anime" items={anime.data} loading={anime.loading && !anime.data} />
        <Row eyebrow="The best of the best" title="Critically acclaimed" variant="landscape" items={d?.[3]} loading={loading} />
      </div>
    </div>
  );
}
