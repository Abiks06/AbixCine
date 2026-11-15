import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Ambient } from "../components/Ambient";
import { Art } from "../components/Art";
import { Card, CardSkeleton, kindLabel } from "../components/Card";
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
import { getProgress, useMatchedProgress, useProgressStore } from "../lib/progress";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import { isFilm, type CanonicalSeason, type Episode, type Media, type MediaDetail } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { toggleList, useSaved } from "../lib/watchlist";

type Tab = "episodes" | "cast" | "details" | "more";
type EpView = "list" | "grid";

const VIEW_KEY = "abx.epview";
const PAGE = 50;
const loadView = (): EpView | null => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "grid" ? v : null;
  } catch {
    return null;
  }
};
const nice = (status: string) => status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function Title() {
  const rawKeyParam = useParams().key ?? "";
  const key = decodeKey(rawKeyParam);
  const [searchParams] = useSearchParams();
  const routeParams = useMemo(() => parseSeasonEpisodeParams(searchParams), [searchParams]);
  const nav = useNavigate();
  const loc = useLocation();

  const { data: detail, error, reload } = useAsync(() => getDetail(key), [key]);
  // The card that brought you here hands over what it already knew, so the stage paints on the
  // first frame (and the artwork can morph into it) while cast, seasons and servers arrive.
  const seed = (loc.state as { seed?: Media } | null)?.seed;
  const d: MediaDetail | undefined = useMemo(
    () => detail ?? (seed && seed.key === key ? { ...seed, cast: [], crew: [], related: [] } : undefined),
    [detail, seed, key],
  );
  const ready = !!detail;

  // Every key this show's progress may have been saved under: its own, the franchise root, each season and cour.
  const progressKeys = useMemo(() => {
    if (!d) return [key];
    const out = new Set<string>([key, d.key, ...(d.canonicalKey ? [d.canonicalKey] : [])]);
    for (const s of [...(d.seasons ?? []), ...(d.specials ?? [])]) {
      if (s.key) out.add(s.key);
      for (const c of s.cours ?? []) out.add(c.key);
    }
    return [...out];
  }, [d, key]);
  const latest = useMatchedProgress(progressKeys);
  useProgressStore(); // episode tiles read their own entries: re-render when any of them moves

  // Map a saved entry across the show or its cours to a canonical (season, episode) pair.
  const matchedProgress = useMemo(() => {
    if (!d || !latest) return undefined;
    const allSeasons = [...(d.seasons ?? []), ...(d.specials ?? [])];
    // Recorded against a specific cour without a canonical season: place it inside its season.
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
  }, [d, latest]);

  // Per-title view state resets when the title changes (this component stays mounted across titles).
  const [pickedSeason, setPickedSeason] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("episodes");
  const [jump, setJump] = useState("");
  const [page, setPage] = useState(0);
  // Long-running shows have more episode ranges than fit: keep the lit one in view (e.g. on resume).
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const on = strip?.querySelector<HTMLElement>("button.on");
    if (!strip || !on) return;
    const sr = strip.getBoundingClientRect();
    const br = on.getBoundingClientRect();
    if (br.left < sr.left || br.right > sr.right) strip.scrollBy({ left: br.left - sr.left - (sr.width - br.width) / 2, behavior: "smooth" });
  }, [page, key]);
  useEffect(() => {
    setPickedSeason(null);
    setTab("episodes");
    setJump("");
  }, [key]);

  // Active canonical season, strictly clamped to playable seasons / specials.
  const activeSeasonObj: CanonicalSeason | undefined = useMemo(() => {
    if (!d || isFilm(d)) return undefined;
    const preferred = pickedSeason ?? routeParams.season ?? matchedProgress?.season ?? d.initialSeason;
    return clampSeason(d, preferred);
  }, [d, pickedSeason, routeParams.season, matchedProgress?.season]);

  const season = activeSeasonObj?.number ?? 1;

  const eps = useAsync(
    () => (detail && !isFilm(detail) ? getSeasonEpisodes(detail, activeSeasonObj?.number) : Promise.resolve([] as Episode[])),
    [detail?.key, activeSeasonObj?.number],
  );

  useSettings(); // re-render when the audio preference changes
  const saved = useSaved(key, d?.canonicalKey, d?.key);
  const [swap, setSwap] = useState(false);
  const swapTimer = useRef<number>();
  useEffect(() => () => clearTimeout(swapTimer.current), []);
  const [view, setView] = useState<EpView | null>(loadView);

  const resumeEpisode = matchedProgress && (matchedProgress.season == null || matchedProgress.season === season) ? matchedProgress.episode ?? 1 : 1;
  useEffect(() => {
    setPage(Math.max(0, Math.floor((resumeEpisode - 1) / PAGE)));
  }, [key, season, resumeEpisode]);

  const canonicalKey = d?.canonicalKey ?? d?.key ?? key;
  const anime = key.startsWith("anilist:") || d?.kind === "anime";
  const audio = anime ? audioFor(canonicalKey, [key, d?.key]) : undefined;

  // An AniList film is still looked up as anime (episode 1 behind the scenes), but it is a film:
  // no episode list, "Play" not "Play E1", and its runtime rather than "1 episode".
  const film = d ? isFilm(d) : key.includes(":movie:");
  const isSeries = !film;
  const hasPlayableEps = !!(
    isSeries &&
    ((d?.seasons && d.seasons.length > 0) ||
      (d?.specials && d.specials.length > 0) ||
      (d?.episodeCount && d.episodeCount > 0))
  );
  const showEpisodesTab = isSeries && (!ready || hasPlayableEps || (d?.upcomingSeasons?.length ?? 0) > 0);

  // What pressing Play would start: clamped resume point, else the first episode of the active season, else the film.
  const startS = useMemo(() => {
    if (!d || isFilm(d)) return undefined;
    if (matchedProgress?.season != null) {
      return clampSeason(d, matchedProgress.season)?.number ?? activeSeasonObj?.number;
    }
    return activeSeasonObj?.number;
  }, [d, matchedProgress?.season, activeSeasonObj?.number]);

  const startE = useMemo(() => {
    if (!d || isFilm(d)) return undefined;
    const targetS = startS != null ? clampSeason(d, startS) : activeSeasonObj;
    return clampEpisode(targetS, matchedProgress?.episode ?? routeParams.episode ?? 1, d.episodeCount);
  }, [d, startS, activeSeasonObj, matchedProgress?.episode, routeParams.episode]);

  // Only the real record drives the source lookup: a seed has no seasons to resolve an episode against.
  const req = useMemo(() => (detail ? resolvePlaybackRequest(detail, startS, startE, audio) : null), [detail, startS, startE, audio]);

  if (error && !d) {
    return (
      <div className="page empty">
        <span className="empty-ic"><Icon name="info" size={28} /></span>
        <h3>Couldn't load this title</h3>
        <p>{error.message || "The catalog didn't answer."}</p>
        <div className="acts">
          <button className="btn play sm" onClick={reload}><Icon name="refresh" size={15} /> Try again</button>
          <button className="btn glass sm" onClick={() => nav("/")}>Back to Home</button>
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="tp" aria-busy>
        <div className="tp-stage sk" />
      </div>
    );
  }

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
    : matchedProgress && film && matchedProgress.position > 30 ? "Resume"
    : hasPlayableEps ? "Play E1" : "Play";

  const firstSeason = d.seasons?.[0];
  const mainlineCount = d.seasons?.length ?? 0;
  const length =
    film
      ? fmtRuntime(d.runtime)
      : mainlineCount > 1
        ? `${mainlineCount} seasons`
        : mainlineCount === 1 && firstSeason
          ? `${firstSeason.episodeCount} episode${firstSeason.episodeCount === 1 ? "" : "s"}`
          : d.episodeCount
            ? `${d.episodeCount} episode${d.episodeCount === 1 ? "" : "s"}`
            : "";

  const what = film ? "this film" : startE != null ? `${startS != null ? (startS === 0 ? "Specials " : `S${startS} `) : ""}E${startE}` : "this film";
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
  const pickSeason = (n: number) => {
    setPickedSeason(n);
    setPage(0);
  };
  const chooseView = (v: EpView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const epList: Episode[] = eps.data ?? [];
  const hasMultipleSelectors =
    mainlineCount > 1 ||
    (mainlineCount >= 1 && (d.specials?.length ?? 0) > 0) ||
    (d.upcomingSeasons?.length ?? 0) > 0;
  const canPlay = ready && (film || hasPlayableEps);
  const resumePct = matchedProgress && !matchedProgress.upNext && matchedProgress.duration > 0 ? Math.min(1, matchedProgress.position / matchedProgress.duration) : null;

  return (
    <div className="tp">
      <Ambient media={d} />
      <div className="tp-stage" style={{ viewTransitionName: "hero" }}>
        <Art media={d} variant="backdrop" hd priority />
        <div className="tp-scrim" />
      </div>
      <div className="pad tp-body">
        <button className="back" onClick={() => (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0 ? nav(-1) : nav("/"))}><Icon name="back" size={18} /> Back</button>
        <div className="tp-top">
          <div className="tp-info">
            <div className="kicker">
              <b>{kindLabel(d.kind, d.format)}</b>
              {d.genres.length > 0 && <><i /><span>{d.genres.slice(0, 3).join(" · ")}</span></>}
            </div>
            <TitleArt media={d} />
            {d.tagline && <div className="tagline">{d.tagline}</div>}
            <div className="specs">
              {d.rating ? <span className="star">★ {d.rating.toFixed(1)} <small>{key.startsWith("anilist:") ? "AniList" : "TMDB"}</small></span> : null}
              {d.year ? <span>{d.year}</span> : null}
              {d.certification && <span className="cert">{d.certification}</span>}
              {length && <span>{length}</span>}
              {!film && d.runtime ? <span>{d.runtime}m per ep</span> : null}
              {d.status && <span>{nice(d.status)}</span>}
              {anime && <span className="hi">Sub · Dub</span>}
            </div>
            <p className="desc">{d.overview}</p>
            {d.nextAiring && (
              <div className="airing"><Icon name="clock" size={14} /> Episode {d.nextAiring.episode} airs {new Date(d.nextAiring.at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}</div>
            )}
            <div className="acts">
              {canPlay ? (
                <button className="btn play" onClick={() => watch(startS, startE)}><Icon name="play" size={16} /> {playLabel}</button>
              ) : !ready ? (
                <button className="btn play" disabled><span className="mini-spin" /> Loading</button>
              ) : null}
              <button className={`btn glass ${saved ? "on" : ""}`} onClick={() => toggleList(d)} aria-pressed={saved}>
                <Icon name={saved ? "check" : "bookmark"} size={17} /> {saved ? "In My List" : "My List"}
              </button>
              {audio && <AudioToggle value={audio} onChange={changeAudio} />}
              {d.trailerYouTubeId && (
                <a className="btn glass" href={`https://www.youtube.com/watch?v=${d.trailerYouTubeId}`} target="_blank" rel="noreferrer"><Icon name="film" size={17} /> Trailer</a>
              )}
            </div>
            {resumePct != null && matchedProgress && (
              <div className="resume">
                <div className="resume-bar"><i style={{ transform: `scaleX(${resumePct})` }} /></div>
                <span>{Math.max(1, Math.round((matchedProgress.duration - matchedProgress.position) / 60))}m left{startE != null ? ` in E${startE}` : ""}</span>
              </div>
            )}
          </div>
          {req ? (
            <SmartSource req={req} what={what} onPlay={(srv) => watch(startS, startE, srv)} />
          ) : (
            <aside className="smart">
              <div className="h"><span><Icon name="layers" size={16} /> Servers</span></div>
              <div className="smart-note">{!ready ? "Finding where this plays…" : isSeries && !hasPlayableEps ? "No aired episodes available yet." : "Loading season…"}</div>
            </aside>
          )}
        </div>

        <div className="tabbar" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={curTab === id} className={curTab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
          {curTab === "episodes" && ready && (
            <div className="tabbar-end">
              {hasMultipleSelectors && (
                <div className="season-pick" role="group" aria-label="Seasons">
                  {(d.seasons ?? []).map((s) => {
                    const courNote = s.cours && s.cours.length > 1 ? ` · ${s.cours.length} parts merged` : "";
                    return (
                      <button key={s.number} className={s.number === season ? "on" : ""} aria-pressed={s.number === season} title={`${s.name}${s.year ? ` (${s.year})` : ""} · ${s.episodeCount} episodes${courNote}`} onClick={() => pickSeason(s.number)}>
                        S{s.number}
                      </button>
                    );
                  })}
                  {(d.specials ?? []).map((sp) => (
                    <button key={`special-${sp.number}`} className={season === sp.number ? "on" : ""} aria-pressed={season === sp.number} title={`${sp.name} · ${sp.episodeCount} special${sp.episodeCount === 1 ? "" : "s"}`} onClick={() => pickSeason(sp.number)}>
                      {(d.specials?.length ?? 0) > 1 ? sp.name : "Specials"}
                    </button>
                  ))}
                  {(d.upcomingSeasons ?? []).map((u) => (
                    <span key={`upcoming-${u.number}-${u.name}`} className="chip muted" title={`${u.name}${u.year ? ` (${u.year})` : ""} · Unaired / TBA`} aria-disabled="true">
                      S{u.number} TBA
                    </span>
                  ))}
                </div>
              )}
              <div className="view-pick" role="group" aria-label="Episode layout">
                <button className={view !== "grid" ? "on" : ""} aria-pressed={view !== "grid"} title="Editorial list" aria-label="Editorial list" onClick={() => chooseView("list")}><Icon name="rows" size={15} /></button>
                <button className={view === "grid" ? "on" : ""} aria-pressed={view === "grid"} title="Compact grid" aria-label="Compact grid" onClick={() => chooseView("grid")}><Icon name="grid" size={15} /></button>
              </div>
            </div>
          )}
        </div>

        <div className="tp-section" key={curTab}>
          {curTab === "episodes" && (() => {
            // Long anime runs (One Piece is past 1,100) are paged in blocks of 50.
            const paged = epList.length > PAGE;
            const pages = Math.max(1, Math.ceil(epList.length / PAGE));
            const safePage = Math.max(0, Math.min(page, pages - 1));
            const shown = paged ? epList.slice(safePage * PAGE, safePage * PAGE + PAGE) : epList;
            const upNext = matchedProgress?.episode != null ? matchedProgress.episode : undefined;
            const waiting = !ready || (eps.loading && !eps.data);

            if (!waiting && epList.length === 0) {
              return (
                <div className="empty" style={{ padding: "40px 0" }}>
                  <p>No aired episodes available for this season yet.</p>
                  {firstSeason && season !== firstSeason.number && (
                    <button className="btn glass sm" onClick={() => pickSeason(firstSeason.number)}>Go to Season {firstSeason.number}</button>
                  )}
                </div>
              );
            }

            const hasStills = shown.some((e) => e.still) || !!d.backdrop;
            // Stills and synopses read best as a list; a long run without them is a wall, so it gets tiles.
            const layout = !hasStills ? "compact" : (view ?? (epList.length > 30 ? "grid" : "list")) === "list" ? "list" : "";

            return (
              <>
                {(paged || epList.length > 12) && (
                  <div className="ep-tools">
                    {paged && (
                      <div className="season-strip" ref={stripRef}>
                        {Array.from({ length: pages }, (_, p) => (
                          <button key={p} className={p === safePage ? "on" : ""} onClick={() => setPage(p)}>{p * PAGE + 1}–{Math.min(epList.length, (p + 1) * PAGE)}</button>
                        ))}
                      </div>
                    )}
                    <form
                      className="ep-jump"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        const clamped = clampEpisode(activeSeasonObj, Number(jump), epList.length);
                        if (clamped != null) watch(season, clamped);
                      }}
                    >
                      <Icon name="search" size={14} />
                      <input value={jump} onChange={(ev) => setJump(ev.target.value.replace(/\D/g, ""))} placeholder="Jump to episode" inputMode="numeric" aria-label="Jump to episode number" />
                      {jump && <button className="chip" type="submit">Play E{jump}</button>}
                    </form>
                  </div>
                )}
                <div className={`ep-grid swap ${swap ? "out" : ""} ${layout}`} key={`${season}-${audio}-${safePage}`}>
                  {waiting && Array.from({ length: 6 }, (_, i) => <div key={i} className="ep-card skeleton" />)}
                  {!waiting && shown.map((e, i) => {
                    const pKey = e.sourceKey ?? d.key;
                    const pEp = e.courEpisode ?? e.number;
                    const p = getProgress(canonicalKey, season, e.number, [d.key, pKey]) ?? getProgress(pKey, undefined, pEp);
                    const isCur = upNext === e.number && (matchedProgress?.season ?? season) === season;
                    const watched = !!p && p.duration > 0 && p.position / p.duration > 0.92;
                    // Episodes without their own still (often unaired ones) get the show's art, dimmed.
                    const still = e.still ?? d.backdrop;
                    const left = p && p.duration > 0 && !watched ? Math.max(1, Math.round((p.duration - p.position) / 60)) : null;
                    const fallback = e.airDate
                      ? new Date(`${e.airDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                      : audio ? (audio === "dub" ? "English dub" : "Japanese audio · English subtitles") : "";
                    return (
                      <button key={e.number} className={`ep-card ${isCur ? "cur" : ""} ${watched ? "seen" : ""}`} style={{ ["--i" as string]: Math.min(i, 8) }} onClick={() => watch(season, e.number)}>
                        <div className="ec-th">
                          {still && <img src={still} alt="" loading="lazy" decoding="async" className={e.still ? "" : "dim"} />}
                          <span className="ec-num">{e.number}</span>
                          {isCur && <span className="ec-ribbon">{p && p.position > 30 ? "Resume" : "Up next"}</span>}
                          {watched && <span className="ec-seen" aria-label="Watched"><Icon name="check" size={12} /></span>}
                          {e.runtime ? <span className="ec-rt">{e.runtime}m</span> : null}
                          <span className="ec-play"><Icon name="play" size={18} /></span>
                          {p && p.duration > 0 && !watched && <div className="ec-bar"><i style={{ transform: `scaleX(${Math.min(1, p.position / p.duration)})` }} /></div>}
                        </div>
                        <div className="ec-tx">
                          <div className="ec-t">{e.title}</div>
                          <div className="ec-d">{layout === "list" ? [left != null ? `${left}m left` : null, e.overview || fallback].filter(Boolean).join(" · ") : left != null ? `${left}m left` : e.overview || fallback}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}

          {curTab === "cast" && (
            <div className="people">
              {!ready && Array.from({ length: 8 }, (_, i) => <div key={i} className="person"><div className="person-img sk" /></div>)}
              {ready && d.cast.length === 0 && d.crew.length === 0 && <p className="muted">No cast listed.</p>}
              {d.cast.map((c, i) => (
                <div key={c.name + i} className="person" style={{ ["--i" as string]: Math.min(i, 10) }}>
                  <div className="person-img" style={c.photo ? { backgroundImage: `url(${c.photo})` } : undefined}>{!c.photo && c.name[0]}</div>
                  <div className="person-name">{c.name}</div>
                  {c.character && <div className="person-role">{c.character}</div>}
                  {c.actor && <div className="person-role">CV {c.actor}</div>}
                </div>
              ))}
              {d.crew.length > 0 && (
                <>
                  <p className="overline people-hd">Behind the camera</p>
                  {d.crew.map((c, i) => (
                    <div key={`${c.name}-${c.job}-${i}`} className="person crew" style={{ ["--i" as string]: Math.min(i, 10) }}>
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
              {!ready && Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)}
              {ready && d.related.length === 0 && <p className="muted">Nothing related yet.</p>}
              {d.related.map((m, i) => <Card key={m.key} media={m} index={i} />)}
            </div>
          )}
        </div>
        <div style={{ height: 96 }} />
      </div>
    </div>
  );
}

/** Everything else worth knowing, as a fact sheet. Rows with no data are left out. */
function Details({ d, anime }: { d: MediaDetail; anime: boolean }) {
  const people = (jobs: RegExp) => [...new Set(d.crew.filter((c) => jobs.test(c.job)).map((c) => c.name))].join(", ");
  const ep = (e?: MediaDetail["lastEpisode"]) => (e ? `S${e.season} · E${e.episode}${e.name ? ` · ${e.name}` : ""}${e.airDate ? ` (${fmtDate(e.airDate)})` : ""}` : "");
  const multiple = d.budget && d.revenue ? d.revenue / d.budget : 0;
  const ended = !!d.status && !/return|airing|production|releasing|planned/i.test(d.status);
  const rows: [string, string | undefined | null][] = [
    [isFilm(d) ? "Released" : "First aired", fmtDate(d.releaseDate)],
    ["Last aired", !isFilm(d) && ended ? fmtDate(d.endDate) : ""],
    ["Season", d.seasonLabel],
    ["Format", d.format],
    ["Runtime", d.runtime ? (isFilm(d) ? fmtRuntime(d.runtime) : `${d.runtime} min per episode`) : ""],
    ["Episodes", d.totalEpisodes ? String(d.totalEpisodes) : d.episodeCount ? String(d.episodeCount) : ""],
    ["Last episode", ep(d.lastEpisode)],
    [
      "Next episode",
      ep(d.nextEpisode) ||
        (d.nextAiring ? `E${d.nextAiring.episode} · ${new Date(d.nextAiring.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""),
    ],
    ["Status", d.status ? nice(d.status) : ""],
    ["Budget", fmtMoney(d.budget)],
    ["Box office", d.revenue ? `${fmtMoney(d.revenue)}${multiple ? ` · ${multiple.toFixed(1)}× budget` : ""}` : ""],
    [isFilm(d) || anime ? "Director" : "Created by", people(isFilm(d) || anime ? /^(Chief )?Director$/ : /^Creator$/)],
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
  const shown = rows.filter(([, v]) => v);
  return (
    <div className="facts">
      {shown.length === 0 ? (
        <p className="muted">Fetching the details…</p>
      ) : (
        <dl>
          {shown.map(([k, v], i) => (
            <div key={k} className="fact" style={{ ["--i" as string]: Math.min(i, 12) }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="facts-foot">
        {d.imdbId && <a className="btn glass sm" href={`https://www.imdb.com/title/${d.imdbId}/`} target="_blank" rel="noreferrer">IMDb <Icon name="arrowUR" size={13} /></a>}
        {d.homepage && <a className="btn glass sm" href={d.homepage} target="_blank" rel="noreferrer">Official site <Icon name="arrowUR" size={13} /></a>}
        <span className="muted">
          Data from {d.key.startsWith("anilist:") ? "AniList" : "TMDB"}
          {d.fetchedAt ? ` · updated ${fmtAgo(d.fetchedAt)}` : ""}
        </span>
      </div>
    </div>
  );
}
