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
import { fmtAgo, fmtDate, fmtMoney, fmtRuntime, languageName } from "../lib/format";
import { getProgress, useContinueWatching } from "../lib/progress";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import { tmdbSeason } from "../lib/tmdb";
import { animeEpisodes, animeSeasons, type AnimeSeason } from "../lib/anilist";
import type { Episode } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { toggleList, useWatchlist } from "../lib/watchlist";

type Tab = "episodes" | "cast" | "details" | "more";

export function Title() {
  const key = decodeKey(useParams().key!);
  const nav = useNavigate();
  const { data: d, error } = useAsync(() => getDetail(key), [key]);
  const isTmdbSeries = key.includes(":tv:") || (key.startsWith("tmdb:") && !!d?.seasons);
  const [season, setSeason] = useState(1);
  const eps = useAsync(() => (isTmdbSeries ? tmdbSeason(key, season) : Promise.resolve([] as Episode[])), [key, season, isTmdbSeries]);
  // Anime on AniList is one entry per season: gather the whole series so it's one show here.
  const isAniList = key.startsWith("anilist:");
  const aniSeasons = useAsync(() => (isAniList ? animeSeasons(key).catch(() => [] as AnimeSeason[]) : Promise.resolve([] as AnimeSeason[])), [key]);
  const franchise = aniSeasons.data ?? [];
  const cw = useContinueWatching();
  const [aniPick, setAniPick] = useState<string | null>(null);
  useEffect(() => setAniPick(null), [key]);
  // Default season: the one you watched most recently, else the entry you opened.
  const lastWatched = useMemo(() => {
    const keys = new Set(franchise.map((x) => x.key));
    return cw.filter((p) => keys.has(p.media.key)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.media.key;
  }, [franchise, cw]);
  const seasonKey = isAniList ? aniPick ?? lastWatched ?? key : key;
  const seasonDetail = useAsync(() => (seasonKey !== key ? getDetail(seasonKey) : Promise.resolve(null)), [seasonKey]);
  // Anime: real episode titles, stills and synopses (ani.zip / AniList), for the selected season.
  const animeEpData = useAsync(() => (isAniList ? animeEpisodes(seasonKey).catch(() => [] as Episode[]) : Promise.resolve([] as Episode[])), [seasonKey]);
  const progress = cw.find((p) => p.media.key === seasonKey);
  useSettings(); // re-render when the audio preference changes
  const saved = useWatchlist().some((e) => e.media.key === key);
  const [tab, setTab] = useState<Tab>("episodes");
  const [swap, setSwap] = useState(false);
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState("");

  useEffect(() => {
    if (d?.seasons?.length) setSeason(progress?.season ?? d.seasons[0].number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.key]);

  useEffect(() => setPage(Math.max(0, Math.floor(((progress?.episode ?? 1) - 1) / 50))), [key, season]); // eslint-disable-line react-hooks/exhaustive-deps

  const anime = key.startsWith("anilist:") || d?.kind === "anime";
  const audio = anime ? audioFor(key) : undefined;
  /** The selected season's own record (episodes, MAL id); the show's while it loads or for single seasons. */
  const sd = seasonKey === key ? d : seasonDetail.data ?? null;
  const animeEps = !isTmdbSeries && sd?.episodeCount ? sd.episodeCount : 0;
  const hasEps = isTmdbSeries || animeEps > 0;

  // What pressing Play would start: resume point, else the first episode, else the film.
  const startS = progress ? progress.season : isTmdbSeries ? season : undefined;
  const startE = progress ? progress.episode : hasEps ? 1 : undefined;
  const req = useMemo(() => (sd ? { media: sd, season: startS, episode: startE, audio } : null), [sd, startS, startE, audio]);

  if (error) return <div className="page empty"><p>Couldn't load this title. {error.message}</p></div>;
  if (!d) return <div className="tp"><div className="tp-skeleton" /></div>;

  const watch = (s?: number, e?: number, srv?: string) => {
    const qs = new URLSearchParams({ ...(s != null ? { s: String(s) } : {}), ...(e != null ? { e: String(e) } : {}), ...(audio ? { a: audio } : {}), ...(srv ? { srv } : {}) });
    nav(`/watch/${encodeKey(seasonKey)}${qs.size ? `?${qs}` : ""}`, { viewTransition: true, state: { from: "app" } });
  };
  const epTag = progress?.episode != null ? `${progress.season != null ? `S${progress.season} · ` : ""}E${progress.episode}` : "";
  const playLabel = progress
    ? progress.upNext ? `Play ${epTag}` : epTag ? `Resume ${epTag}` : "Resume"
    : hasEps ? "Play E1" : "Play";
  const length =
    d.kind === "movie"
      ? fmtRuntime(d.runtime)
      : d.seasons?.length
        ? `${d.seasons.length} season${d.seasons.length > 1 ? "s" : ""}`
        : franchise.length > 1
          ? `${franchise.length} seasons`
          : animeEps
            ? `${animeEps} episode${animeEps === 1 ? "" : "s"}`
            : "";
  const what = startE != null ? `${startS != null ? `S${startS} ` : ""}E${startE}` : "this film";
  const tabs: [Tab, string][] = [...(hasEps ? [["episodes", "Episodes"] as [Tab, string]] : []), ["cast", anime ? "Characters & crew" : "Cast & crew"], ["details", "Details"], ["more", "More like this"]];
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
    : Array.from({ length: animeEps }, (_, i) => {
        const known = animeEpData.data?.find((e) => e.number === i + 1);
        return known ? { ...known, runtime: known.runtime ?? d.runtime } : { season: 0, number: i + 1, title: `Episode ${i + 1}`, runtime: d.runtime };
      });

  return (
    <div className="tp">
      <Ambient media={d} />
      <div className="backdrop" style={{ viewTransitionName: "hero" }}>
        <Art media={d} variant="backdrop" hd priority />
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
              {d.certification && <span className="chip cert">{d.certification}</span>}
              {length && <span className="chip">{length}</span>}
              {d.budget ? <span className="chip">{fmtMoney(d.budget)} budget</span> : null}
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
            {progress && !progress.upNext && progress.duration > 0 && (
              <div className="resume">
                <div className="resume-bar"><i style={{ width: `${(progress.position / progress.duration) * 100}%` }} /></div>
                <span>{Math.max(1, Math.round((progress.duration - progress.position) / 60))}m left{progress.episode != null ? ` in E${progress.episode}` : ""}</span>
              </div>
            )}
          </div>
          {req ? <SmartSource req={req} what={what} onPlay={(srv) => watch(startS, startE, srv)} /> : <aside className="glass smart"><div className="smart-note">Loading season…</div></aside>}
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
          {curTab === "episodes" && franchise.length > 1 && (
            <div className="season-pick">
              {franchise.map((x) => (
                <button
                  key={x.key}
                  className={x.key === seasonKey ? "on" : ""}
                  title={`${x.title}${x.year ? ` (${x.year})` : ""}${x.episodes ? ` · ${x.episodes} episodes` : ""}`}
                  onClick={() => {
                    setAniPick(x.key);
                    setPage(0);
                  }}
                >
                  S{franchise.indexOf(x) + 1}
                </button>
              ))}
            </div>
          )}
        </div>

        {curTab === "episodes" && (() => {
          // Long anime runs (One Piece is past 1,100) are paged in blocks of 50.
          const PAGE = 50;
          const paged = !isTmdbSeries && epList.length > PAGE;
          const pages = Math.ceil(epList.length / PAGE);
          const shown = paged ? epList.slice(page * PAGE, page * PAGE + PAGE) : epList;
          const upNext = progress?.episode != null ? progress.episode : undefined;
          return (
            <>
              {(paged || epList.length > 12) && (
                <div className="ep-tools">
                  {paged && (
                    <div className="season-strip">
                      {Array.from({ length: pages }, (_, p) => (
                        <button key={p} className={p === page ? "on" : ""} onClick={() => setPage(p)}>{p * PAGE + 1}–{Math.min(epList.length, (p + 1) * PAGE)}</button>
                      ))}
                    </div>
                  )}
                  <form
                    className="ep-jump"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      const n = Number(jump);
                      if (n >= 1 && n <= (epList[epList.length - 1]?.number ?? 0)) watch(isTmdbSeries ? season : undefined, n);
                    }}
                  >
                    <Icon name="search" size={14} />
                    <input value={jump} onChange={(ev) => setJump(ev.target.value.replace(/\D/g, ""))} placeholder="Jump to episode" inputMode="numeric" />
                    {jump && <button className="chip" type="submit">Play E{jump}</button>}
                  </form>
                </div>
              )}
              <div className={`ep-grid swap ${swap ? "out" : ""} ${shown.some((e) => e.still) || d.backdrop ? "" : "compact"}`} key={`${season}-${audio}-${page}`}>
                {shown.map((e, i) => {
                  const s = isTmdbSeries ? season : undefined;
                  const p = getProgress(seasonKey, s, e.number);
                  const isCur = upNext === e.number && (progress?.season ?? undefined) === s;
                  const watched = p && p.duration > 0 && p.position / p.duration > 0.92;
                  // Episodes without their own still (often unaired ones) get the show's art, dimmed.
                  const still = e.still ?? d.backdrop;
                  return (
                    <button key={e.number} className={`ep-card ${isCur ? "cur" : ""} ${watched ? "seen" : ""}`} style={{ ["--i" as any]: Math.min(i, 14) }} onClick={() => watch(s, e.number)}>
                      <div className="ec-th">
                        {still && <img src={still} alt="" loading="lazy" decoding="async" className={e.still ? "" : "dim"} />}
                        <span className="ec-num">{e.number}</span>
                        {isCur && <span className="ec-ribbon">{p && p.position > 30 ? "Resume" : "Up next"}</span>}
                        {watched && <span className="ec-seen"><Icon name="check" size={12} /></span>}
                        {e.runtime ? <span className="ec-rt">{e.runtime}m</span> : null}
                        <span className="ec-play"><Icon name="play" size={18} /></span>
                        {p && p.duration > 0 && !watched && <div className="ec-bar"><i style={{ width: `${(p.position / p.duration) * 100}%` }} /></div>}
                      </div>
                      <div className="ec-tx">
                        <div className="ec-t">{e.title}</div>
                        <div className="ec-d">
                          {p && p.duration > 0 && !watched
                            ? `${Math.max(1, Math.round((p.duration - p.position) / 60))}m left`
                            : e.overview || (e.airDate ? new Date(e.airDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : audio ? (audio === "dub" ? "English dub" : "Japanese audio · English subtitles") : "")}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {isTmdbSeries && eps.loading && !eps.data && Array.from({ length: 6 }, (_, i) => <div key={i} className="ep-card skeleton" />)}
              </div>
            </>
          );
        })()}

        {curTab === "cast" && (
          <div className="people">
            {d.cast.length === 0 && <p className="muted">No cast listed.</p>}
            {d.cast.map((c, i) => (
              <div key={c.name + i} className="person" style={{ ["--i" as any]: Math.min(i, 14) }}>
                <div className="person-img" style={c.photo ? { backgroundImage: `url(${c.photo})` } : undefined}>{!c.photo && c.name[0]}</div>
                <div className="person-name">{c.name}</div>
                {c.character && <div className="person-role">{c.character}</div>}
                {c.actor && <div className="person-role">CV {c.actor}</div>}
              </div>
            ))}
            {d.crew.length > 0 && (
              <>
                <h5 className="people-hd">Behind the camera</h5>
                {d.crew.map((c, i) => (
                  <div key={c.name + c.job} className="person crew" style={{ ["--i" as any]: Math.min(i + d.cast.length, 20) }}>
                    <div className="person-img" style={c.photo ? { backgroundImage: `url(${c.photo})` } : undefined}>{!c.photo && c.name[0]}</div>
                    <div className="person-name">{c.name}</div>
                    <div className="person-role">{c.job}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {curTab === "details" && <Details d={d} anime={anime} />}

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

type Detail = Awaited<ReturnType<typeof getDetail>>;

/** Everything else worth knowing, as a fact sheet. Rows with no data are left out. */
function Details({ d, anime }: { d: Detail; anime: boolean }) {
  const people = (jobs: RegExp) => [...new Set(d.crew.filter((c) => jobs.test(c.job)).map((c) => c.name))].join(", ");
  const ep = (e?: Detail["lastEpisode"]) => (e ? `S${e.season} · E${e.episode}${e.name ? ` · ${e.name}` : ""}${e.airDate ? ` (${fmtDate(e.airDate)})` : ""}` : "");
  const multiple = d.budget && d.revenue ? d.revenue / d.budget : 0;
  const ended = !!d.status && !/return|airing|production|releasing|planned/i.test(d.status);
  const rows: [string, string | undefined | null][] = [
    [d.kind === "movie" ? "Released" : "First aired", fmtDate(d.releaseDate)],
    ["Last aired", d.kind !== "movie" && ended ? fmtDate(d.endDate) : ""],
    ["Season", d.seasonLabel],
    ["Format", d.format],
    ["Runtime", d.runtime ? (d.kind === "movie" ? fmtRuntime(d.runtime) : `${d.runtime} min per episode`) : ""],
    ["Episodes", d.totalEpisodes ? String(d.totalEpisodes) : d.episodeCount ? String(d.episodeCount) : ""],
    ["Last episode", ep(d.lastEpisode)],
    [
      "Next episode",
      ep(d.nextEpisode) ||
        (d.nextAiring ? `E${d.nextAiring.episode} · ${new Date(d.nextAiring.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""),
    ],
    ["Status", d.status ? d.status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : ""],
    ["Budget", fmtMoney(d.budget)],
    ["Box office", d.revenue ? `${fmtMoney(d.revenue)}${multiple ? ` · ${multiple.toFixed(1)}× budget` : ""}` : ""],
    [d.kind === "movie" || anime ? "Director" : "Created by", people(d.kind === "movie" || anime ? /^(Chief )?Director$/ : /^Creator$/)],
    ["Written by", people(/Screenplay|Writer|Story|Novel|Series Composition|Script|Original Creator/)],
    ["Music", people(/Music|Composer/)],
    ["Source material", d.source],
    [anime ? "Studio" : "Production", d.companies?.slice(0, 4).join(", ")],
    ["Network", d.networks?.join(", ")],
    ["Country", d.countries?.join(", ")],
    ["Original language", languageName(d.originalLanguage)],
    ["Age rating", d.certification],
    ["Collection", d.collection],
    ["Original title", d.originalTitle && d.originalTitle !== d.title ? d.originalTitle : ""],
    ["Votes", d.voteCount ? d.voteCount.toLocaleString() : ""],
  ];
  return (
    <div className="facts">
      <dl>
        {rows
          .filter(([, v]) => v)
          .map(([k, v], i) => (
            <div key={k} className="fact" style={{ ["--i" as any]: Math.min(i, 20) }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      <div className="facts-foot">
        {d.imdbId && <a className="btn glass sm" href={`https://www.imdb.com/title/${d.imdbId}/`} target="_blank" rel="noreferrer">IMDb</a>}
        {d.homepage && <a className="btn glass sm" href={d.homepage} target="_blank" rel="noreferrer">Official site</a>}
        <span className="muted">
          Data from {d.key.startsWith("anilist:") ? "AniList" : "TMDB"}
          {d.fetchedAt ? ` · updated ${fmtAgo(d.fetchedAt)}` : ""}
        </span>
      </div>
    </div>
  );
}
