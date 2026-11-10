import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Ambient } from "../components/Ambient";
import { Art } from "../components/Art";
import { Card, kindLabel } from "../components/Card";
import { Icon } from "../components/Icon";
import { SmartSource } from "../components/SmartSource";
import { TitleArt } from "../components/TitleArt";
import { decodeKey, encodeKey, getDetail } from "../lib/catalog";
import { fmtRuntime } from "../lib/format";
import { getProgress, useContinueWatching } from "../lib/progress";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import { tmdbSeason } from "../lib/tmdb";
import type { Episode } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { toggleList, useWatchlist } from "../lib/watchlist";

type Tab = "episodes" | "cast" | "more";

export function Title() {
  const key = decodeKey(useParams().key!);
  const nav = useNavigate();
  const { data: d, error } = useAsync(() => getDetail(key), [key]);
  const isTmdbSeries = key.includes(":tv:") || (key.startsWith("tmdb:") && !!d?.seasons);
  const [season, setSeason] = useState(1);
  const eps = useAsync(() => (isTmdbSeries ? tmdbSeason(key, season) : Promise.resolve([] as Episode[])), [key, season, isTmdbSeries]);
  const progress = useContinueWatching().find((p) => p.media.key === key);
  useSettings(); // re-render when the audio preference changes
  const saved = useWatchlist().some((e) => e.media.key === key);
  const [tab, setTab] = useState<Tab>("episodes");
  const [swap, setSwap] = useState(false);

  useEffect(() => {
    if (d?.seasons?.length) setSeason(progress?.season ?? d.seasons[0].number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.key]);

  const anime = key.startsWith("anilist:") || d?.kind === "anime";
  const audio = anime ? audioFor(key) : undefined;
  const animeEps = !isTmdbSeries && d?.episodeCount ? d.episodeCount : 0;
  const hasEps = isTmdbSeries || animeEps > 0;

  // What pressing Play would start: resume point, else the first episode, else the film.
  const startS = progress ? progress.season : isTmdbSeries ? season : undefined;
  const startE = progress ? progress.episode : hasEps ? 1 : undefined;
  const req = useMemo(() => (d ? { media: d, season: startS, episode: startE, audio } : null), [d, startS, startE, audio]);

  if (error) return <div className="page empty"><p>Couldn't load this title. {error.message}</p></div>;
  if (!d || !req) return <div className="tp"><div className="tp-skeleton" /></div>;

  const watch = (s?: number, e?: number) => {
    const qs = new URLSearchParams({ ...(s != null ? { s: String(s) } : {}), ...(e != null ? { e: String(e) } : {}), ...(audio ? { a: audio } : {}) });
    nav(`/watch/${encodeKey(key)}${qs.size ? `?${qs}` : ""}`, { viewTransition: true });
  };
  const playLabel = progress
    ? progress.episode != null ? `Resume ${progress.season != null ? `S${progress.season} · ` : ""}E${progress.episode}` : "Resume"
    : hasEps ? "Play E1" : "Play";
  const length = d.kind === "movie" ? fmtRuntime(d.runtime) : d.seasons?.length ? `${d.seasons.length} season${d.seasons.length > 1 ? "s" : ""}` : animeEps ? `${animeEps} episodes` : "";
  const what = startE != null ? `${startS != null ? `S${startS} ` : ""}E${startE}` : "this film";
  const tabs: [Tab, string][] = [...(hasEps ? [["episodes", "Episodes"] as [Tab, string]] : []), ["cast", anime ? "Characters" : "Cast"], ["more", "More like this"]];
  const curTab = hasEps || tab !== "episodes" ? tab : "cast";

  const changeAudio = (a: "sub" | "dub") => {
    setSwap(true);
    setTimeout(() => {
      setAudioFor(key, a);
      setSwap(false);
    }, 200);
  };

  const epList: Episode[] = isTmdbSeries
    ? eps.data ?? []
    : Array.from({ length: animeEps }, (_, i) => ({ season: 0, number: i + 1, title: `Episode ${i + 1}`, runtime: d.runtime }));

  return (
    <div className="tp">
      <Ambient media={d} />
      <div className="backdrop" style={{ viewTransitionName: "hero" }}>
        <Art media={d} variant="backdrop" />
        <div className="shade" />
      </div>
      <div className="pad tp-body">
        <button className="back" onClick={() => (history.length > 1 ? nav(-1) : nav("/"))}><Icon name="back" size={18} /> Back</button>
        <div className="top">
          <div className="info">
            <div className="eyebrow">
              <span className="tag">{kindLabel(d.kind)}</span>
              {[d.year, ...d.genres.slice(0, 3)].filter(Boolean).join(" · ")}
            </div>
            <TitleArt media={d} />
            {d.tagline && <div className="tagline">{d.tagline}</div>}
            <div className="meta">
              {d.rating ? <span className="chip score">★ {d.rating.toFixed(1)} {key.startsWith("anilist:") ? "AniList" : "TMDB"}</span> : null}
              {length && <span className="chip">{length}</span>}
              {d.kind !== "movie" && d.runtime ? <span className="chip">{d.runtime}m episodes</span> : null}
              {d.status && <span className="chip">{d.status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>}
              {anime && <span className="chip hi">SUB | DUB</span>}
            </div>
            <p className="desc">{d.overview}</p>
            {d.nextAiring && (
              <div className="airing"><Icon name="clock" size={14} /> Episode {d.nextAiring.episode} airs {new Date(d.nextAiring.at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}</div>
            )}
            <div className="acts">
              <button className="btn play" onClick={() => watch(startS, startE)}><Icon name="play" size={16} /> {playLabel}</button>
              <button className={`btn glass ${saved ? "on" : ""}`} onClick={() => toggleList(d)}>
                <Icon name={saved ? "check" : "bookmark"} size={17} /> {saved ? "In My List" : "My List"}
              </button>
              {audio && <AudioToggle value={audio} onChange={changeAudio} />}
              {d.trailerYouTubeId && (
                <a className="btn glass" href={`https://www.youtube.com/watch?v=${d.trailerYouTubeId}`} target="_blank" rel="noreferrer">Trailer</a>
              )}
            </div>
            {progress && progress.duration > 0 && (
              <div className="resume">
                <div className="resume-bar"><i style={{ width: `${(progress.position / progress.duration) * 100}%` }} /></div>
                <span>{Math.max(1, Math.round((progress.duration - progress.position) / 60))}m left{progress.episode != null ? ` in E${progress.episode}` : ""}</span>
              </div>
            )}
          </div>
          <SmartSource req={req} what={what} />
        </div>

        <div className="tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={curTab === id} className={curTab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
          {curTab === "episodes" && isTmdbSeries && d.seasons && d.seasons.length > 1 && (
            <div className="season-pick">
              {d.seasons.map((s) => (
                <button key={s.number} className={s.number === season ? "on" : ""} onClick={() => setSeason(s.number)}>S{s.number}</button>
              ))}
            </div>
          )}
        </div>

        {curTab === "episodes" && (
          <div className={`eps swap ${swap ? "out" : ""}`} key={`${season}-${audio}`}>
            {epList.map((e, i) => {
              const s = isTmdbSeries ? season : undefined;
              const p = getProgress(key, s, e.number);
              const isCur = progress?.episode === e.number && (progress?.season ?? undefined) === s;
              const watched = p && p.duration > 0 && p.position / p.duration > 0.92;
              const still = e.still ?? d.related[i % Math.max(1, d.related.length)]?.backdrop ?? d.backdrop;
              return (
                <button key={e.number} className={`ep ${isCur ? "cur" : ""}`} style={{ ["--i" as any]: Math.min(i, 14) }} onClick={() => watch(s, e.number)}>
                  <div className="th">
                    {still ? <img src={still} alt="" loading="lazy" /> : <Art media={d} variant="backdrop" />}
                    {p && p.duration > 0 && <div className="w" style={{ width: `${watched ? 100 : (p.position / p.duration) * 100}%` }} />}
                    <span className="hoverplay"><Icon name="play" size={12} /></span>
                  </div>
                  <div className="ep-txt">
                    <div className="n">
                      E{String(e.number).padStart(2, "0")}
                      {e.runtime ? ` · ${e.runtime}m` : ""}
                      {audio ? (audio === "dub" ? " · EN dub" : " · JP audio · EN subs") : ""}
                    </div>
                    <div className="t">{e.title}</div>
                    <div className="d">
                      {watched ? "Watched" : p && p.duration > 0 ? `${Math.max(1, Math.round((p.duration - p.position) / 60))}m left` : e.overview || (e.airDate ? new Date(e.airDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "")}
                    </div>
                  </div>
                </button>
              );
            })}
            {isTmdbSeries && eps.loading && !eps.data && Array.from({ length: 6 }, (_, i) => <div key={i} className="ep skeleton" />)}
          </div>
        )}

        {curTab === "cast" && (
          <div className="people">
            {d.cast.length === 0 && <p className="muted">No cast listed.</p>}
            {d.cast.map((c, i) => (
              <div key={c.name + i} className="person" style={{ ["--i" as any]: Math.min(i, 14) }}>
                <div className="person-img" style={c.photo ? { backgroundImage: `url(${c.photo})` } : undefined}>{!c.photo && c.name[0]}</div>
                <div className="person-name">{c.name}</div>
                {c.character && <div className="person-role">{c.character}</div>}
              </div>
            ))}
          </div>
        )}

        {curTab === "more" && (
          <div className="grid">
            {d.related.length === 0 && <p className="muted">Nothing related yet.</p>}
            {d.related.map((m, i) => <Card key={m.key} media={m} index={i} />)}
          </div>
        )}
        <div style={{ height: 80 }} />
      </div>
    </div>
  );
}
