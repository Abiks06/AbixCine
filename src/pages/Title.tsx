import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Ambient } from "../components/Ambient";
import { Art } from "../components/Art";
import { Card, kindLabel } from "../components/Card";
import { Icon } from "../components/Icon";
import { SmartSource } from "../components/SmartSource";
import { TitleArt } from "../components/TitleArt";
import {
  clampEpisode,
  clampSeason,
  decodeKey,
  encodeKey,
  getDetail,
  getSeasonEpisodes,
  parseSeasonEpisodeParams,
  resolvePlaybackRequest,
} from "../lib/catalog";
import { fmtAgo, fmtDate, fmtMoney, fmtRuntime, languageName } from "../lib/format";
import { getProgress, useContinueWatching } from "../lib/progress";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import type { CanonicalSeason, Episode } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { toggleList, useWatchlist } from "../lib/watchlist";

type Tab = "episodes" | "cast" | "details" | "more";

export function Title() {
  const rawKeyParam = useParams().key ?? "";
  const key = decodeKey(rawKeyParam);
  const [searchParams] = useSearchParams();
  const routeParams = useMemo(() => parseSeasonEpisodeParams(searchParams), [searchParams]);
  const nav = useNavigate();

  const { data: d, error } = useAsync(() => getDetail(key), [key]);
  const cw = useContinueWatching();

  // Map any saved progress entry across the show or its cours to a canonical (season, episode) pair.
  const matchedProgress = useMemo(() => {
    if (!d) return undefined;
    const allSeasons = [...(d.seasons ?? []), ...(d.specials ?? [])];
    const validKeys = new Set<string>([d.key, ...(d.canonicalKey ? [d.canonicalKey] : [])]);
    for (const s of allSeasons) {
      if (s.key) validKeys.add(s.key);
      for (const c of s.cours ?? []) validKeys.add(c.key);
    }
    const candidates = cw.filter((p) => validKeys.has(p.media.key)).sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = candidates[0];
    if (!latest) return undefined;

    // If progress was recorded against a specific cour without a canonical season, map it into its canonical season.
    if (latest.season == null && allSeasons.length > 0) {
      for (const s of allSeasons) {
        const cour = s.cours?.find((c) => c.key === latest.media.key);
        if (cour) {
          const epOffset = (latest.episode ?? 1) + cour.startEpisode - 1;
          return { ...latest, season: s.number, episode: clampEpisode(s, epOffset) ?? 1 };
        }
      }
    }
    return latest;
  }, [d, cw]);

  const [pickedSeason, setPickedSeason] = useState<number | null>(null);
  useEffect(() => {
    setPickedSeason(null);
  }, [key]);

  // Active canonical season, strictly clamped to playable seasons / specials.
  const activeSeasonObj: CanonicalSeason | undefined = useMemo(() => {
    if (!d || d.kind === "movie") return undefined;
    const preferred = pickedSeason ?? routeParams.season ?? matchedProgress?.season ?? d.initialSeason;
    return clampSeason(d, preferred);
  }, [d, pickedSeason, routeParams.season, matchedProgress?.season]);

  const season = activeSeasonObj?.number ?? 1;

  const eps = useAsync(
    () => (d && d.kind !== "movie" ? getSeasonEpisodes(d, activeSeasonObj?.number) : Promise.resolve([] as Episode[])),
    [d?.key, activeSeasonObj?.number],
  );

  useSettings(); // re-render when the audio preference changes
  const saved = useWatchlist().some((e) => e.media.key === key || (d?.canonicalKey && e.media.key === d.canonicalKey));
  const [tab, setTab] = useState<Tab>("episodes");
  const [swap, setSwap] = useState(false);
  const swapTimer = useRef<number>();
  useEffect(() => () => clearTimeout(swapTimer.current), []);
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState("");

  useEffect(() => {
    const resumeEp =
      matchedProgress && (matchedProgress.season == null || matchedProgress.season === season)
        ? matchedProgress.episode ?? 1
        : 1;
    setPage(Math.max(0, Math.floor((resumeEp - 1) / 50)));
  }, [key, season, matchedProgress]);

  const canonicalKey = d?.canonicalKey ?? d?.key ?? key;
  const anime = key.startsWith("anilist:") || d?.kind === "anime";
  const audio = anime ? audioFor(canonicalKey, [key, d?.key]) : undefined;

  const isSeries = d ? d.kind !== "movie" : !key.includes(":movie:");
  const hasPlayableEps = !!(
    isSeries &&
    ((d?.seasons && d.seasons.length > 0) ||
      (d?.specials && d.specials.length > 0) ||
      (d?.episodeCount && d.episodeCount > 0))
  );
  const showEpisodesTab = isSeries && (hasPlayableEps || (d?.upcomingSeasons?.length ?? 0) > 0);

  // What pressing Play would start: clamped resume point, else the first episode of the active season, else the film.
  const startS = useMemo(() => {
    if (!d || d.kind === "movie") return undefined;
    if (matchedProgress?.season != null) {
      return clampSeason(d, matchedProgress.season)?.number ?? activeSeasonObj?.number;
    }
    return activeSeasonObj?.number;
  }, [d, matchedProgress?.season, activeSeasonObj?.number]);

  const startE = useMemo(() => {
    if (!d || d.kind === "movie") return undefined;
    const targetS = startS != null ? clampSeason(d, startS) : activeSeasonObj;
    return clampEpisode(targetS, matchedProgress?.episode ?? routeParams.episode ?? 1, d.episodeCount);
  }, [d, startS, activeSeasonObj, matchedProgress?.episode, routeParams.episode]);

  const req = useMemo(
    () => (d ? resolvePlaybackRequest(d, startS, startE, audio) : null),
    [d, startS, startE, audio],
  );

  if (error) return <div className="page empty"><p>Couldn't load this title. {error.message}</p></div>;
  if (!d) return <div className="tp"><div className="tp-skeleton" /></div>;

  const watch = (s?: number, e?: number, srv?: string) => {
    const resolved = resolvePlaybackRequest(d, s, e, audio);
    const targetKey = resolved?.media.key ?? d.key;
    const clampedS = resolved?.season ?? s;
    const clampedE = resolved?.episode ?? e;
    const qs = new URLSearchParams({
      ...(clampedS != null ? { s: String(clampedS) } : {}),
      ...(clampedE != null ? { e: String(clampedE) } : {}),
      ...(audio ? { a: audio } : {}),
      ...(srv ? { srv } : {}),
    });
    nav(`/watch/${encodeKey(targetKey)}${qs.size ? `?${qs}` : ""}`, { viewTransition: true, state: { from: "app" } });
  };

  const epTag =
    matchedProgress && startE != null
      ? `${startS != null && (d.seasons?.length ?? 0) > 1 ? `S${startS} · ` : startS === 0 ? "Specials · " : ""}E${startE}`
      : "";
  const playLabel = matchedProgress && hasPlayableEps
    ? matchedProgress.upNext ? `Play ${epTag}` : epTag ? `Resume ${epTag}` : "Resume"
    : hasPlayableEps ? "Play E1" : "Play";

  const firstSeason = d.seasons?.[0];
  const mainlineCount = d.seasons?.length ?? 0;
  const length =
    d.kind === "movie"
      ? fmtRuntime(d.runtime)
      : mainlineCount > 1
        ? `${mainlineCount} seasons`
        : mainlineCount === 1 && firstSeason
          ? `${firstSeason.episodeCount} episode${firstSeason.episodeCount === 1 ? "" : "s"}`
          : d.episodeCount
            ? `${d.episodeCount} episode${d.episodeCount === 1 ? "" : "s"}`
            : "";

  const what = startE != null ? `${startS != null ? (startS === 0 ? "Specials " : `S${startS} `) : ""}E${startE}` : "this film";
  const tabs: [Tab, string][] = [
    ...(showEpisodesTab ? [["episodes", "Episodes"] as [Tab, string]] : []),
    ["cast", anime ? "Characters & crew" : "Cast & crew"],
    ["details", "Details"],
    ["more", "More like this"],
  ];
  const curTab = showEpisodesTab || tab !== "episodes" ? tab : "cast";

  const changeAudio = (a: "sub" | "dub") => {
    setSwap(true);
    clearTimeout(swapTimer.current);
    swapTimer.current = window.setTimeout(() => {
      setAudioFor(canonicalKey, a, [key, d?.key]);
      setSwap(false);
    }, 200);
  };

  const epList: Episode[] = eps.data ?? [];
  const hasMultipleSelectors =
    mainlineCount > 1 ||
    (mainlineCount >= 1 && (d.specials?.length ?? 0) > 0) ||
    (d.upcomingSeasons?.length ?? 0) > 0;

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
              {(d.kind === "movie" || hasPlayableEps) && (
                <button className="btn play" onClick={() => watch(startS, startE)}><Icon name="play" size={16} /> {playLabel}</button>
              )}
              <button className={`btn glass ${saved ? "on" : ""}`} onClick={() => toggleList(d)}>
                <Icon name={saved ? "check" : "bookmark"} size={17} /> {saved ? "In My List" : "My List"}
              </button>
              {audio && <AudioToggle value={audio} onChange={changeAudio} />}
              {d.trailerYouTubeId && (
                <a className="btn glass" href={`https://www.youtube.com/watch?v=${d.trailerYouTubeId}`} target="_blank" rel="noreferrer">Trailer</a>
              )}
            </div>
            {matchedProgress && !matchedProgress.upNext && matchedProgress.duration > 0 && (
              <div className="resume">
                <div className="resume-bar"><i style={{ width: `${(matchedProgress.position / matchedProgress.duration) * 100}%` }} /></div>
                <span>{Math.max(1, Math.round((matchedProgress.duration - matchedProgress.position) / 60))}m left{startE != null ? ` in E${startE}` : ""}</span>
              </div>
            )}
          </div>
          {req ? (
            <SmartSource req={req} what={what} onPlay={(srv) => watch(startS, startE, srv)} />
          ) : (
            <aside className="glass smart">
              <div className="smart-note">{isSeries && !hasPlayableEps ? "No aired episodes available yet." : "Loading season…"}</div>
            </aside>
          )}
        </div>

        <div className="tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={curTab === id} className={curTab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
          {curTab === "episodes" && hasMultipleSelectors && (
            <div className="season-pick" role="group" aria-label="Seasons">
              {(d.seasons ?? []).map((s) => {
                const courNote = s.cours && s.cours.length > 1 ? ` · ${s.cours.length} parts merged` : "";
                return (
                  <button
                    key={s.number}
                    className={s.number === season ? "on" : ""}
                    title={`${s.name}${s.year ? ` (${s.year})` : ""} · ${s.episodeCount} episodes${courNote}`}
                    onClick={() => {
                      setPickedSeason(s.number);
                      setPage(0);
                    }}
                  >
                    S{s.number}
                  </button>
                );
              })}
              {(d.specials ?? []).map((sp) => (
                <button
                  key={`special-${sp.number}`}
                  className={season === 0 ? "on" : ""}
                  title={`${sp.name} · ${sp.episodeCount} special${sp.episodeCount === 1 ? "" : "s"}`}
                  onClick={() => {
                    setPickedSeason(0);
                    setPage(0);
                  }}
                >
                  Specials
                </button>
              ))}
              {(d.upcomingSeasons ?? []).map((u) => (
                <span
                  key={`upcoming-${u.number}-${u.name}`}
                  className="chip muted"
                  title={`${u.name}${u.year ? ` (${u.year})` : ""} · Unaired / TBA`}
                  aria-disabled="true"
                >
                  S{u.number} TBA
                </span>
              ))}
            </div>
          )}
        </div>

        {curTab === "episodes" && (() => {
          // Long anime runs (One Piece is past 1,100) are paged in blocks of 50.
          const PAGE = 50;
          const paged = epList.length > PAGE;
          const pages = Math.max(1, Math.ceil(epList.length / PAGE));
          const safePage = Math.max(0, Math.min(page, pages - 1));
          const shown = paged ? epList.slice(safePage * PAGE, safePage * PAGE + PAGE) : epList;
          const upNext = matchedProgress?.episode != null ? matchedProgress.episode : undefined;

          if (!eps.loading && epList.length === 0) {
            return (
              <div className="empty" style={{ padding: "32px 0" }}>
                <p className="muted">No aired episodes available for this season yet.</p>
                {firstSeason && season !== firstSeason.number && (
                  <button className="btn glass sm" onClick={() => { setPickedSeason(firstSeason.number); setPage(0); }}>
                    Go to Season {firstSeason.number}
                  </button>
                )}
              </div>
            );
          }

          return (
            <>
              {(paged || epList.length > 12) && (
                <div className="ep-tools">
                  {paged && (
                    <div className="season-strip">
                      {Array.from({ length: pages }, (_, p) => (
                        <button key={p} className={p === safePage ? "on" : ""} onClick={() => setPage(p)}>{p * PAGE + 1}–{Math.min(epList.length, (p + 1) * PAGE)}</button>
                      ))}
                    </div>
                  )}
                  <form
                    className="ep-jump"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      const n = Number(jump);
                      const clamped = clampEpisode(activeSeasonObj, n, epList.length);
                      if (clamped != null) watch(season, clamped);
                    }}
                  >
                    <Icon name="search" size={14} />
                    <input value={jump} onChange={(ev) => setJump(ev.target.value.replace(/\D/g, ""))} placeholder="Jump to episode" inputMode="numeric" />
                    {jump && <button className="chip" type="submit">Play E{jump}</button>}
                  </form>
                </div>
              )}
              <div className={`ep-grid swap ${swap ? "out" : ""} ${shown.some((e) => e.still) || d.backdrop ? "" : "compact"}`} key={`${season}-${audio}-${safePage}`}>
                {shown.map((e, i) => {
                  const pKey = e.sourceKey ?? d.key;
                  const pEp = e.courEpisode ?? e.number;
                  const p = getProgress(canonicalKey, season, e.number, [d.key, pKey]) ?? getProgress(pKey, undefined, pEp);
                  const isCur = upNext === e.number && (matchedProgress?.season ?? season) === season;
                  const watched = p && p.duration > 0 && p.position / p.duration > 0.92;
                  // Episodes without their own still (often unaired ones) get the show's art, dimmed.
                  const still = e.still ?? d.backdrop;
                  return (
                    <button key={e.number} className={`ep-card ${isCur ? "cur" : ""} ${watched ? "seen" : ""}`} style={{ ["--i" as any]: Math.min(i, 14) }} onClick={() => watch(season, e.number)}>
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
                            : e.overview || (e.airDate ? new Date(`${e.airDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : audio ? (audio === "dub" ? "English dub" : "Japanese audio · English subtitles") : "")}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {eps.loading && !eps.data && Array.from({ length: 6 }, (_, i) => <div key={i} className="ep-card skeleton" />)}
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
                  <div key={`${c.name}-${c.job}-${i}`} className="person crew" style={{ ["--i" as any]: Math.min(i + d.cast.length, 20) }}>
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
