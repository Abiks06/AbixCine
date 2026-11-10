import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { decodeKey, encodeKey, getDetail } from "../lib/catalog";
import { fmtRuntime } from "../lib/format";
import { tmdbSeason } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { useContinueWatching } from "../lib/progress";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import { toggleList, useWatchlist } from "../lib/watchlist";
import { AudioToggle } from "../components/AudioToggle";
import { Art } from "../components/Art";
import { kindLabel } from "../components/Card";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { SectionHead } from "../components/SectionHead";
import { TitleArt } from "../components/TitleArt";

export function Title() {
  const key = decodeKey(useParams().key!);
  const nav = useNavigate();
  const { data: d, error } = useAsync(() => getDetail(key), [key]);
  const isTmdbSeries = key.includes(":tv:") || (key.startsWith("tmdb:") && d?.seasons);
  const [season, setSeason] = useState(1);
  const eps = useAsync(() => (isTmdbSeries ? tmdbSeason(key, season) : Promise.resolve([])), [key, season, !!isTmdbSeries]);
  const progress = useContinueWatching().find((p) => p.media.key === key);
  useSettings(); // re-render when audio preference changes
  const saved = useWatchlist().some((e) => e.media.key === key);

  useEffect(() => {
    if (d?.seasons?.length) setSeason(progress?.season ?? d.seasons[0].number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.key]);

  if (error) return <div className="page empty"><p>Couldn't load this title. {error.message}</p></div>;
  if (!d) return <div className="page"><div className="hero hero-skeleton" /></div>;

  const anime = key.startsWith("anilist:") || d.kind === "anime";
  const audio = anime ? audioFor(key) : undefined;
  const watch = (s?: number, e?: number) => {
    const qs = new URLSearchParams({ ...(s != null ? { s: String(s) } : {}), ...(e != null ? { e: String(e) } : {}), ...(audio ? { a: audio } : {}) });
    nav(`/watch/${encodeKey(key)}${qs.size ? `?${qs}` : ""}`, { viewTransition: true });
  };
  const animeEps = !isTmdbSeries && d.episodeCount ? d.episodeCount : 0;
  const resumeLabel = progress
    ? progress.episode != null ? `Resume ${progress.season != null ? `S${progress.season} ` : ""}E${progress.episode}` : "Resume"
    : "Play";

  return (
    <div className="page page-flush title-page">
      <div className="ambient" aria-hidden>{(d.backdrop || d.poster) && <img src={d.backdrop ?? d.poster} alt="" />}</div>
      <div className="title-hero">
        <Art media={d} variant="backdrop" className="title-bg" />
        <div className="hero-scrim" />
        <div className="title-head">
          <div className="title-poster" style={{ viewTransitionName: "hero-poster" }}><Art media={d} /></div>
          <div className="title-info">
            <div className="eyebrow">{kindLabel(d.kind)}{d.status ? ` · ${d.status.replace(/_/g, " ").toLowerCase()}` : ""}</div>
            <TitleArt media={d} />
            {d.tagline && <div className="tagline">{d.tagline}</div>}
            <div className="facts">
              {d.rating ? <span className="fact-rating"><Icon name="star" size={13} /> {d.rating.toFixed(1)}</span> : null}
              {d.year && <span>{d.year}</span>}
              {d.runtime ? <span>{fmtRuntime(d.runtime)}{anime || isTmdbSeries ? " / ep" : ""}</span> : null}
              {d.seasons && <span>{d.seasons.length} season{d.seasons.length > 1 ? "s" : ""}</span>}
              {animeEps ? <span>{animeEps} episodes</span> : null}
              {d.genres.slice(0, 3).map((g) => <span key={g} className="tag">{g}</span>)}
            </div>
            <p className="overview">{d.overview}</p>
            {d.nextAiring && (
              <div className="airing">Episode {d.nextAiring.episode} airs {new Date(d.nextAiring.at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}</div>
            )}
            <div className="hero-actions">
              <button
                className="btn btn-primary"
                onClick={() =>
                  progress ? watch(progress.season, progress.episode) : isTmdbSeries ? watch(season, 1) : animeEps ? watch(undefined, 1) : watch()
                }
              >
                <Icon name="play" /> {resumeLabel}
              </button>
              <button className={`btn btn-glass ${saved ? "is-on" : ""}`} onClick={() => toggleList(d)}>
                <Icon name={saved ? "bookmarkOn" : "plus"} /> {saved ? "In your list" : "Add to list"}
              </button>
              {anime && audio && (
                <div className="audio-pick">
                  <AudioToggle value={audio} onChange={(a) => setAudioFor(key, a)} />
                  <span className="muted">{audio === "sub" ? "Japanese audio, subtitles" : "English dub"}</span>
                </div>
              )}
              {d.trailerYouTubeId && (
                <a className="btn btn-glass" href={`https://www.youtube.com/watch?v=${d.trailerYouTubeId}`} target="_blank" rel="noreferrer">
                  Trailer
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="shelves">
        {progress && progress.duration > 0 && (
          <section className="resume-banner">
            <div className="resume-top">
              <Icon name="clock" size={18} />
              <strong>Continue watching</strong>
              {progress.episode != null && <span className="type-pill">{progress.season != null ? `Season ${progress.season}, ` : ""}Episode {progress.episode}</span>}
              {progress.audio && <span className="type-pill">{progress.audio.toUpperCase()}</span>}
              <div className="grow" />
              <button className="btn btn-primary sm" onClick={() => watch(progress.season, progress.episode)}><Icon name="play" size={14} /> Resume</button>
            </div>
            <div className="resume-bar"><i style={{ width: `${(progress.position / progress.duration) * 100}%` }} /></div>
            <span className="muted">{Math.round(progress.position / 60)}m watched · {Math.round((progress.position / progress.duration) * 100)}% complete</span>
          </section>
        )}
        {isTmdbSeries && d.seasons && (
          <section className="episodes">
            <SectionHead
              eyebrow={`Season ${season} · ${eps.data?.length ?? "…"} episodes`}
              title="Episodes"
              right={
                <div className="tabs">
                  {d.seasons.map((s) => (
                    <button key={s.number} className={`chip ${s.number === season ? "on" : ""}`} onClick={() => setSeason(s.number)}>{s.name}</button>
                  ))}
                </div>
              }
            />
            <div className="ep-list">
              {(eps.data ?? []).map((e) => (
                <div key={e.number} className={`ep ${progress?.season === season && progress?.episode === e.number ? "current" : ""}`} style={{ ["--i" as any]: e.number }}>
                  <button className="ep-thumb" style={e.still || d.backdrop ? { backgroundImage: `url(${e.still ?? d.backdrop})` } : { ["--h" as any]: d.hue ?? 250 }} onClick={() => watch(season, e.number)} aria-label={`Play episode ${e.number}`}>
                    <span className="ep-badge">E{e.number}</span>
                    {e.runtime ? <span className="ep-dur">{e.runtime}m</span> : null}
                    {progress?.season === season && progress.episode != null && e.number < progress.episode && <span className="ep-done"><Icon name="check" size={12} /></span>}
                    <span className="wide-play"><Icon name="play" size={16} /></span>
                  </button>
                  <div className="ep-body">
                    <span className="sec-eyebrow">Episode {e.number}</span>
                    <div className="ep-title">{e.title}</div>
                    <div className="ep-meta">{[e.airDate && new Date(e.airDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), e.runtime && fmtRuntime(e.runtime), e.rating && `★ ${e.rating}`].filter(Boolean).join(" · ")}</div>
                    <p>{e.overview}</p>
                    <button className="btn btn-primary sm" onClick={() => watch(season, e.number)}><Icon name="play" size={13} /> Play</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {animeEps > 0 && (
          <section className="episodes">
            <SectionHead eyebrow={`${animeEps} episodes · ${audio === "dub" ? "English dub" : "Subtitled"}`} title="Episodes" />
            <div className="ep-grid">
              {Array.from({ length: animeEps }, (_, i) => i + 1).map((n) => (
                <button key={n} className={`ep-chip ${progress?.episode === n ? "on" : ""}`} onClick={() => watch(undefined, n)}>
                  {n}
                </button>
              ))}
            </div>
          </section>
        )}

        {d.cast.length > 0 && (
          <Row eyebrow="Who's in it" title={anime ? "Characters" : "Cast"}>
            {d.cast.map((c, i) => (
              <div key={c.name + i} className="person">
                <div className="person-img" style={c.photo ? { backgroundImage: `url(${c.photo})` } : undefined}>{!c.photo && c.name[0]}</div>
                <div className="person-name">{c.name}</div>
                {c.character && <div className="person-role">{c.character}</div>}
              </div>
            ))}
          </Row>
        )}
        <Row eyebrow="Because you're looking at this" title="More like this" variant={anime ? "poster" : "landscape"} items={d.related} />
        <Link to="/" className="back-link" viewTransition><Icon name="back" /> Back to home</Link>
      </div>
    </div>
  );
}
