import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Ambient } from "../components/Ambient";
import { Art, sized } from "../components/Art";
import { Card, CardSkeleton, kindLabel } from "../components/Card";
import { DownloadMenu } from "../components/DownloadMenu";
import { Icon } from "../components/Icon";
import { SmartSource } from "../components/SmartSource";
import { TitleArt } from "../components/TitleArt";
import { TrailerModal } from "../components/TrailerModal";
import {
  batchEpisodeKey,
  getBatchForSeason,
  queueEpisodeDownload,
  queueSeasonDownloads,
  selectMissingEpisodes,
  useBatchDownloads,
} from "../lib/batchDownload";
import {
  cancelAllDownloads,
  computeSeasonDownloadProgress,
  findDownloadedEpisode,
  fmtSpeed,
  formatDownloadQuality,
  formatQualityTag,
  pauseAllDownloads,
  pauseDownload,
  resumeAllDownloads,
  resumeDownload,
  switchDownloadToNextServer,
  useDownloads,
} from "../lib/downloads";
import { isYouTubeId } from "../lib/trailer";
import {
  checkEpisodeAvailability,
  clampEpisode,
  clampSeason,
  decodeKey,
  encodeKey,
  getDetail,
  getSeasonEpisodes,
  isFutureIsoDate,
  isTheatricalOnly,
  isUnairedEpisode,
  isUnreleasedMedia,
  parseSeasonEpisodeParams,
  resolvePlaybackRequest,
} from "../lib/catalog";
import { fmtAgo, fmtDate, fmtMoney, fmtRuntime, languageName } from "../lib/format";
import { getProgress, useMatchedProgress, useProgressStore } from "../lib/progress";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import { toast } from "../lib/toast";
import { isFilm, type CanonicalSeason, type Episode, type Media, type MediaDetail } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { burst } from "../lib/burst";
import { toggleList, useSaved } from "../lib/watchlist";

type Tab = "episodes" | "showcase" | "cast" | "details" | "more";
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

function fmtClock(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function Title() {
  const tabInd = useSlidingIndicator();
  const seasonInd = useSlidingIndicator();
  const viewInd = useSlidingIndicator();
  const rawKeyParam = useParams().key ?? "";
  const key = decodeKey(rawKeyParam);
  const [searchParams] = useSearchParams();
  const routeParams = useMemo(() => parseSeasonEpisodeParams(searchParams), [searchParams]);
  const nav = useNavigate();
  const loc = useLocation();

  const { data: detail, error, reload } = useAsync(() => getDetail(key), [key]);
  const seed = (loc.state as { seed?: Media } | null)?.seed;
  const morphTitle = (loc.state as { morph?: string } | null)?.morph === "title";
  const d: MediaDetail | undefined = useMemo(
    () => detail ?? (seed && seed.key === key ? { ...seed, cast: [], crew: [], related: [] } : undefined),
    [detail, seed, key],
  );
  const ready = !!detail;

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
  useProgressStore();

  const matchedProgress = useMemo(() => {
    if (!d || !latest) return undefined;
    const allSeasons = [...(d.seasons ?? []), ...(d.specials ?? [])];
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

  const validProgress = useMemo(() => {
    if (!matchedProgress) return undefined;
    if (!detail) return matchedProgress;
    const avail = checkEpisodeAvailability(detail, matchedProgress.season, matchedProgress.episode);
    return avail.playable ? matchedProgress : undefined;
  }, [detail, matchedProgress]);

  const [pickedSeason, setPickedSeason] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [jump, setJump] = useState("");
  const [page, setPage] = useState(0);
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
    setTab(null);
    setJump("");
  }, [key]);

  const activeSeasonObj: CanonicalSeason | undefined = useMemo(() => {
    if (!d || isFilm(d)) return undefined;
    const preferred = pickedSeason ?? routeParams.season ?? validProgress?.season ?? d.initialSeason;
    return clampSeason(d, preferred);
  }, [d, pickedSeason, routeParams.season, validProgress?.season]);

  const season = activeSeasonObj?.number ?? 1;

  const eps = useAsync(
    () => (detail && !isFilm(detail) ? getSeasonEpisodes(detail, activeSeasonObj?.number) : Promise.resolve([] as Episode[])),
    [detail?.key, activeSeasonObj?.number],
  );

  useSettings();
  const dl = useDownloads();
  const batch = useBatchDownloads();
  const desktop = isTauri();
  const saved = useSaved(key, d?.canonicalKey, d?.key);
  const [swap, setSwap] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const swapTimer = useRef<number>();
  useEffect(() => () => clearTimeout(swapTimer.current), []);
  const [view, setView] = useState<EpView | null>(loadView);

  const resumeEpisode = validProgress && (validProgress.season == null || validProgress.season === season) ? validProgress.episode ?? 1 : 1;
  useEffect(() => {
    setPage(Math.max(0, Math.floor((resumeEpisode - 1) / PAGE)));
  }, [key, season, resumeEpisode]);

  const canonicalKey = d?.canonicalKey ?? d?.key ?? key;
  const anime = key.startsWith("anilist:") || d?.kind === "anime";
  const audio = anime ? audioFor(canonicalKey, [key, d?.key]) : undefined;

  const film = d ? isFilm(d) : key.includes(":movie:");
  const isSeries = !film;
  const unreleasedFilm = film && ready && isUnreleasedMedia(d);
  const theatricalOnly = film && ready && !unreleasedFilm && isTheatricalOnly(d);
  const [checkAnyway, setCheckAnyway] = useState(false);
  useEffect(() => setCheckAnyway(false), [key]);
  const hasPlayableEps = !!(
    isSeries &&
    ((d?.seasons && d.seasons.length > 0) ||
      (d?.specials && d.specials.length > 0) ||
      (d?.episodeCount && d.episodeCount > 0))
  );
  const showEpisodesTab = isSeries && (!ready || hasPlayableEps || (d?.upcomingSeasons?.length ?? 0) > 0);

  const startS = useMemo(() => {
    if (!d || isFilm(d)) return undefined;
    if (validProgress?.season != null) {
      return clampSeason(d, validProgress.season)?.number ?? activeSeasonObj?.number;
    }
    return activeSeasonObj?.number;
  }, [d, validProgress?.season, activeSeasonObj?.number]);

  const startE = useMemo(() => {
    if (!d || isFilm(d)) return undefined;
    const targetS = startS != null ? clampSeason(d, startS) : activeSeasonObj;
    return clampEpisode(targetS, validProgress?.episode ?? routeParams.episode ?? 1, d.episodeCount);
  }, [d, startS, activeSeasonObj, validProgress?.episode, routeParams.episode]);

  const canPlay = ready && ((film && !unreleasedFilm) || hasPlayableEps);

  const req = useMemo(
    () => (detail && canPlay && (!theatricalOnly || checkAnyway) ? resolvePlaybackRequest(detail, startS, startE, audio) : null),
    [detail, canPlay, theatricalOnly, checkAnyway, startS, startE, audio],
  );

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
    validProgress && startE != null
      ? `${startS != null && (d.seasons?.length ?? 0) > 1 ? `S${startS} · ` : startS === 0 ? "Specials · " : ""}E${startE}`
      : "";
  const playLabel = validProgress && hasPlayableEps
    ? validProgress.upNext ? `Play ${epTag}` : epTag ? `Resume ${epTag}` : "Resume"
    : validProgress && film && validProgress.position > 30 ? "Resume"
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
  const tabs: [Tab, string][] = showEpisodesTab
    ? [
        ["episodes", "Episodes"],
        ["cast", anime ? "Characters & crew" : "Cast & crew"],
        ["details", "Technical sheet"],
        ["more", "More like this"],
      ]
    : [
        ["showcase", "Cast & related"],
        ["cast", anime ? "Full characters & crew" : "Full cast & crew"],
        ["details", "Technical sheet"],
        ["more", "More like this"],
      ];
  const defaultTab: Tab = showEpisodesTab ? "episodes" : "showcase";
  const curTab: Tab = tab && tabs.some(([id]) => id === tab) ? tab : defaultTab;

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
  const airedCount = activeSeasonObj?.episodeCount ?? (isSeries ? d.episodeCount : undefined);
  const hasMultipleSelectors =
    mainlineCount > 1 ||
    (mainlineCount >= 1 && (d.specials?.length ?? 0) > 0) ||
    (d.upcomingSeasons?.length ?? 0) > 0;
  const resumePct = validProgress && !validProgress.upNext && validProgress.duration > 0 ? Math.min(1, validProgress.position / validProgress.duration) : null;

  const endsAt = d.runtime && !unreleasedFilm ? fmtClock(new Date(Date.now() + d.runtime * 60_000)) : null;

  // Creative credits for the Monograph spread
  const findCrew = (re: RegExp) => d.crew.filter((c) => re.test(c.job));
  const directorLead = findCrew(film || anime ? /^(Chief )?Director$/i : /^Creator$/i)[0];
  const writerLead = findCrew(/Screenplay|Writer|Story|Novel|Series Composition|Script|Original Creator/i)[0];
  const dpLead = findCrew(/Director of Photography|Cinematography/i)[0];
  const musicLead = findCrew(/Music|Composer/i)[0];
  const creativeSlate = [
    directorLead && { role: film || anime ? "Director" : "Created by", person: directorLead },
    writerLead && { role: "Written by", person: writerLead },
    dpLead && { role: "Cinematography", person: dpLead },
    musicLead && { role: "Score", person: musicLead },
  ].filter(Boolean) as { role: string; person: { name: string; job: string; photo?: string } }[];

  const hasRoi = film && !!d.budget && !!d.revenue;
  const roiRatio = hasRoi ? d.revenue! / d.budget! : 0;
  const maxMoney = hasRoi ? Math.max(d.budget!, d.revenue!) : 1;

  return (
    <div className="tp">
      <Ambient media={d} />
      <div className="tp-stage" style={{ viewTransitionName: "hero" }}>
        <Art media={d} variant="backdrop" hd priority />
        <div className="tp-scrim" />
      </div>

      <div className="pad tp-body">
        <button className="back" onClick={() => (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0 ? nav(-1) : nav("/"))}>
          <Icon name="back" size={16} /> Back
        </button>

        {/* 3-zone theatrical gallery masthead */}
        <div className="tp-top">
          <div className="tp-poster-col">
            <div className="tp-poster gate-frame">
              <Art media={d} variant="poster" size="lg" priority />
              <span className="gate-brackets" aria-hidden><i /></span>
            </div>
            {(d.year || d.certification || d.format) && (
              <div className="tp-poster-foot">
                <span>{d.year ?? ""}</span>
                {d.certification && <span className="cert">{d.certification}</span>}
                {d.format && <span>{d.format}</span>}
              </div>
            )}
          </div>

          <div className="tp-info">
            <div className="kicker">
              <b>{kindLabel(d.kind, d.format)}</b>
              {d.genres.length > 0 && <><i /><span>{d.genres.slice(0, 3).join(" · ")}</span></>}
              {d.seasonLabel && <><i /><span>{d.seasonLabel}</span></>}
            </div>

            <TitleArt media={d} vtName={morphTitle ? "hero-title" : undefined} />
            {d.originalTitle && d.originalTitle !== d.title && <div className="tp-orig">{d.originalTitle}</div>}
            {d.tagline && <div className="tagline">“{d.tagline}”</div>}

            <div className="tp-telemetry">
              {d.rating ? (
                <div className="tp-gauge" title={`Rated ${d.rating.toFixed(1)}/10 on ${key.startsWith("anilist:") ? "AniList" : "TMDB"}`}>
                  <svg viewBox="0 0 40 40" aria-hidden>
                    <circle className="gauge-track" cx="20" cy="20" r="16" />
                    <circle className="gauge-arc" cx="20" cy="20" r="16" style={{ ["--p" as string]: Math.min(1, Math.max(0.04, d.rating / 10)) }} />
                  </svg>
                  <div className="tp-gauge-val">
                    <b>{d.rating.toFixed(1)}</b>
                  </div>
                  <div className="tp-gauge-meta">
                    <span>{key.startsWith("anilist:") ? "AniList" : "TMDB"}</span>
                    {d.voteCount ? <small>{d.voteCount >= 1000 ? `${(d.voteCount / 1000).toFixed(1)}k votes` : `${d.voteCount} votes`}</small> : null}
                  </div>
                </div>
              ) : null}

              {endsAt && (
                <div className="tp-end-stamp">
                  <span>{film ? "FINISHES" : "1 EP ENDS"}</span>
                  <b>{endsAt}</b>
                </div>
              )}

              <div className="specs">
                {d.year ? <span>{d.year}</span> : null}
                {d.certification && <span className="cert">{d.certification}</span>}
                {length && <span>{length}</span>}
                {!film && d.runtime ? <span>{d.runtime}m/ep</span> : null}
                {d.status && <span>{nice(d.status)}</span>}
                {anime && <span className="hi">Sub · Dub</span>}
              </div>
            </div>

            {unreleasedFilm && (
              <div className="airing"><Icon name="clock" size={14} /> {d.releaseDate ? `Releases ${fmtDate(d.releaseDate)}` : "Not released yet"}</div>
            )}
            {theatricalOnly && (
              <div className="airing">
                <Icon name="clock" size={14} />{" "}
                {d.digitalReleaseDate ? `In cinemas now · streaming from ${fmtDate(d.digitalReleaseDate)}` : "In cinemas now · no digital release announced yet"}
              </div>
            )}
            {d.nextAiring && (
              <div className="airing"><Icon name="clock" size={14} /> Episode {d.nextAiring.episode} airs {new Date(d.nextAiring.at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}</div>
            )}

            <div className="acts">
              {canPlay ? (
                <button className="btn play" onClick={() => watch(startS, startE)}><Icon name="play" size={16} /> {playLabel}</button>
              ) : !ready ? (
                <button className="btn play" disabled><span className="mini-spin" /> Loading</button>
              ) : null}
              <button className={`btn glass ${saved ? "on" : ""}`} onClick={(e) => { if (!saved) burst(e.currentTarget); toggleList(d); }} aria-pressed={saved}>
                <Icon name={saved ? "check" : "bookmark"} size={17} /> {saved ? "In My List" : "My List"}
              </button>
              {req && <DownloadMenu req={req} detail={d} what={what} />}
              {audio && <AudioToggle value={audio} onChange={changeAudio} />}
              {isYouTubeId(d.trailerYouTubeId) && (
                <button type="button" className="btn glass" onClick={() => setTrailerOpen(true)} aria-haspopup="dialog"><Icon name="film" size={17} /> Trailer</button>
              )}
            </div>

            {resumePct != null && validProgress && (
              <div className="resume">
                <div className="resume-bar"><i style={{ transform: `scaleX(${resumePct})` }} /></div>
                <span>{Math.max(1, Math.round((validProgress.duration - validProgress.position) / 60))}m left{startE != null ? ` in E${startE}` : ""}</span>
              </div>
            )}
          </div>

          {req ? (
            <SmartSource req={req} detail={d} what={what} onPlay={(srv) => watch(startS, startE, srv)} />
          ) : (
            <aside className="smart">
              <div className="h"><span><Icon name="layers" size={16} /> Servers</span></div>
              <div className="smart-note">
                {!ready
                  ? "Finding where this plays…"
                  : unreleasedFilm
                    ? d.releaseDate
                      ? `Not out yet — releases ${fmtDate(d.releaseDate)}. Servers will appear once it's available.`
                      : "Not released yet — servers will appear once it's available."
                    : theatricalOnly
                      ? (
                          <>
                            {d.digitalReleaseDate
                              ? `Still in cinemas — digital release ${fmtDate(d.digitalReleaseDate)}. Servers rarely carry it before then.`
                              : "Still in cinemas — servers rarely carry a film before its digital release."}{" "}
                            <button type="button" className="btn glass sm" onClick={() => setCheckAnyway(true)}>Check servers anyway</button>
                          </>
                        )
                    : isSeries && !hasPlayableEps
                      ? "No aired episodes available yet."
                      : "Loading season…"}
              </div>
            </aside>
          )}
        </div>

        {/* Always-visible Monograph Editorial Spread */}
        {(d.overview || creativeSlate.length > 0 || ready) && (
          <section className="tp-monograph" aria-label="Editorial monograph">
            <div className="tp-story">
              <p className="overline">Synopsis // Monograph</p>
              {d.overview ? <p className="tp-synopsis">{d.overview}</p> : <p className="muted">No synopsis listed.</p>}

              {creativeSlate.length > 0 && (
                <div className="tp-slate">
                  {creativeSlate.map(({ role, person }) => (
                    <div key={`${role}-${person.name}`} className="tp-credit">
                      <span className="tp-credit-av" style={person.photo ? { backgroundImage: `url(${person.photo})` } : undefined}>
                        {!person.photo && person.name[0]}
                      </span>
                      <div>
                        <small>{role}</small>
                        <strong>{person.name}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <aside className="tp-telemetry-card">
              <p className="overline">Production &amp; Release</p>

              {hasRoi && (
                <div className="tp-roi">
                  <div className="tp-roi-head">
                    <span>Box Office Performance</span>
                    <b>{roiRatio.toFixed(1)}× budget</b>
                  </div>
                  <div className="tp-roi-bars">
                    <div className="tp-roi-row">
                      <span>Budget</span>
                      <div className="tp-roi-track"><i style={{ width: `${Math.max(8, Math.round((d.budget! / maxMoney) * 100))}%` }} /></div>
                      <b>{fmtMoney(d.budget)}</b>
                    </div>
                    <div className="tp-roi-row rev">
                      <span>Revenue</span>
                      <div className="tp-roi-track"><i style={{ width: `${Math.max(8, Math.round((d.revenue! / maxMoney) * 100))}%` }} /></div>
                      <b>{fmtMoney(d.revenue)}</b>
                    </div>
                  </div>
                </div>
              )}

              <div className="tp-timeline">
                {film ? (
                  <>
                    {d.theatricalReleaseDate && (
                      <div><span>Theatrical</span><b>{fmtDate(d.theatricalReleaseDate)}</b></div>
                    )}
                    {d.digitalReleaseDate ? (
                      <div><span>{isFutureIsoDate(d.digitalReleaseDate) ? "Digital release" : "On digital"}</span><b>{fmtDate(d.digitalReleaseDate)}</b></div>
                    ) : d.releaseDate ? (
                      <div><span>{isUnreleasedMedia(d) ? "Releases" : "Released"}</span><b>{fmtDate(d.releaseDate)}</b></div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {d.releaseDate && <div><span>First aired</span><b>{fmtDate(d.releaseDate)}</b></div>}
                    {d.endDate && <div><span>Last aired</span><b>{fmtDate(d.endDate)}</b></div>}
                    {d.nextEpisode && (
                      <div><span>Next episode</span><b>S{d.nextEpisode.season}·E{d.nextEpisode.episode}</b></div>
                    )}
                  </>
                )}
                {(d.companies?.length || d.networks?.length) && (
                  <div>
                    <span>{anime ? "Studio" : film ? "Studio" : "Network"}</span>
                    <b>{(anime ? d.companies : d.networks?.length ? d.networks : d.companies)?.slice(0, 2).join(", ")}</b>
                  </div>
                )}
                {d.originalLanguage && (
                  <div><span>Language</span><b>{languageName(d.originalLanguage)}</b></div>
                )}
                {d.collection && (
                  <div><span>Collection</span><b>{d.collection}</b></div>
                )}
              </div>

              {(d.imdbId || d.homepage) && (
                <div className="tp-ext">
                  {d.imdbId && <a className="btn glass sm" href={`https://www.imdb.com/title/${d.imdbId}/`} target="_blank" rel="noreferrer">IMDb <Icon name="arrowUR" size={13} /></a>}
                  {d.homepage && <a className="btn glass sm" href={d.homepage} target="_blank" rel="noreferrer">Official site <Icon name="arrowUR" size={13} /></a>}
                </div>
              )}
            </aside>
          </section>
        )}

        {/* Interactive Lower Explorer */}
        <div className="tabbar" role="tablist" ref={tabInd}>
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={curTab === id} className={curTab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
          {curTab === "episodes" && ready && (
            <div className="tabbar-end">
              {hasMultipleSelectors && (
                <div className="season-pick" role="group" aria-label="Seasons" ref={seasonInd}>
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
              <div className="view-pick" role="group" aria-label="Episode layout" ref={viewInd}>
                <button className={view !== "grid" ? "on" : ""} aria-pressed={view !== "grid"} title="Editorial list" aria-label="Editorial list" onClick={() => chooseView("list")}><Icon name="rows" size={15} /></button>
                <button className={view === "grid" ? "on" : ""} aria-pressed={view === "grid"} title="Compact grid" aria-label="Compact grid" onClick={() => chooseView("grid")}><Icon name="grid" size={15} /></button>
              </div>
              {desktop && epList.length > 0 && (() => {
                const missingEps = selectMissingEpisodes(epList, {
                  canonicalKey,
                  season,
                  audio,
                  items: dl.items,
                  jobs: dl.jobs,
                  airedCount,
                  seriesStatus: d.status,
                });
                const seasonProgTop = computeSeasonDownloadProgress(epList, {
                  canonicalKey,
                  season,
                  audio,
                  items: dl.items,
                  jobs: dl.jobs,
                  airedCount,
                  seriesStatus: d.status,
                });
                const batchForSeason = getBatchForSeason(batch, canonicalKey, season);
                const hasLiveSeasonJobs = seasonProgTop.active > 0 || seasonProgTop.paused > 0 || seasonProgTop.failed > 0;
                if (batchForSeason || seasonProgTop.active > 0) {
                  return (
                    <button
                      type="button"
                      className="btn glass sm ep-season-dl active"
                      onClick={() => void cancelAllDownloads({ canonicalKey, season })}
                      title={`Click to stop & clear all Season ${season} downloads`}
                    >
                      <span className="mini-spin" />
                      <span>
                        {batchForSeason
                          ? `Stop S${season} (${batchForSeason.queued}/${batchForSeason.total})`
                          : `Stop S${season} (${seasonProgTop.completed}/${seasonProgTop.total})`}
                      </span>
                    </button>
                  );
                }
                if (missingEps.length === 0 && !hasLiveSeasonJobs) {
                  return (
                    <span className="ep-season-done" title={`All aired episodes in Season ${season} are saved offline`}>
                      <Icon name="check" size={13} /> S{season} offline
                    </span>
                  );
                }
                if (missingEps.length === 0 && hasLiveSeasonJobs) {
                  return (
                    <button
                      type="button"
                      className="btn glass sm ep-season-dl active"
                      onClick={() => void cancelAllDownloads({ canonicalKey, season })}
                      title={`Stop & clear Season ${season} paused/failed queue`}
                    >
                      <Icon name="x" size={14} />
                      <span>Stop S{season} ({seasonProgTop.paused + seasonProgTop.failed})</span>
                    </button>
                  );
                }
                return (
                  <button
                    type="button"
                    className="btn glass sm ep-season-dl"
                    onClick={() => void queueSeasonDownloads(d, season, epList, audio, airedCount, dl.items, dl.jobs)}
                    title={`Queue ${missingEps.length} episode${missingEps.length === 1 ? "" : "s"} for offline download`}
                  >
                    <Icon name="download" size={14} />
                    <span>
                      {missingEps.length < epList.length
                        ? `Download S${season} (${missingEps.length})`
                        : `Download S${season}`}
                    </span>
                  </button>
                );
              })()}
            </div>
          )}
        </div>

        <div className="tp-section" key={curTab}>
          {curTab === "showcase" && (
            <div className="tp-showcase">
              {(!ready || d.cast.length > 0) && (
                <div className="tp-showcase-block">
                  <div className="tp-subhead">
                    <h3>Principal <em>{anime ? "characters" : "cast"}</em></h3>
                    {d.cast.length > 10 && (
                      <button type="button" className="more" onClick={() => setTab("cast")}>
                        View all {d.cast.length} <Icon name="arrowUR" size={13} />
                      </button>
                    )}
                  </div>
                  <div className="people">
                    {!ready && Array.from({ length: 6 }, (_, i) => <div key={i} className="person"><div className="person-img sk" /></div>)}
                    {d.cast.slice(0, 10).map((c, i) => (
                      <div key={c.name + i} className="person" style={{ ["--i" as string]: Math.min(i, 10) }}>
                        <div className="person-img" style={c.photo ? { backgroundImage: `url(${c.photo})` } : undefined}>{!c.photo && c.name[0]}</div>
                        <div className="person-name">{c.name}</div>
                        {c.character && <div className="person-role">{c.character}</div>}
                        {c.actor && <div className="person-role">CV {c.actor}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(!ready || d.related.length > 0) && (
                <div className="tp-showcase-block">
                  <div className="tp-subhead">
                    <h3>Related <em>cinema</em></h3>
                    {d.related.length > 8 && (
                      <button type="button" className="more" onClick={() => setTab("more")}>
                        View all {d.related.length} <Icon name="arrowUR" size={13} />
                      </button>
                    )}
                  </div>
                  <div className="grid">
                    {!ready && Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)}
                    {d.related.slice(0, 8).map((m, i) => <Card key={m.key} media={m} index={i} />)}
                  </div>
                </div>
              )}

              {ready && d.cast.length === 0 && d.related.length === 0 && (
                <Details d={d} anime={anime} />
              )}
            </div>
          )}

          {curTab === "episodes" && (() => {
            const paged = epList.length > PAGE;
            const pages = Math.max(1, Math.ceil(epList.length / PAGE));
            const safePage = Math.max(0, Math.min(page, pages - 1));
            const shown = paged ? epList.slice(safePage * PAGE, safePage * PAGE + PAGE) : epList;
            const upNext = validProgress?.episode != null ? validProgress.episode : undefined;
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
            const layout = !hasStills ? "compact" : (view ?? (epList.length > 30 ? "grid" : "list")) === "list" ? "list" : "";
            const batchForSeason = desktop ? getBatchForSeason(batch, canonicalKey, season) : undefined;
            const seasonProg = desktop
              ? computeSeasonDownloadProgress(epList, {
                  canonicalKey,
                  season,
                  audio,
                  items: dl.items,
                  jobs: dl.jobs,
                  airedCount,
                  seriesStatus: d.status,
                })
              : null;
            const showSeasonBar =
              Boolean(desktop && seasonProg && seasonProg.total > 0) &&
              ((seasonProg?.completed ?? 0) > 0 ||
                (seasonProg?.active ?? 0) > 0 ||
                (seasonProg?.paused ?? 0) > 0 ||
                (seasonProg?.failed ?? 0) > 0 ||
                Boolean(batchForSeason));

            return (
              <>
                {showSeasonBar && seasonProg && (
                  <div className="ep-season-prog" role="region" aria-label={`Season ${season} download progress`}>
                    <div className="ep-sp-head">
                      <span className="ep-sp-stat">
                        <strong>Season {season} downloads</strong>
                        <small>
                          {seasonProg.completed}/{seasonProg.total} offline
                          {batchForSeason ? ` · queueing E${batchForSeason.currentEp ?? "…"} (${batchForSeason.queued}/${batchForSeason.total})` : ""}
                          {seasonProg.active > 0 ? ` · ${seasonProg.active} downloading` : ""}
                          {seasonProg.paused > 0 ? ` · ${seasonProg.paused} paused` : ""}
                          {seasonProg.failed > 0 ? ` · ${seasonProg.failed} failed` : ""}
                          {fmtSpeed(seasonProg.speedBps) ? ` · ${fmtSpeed(seasonProg.speedBps)}` : ""}
                        </small>
                      </span>
                      <span className="ep-sp-right">
                        {seasonProg.downloadingQualities.map((ql) => (
                          <span key={`dl-${ql}`} className="dlq-badge-q" title={`Currently downloading in ${ql}`}>
                            Downloading {ql}
                          </span>
                        ))}
                        {seasonProg.downloadedQualities.map((ql) => (
                          <span key={`sv-${ql}`} className="dlq-badge-q verified" title={`Saved offline in ${ql}`}>
                            Saved {ql}
                          </span>
                        ))}
                        <b>{Math.round(seasonProg.percent)}%</b>
                        {seasonProg.active > 0 && (
                          <button
                            type="button"
                            className="chip ep-sp-stop"
                            title={`Pause active Season ${season} downloads`}
                            onClick={() => void pauseAllDownloads({ canonicalKey, season })}
                          >
                            <Icon name="pause" size={11} /> Pause S{season}
                          </button>
                        )}
                        {(seasonProg.paused > 0 || seasonProg.failed > 0) && (
                          <button
                            type="button"
                            className="chip ep-sp-stop"
                            title={`Resume or retry Season ${season} downloads`}
                            onClick={() => void resumeAllDownloads({ canonicalKey, season })}
                          >
                            <Icon name="play" size={11} /> Resume S{season}
                          </button>
                        )}
                        {(batchForSeason || seasonProg.active > 0 || seasonProg.paused > 0 || seasonProg.failed > 0) && (
                          <button
                            type="button"
                            className="chip danger ep-sp-stop"
                            title={`Stop & clear all Season ${season} transfers`}
                            onClick={() => void cancelAllDownloads({ canonicalKey, season })}
                          >
                            <Icon name="x" size={11} /> Stop S{season}
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="ep-sp-track" aria-hidden>
                      <div className="ep-sp-active" style={{ transform: `scaleX(${Math.max(0.01, seasonProg.percent / 100)})` }} />
                      <div className="ep-sp-done" style={{ transform: `scaleX(${Math.max(0, seasonProg.completedPercent / 100)})` }} />
                    </div>
                  </div>
                )}
                {(paged || (airedCount ?? epList.length) > 12) && (
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
                        const raw = Number(jump);
                        const maxEp = airedCount ?? epList.length;
                        if (!raw || raw < 1 || maxEp < 1) return;
                        if (raw > maxEp) {
                          toast(`Only ${maxEp} aired episode${maxEp === 1 ? "" : "s"} available so far`, { icon: "info" });
                          return;
                        }
                        const clamped = clampEpisode(activeSeasonObj, raw, epList.length);
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
                    const unaired = isUnairedEpisode(e, { airedCount, seriesStatus: d.status });
                    const still = e.still ?? sized(d.backdrop, "w780");
                    const fallback = e.airDate
                      ? new Date(`${e.airDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                      : audio ? (audio === "dub" ? "English dub" : "Japanese audio · English subtitles") : "";
                    if (unaired) {
                      const airLabel = e.airDate
                        ? `Airs ${new Date(`${e.airDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                        : "TBA";
                      return (
                        <div
                          key={e.number}
                          className="ep-card unaired"
                          aria-disabled="true"
                          style={{ ["--i" as string]: Math.min(i, 8) }}
                          title={e.airDate ? `Episode ${e.number} airs ${fmtDate(e.airDate)}` : `Episode ${e.number} hasn't aired yet`}
                        >
                          <div className="ec-th">
                            {still && <img src={still} alt="" loading="lazy" decoding="async" className="dim" />}
                            <span className="ec-num">{e.number}</span>
                            <span className="ec-ribbon muted">{airLabel}</span>
                            {e.runtime ? <span className="ec-rt">{e.runtime}m</span> : null}
                          </div>
                          <div className="ec-tx">
                            <div className="ec-t">{e.title}</div>
                            <div className="ec-d">{e.overview || fallback}</div>
                          </div>
                        </div>
                      );
                    }
                    const pKey = e.sourceKey ?? d.key;
                    const pEp = e.courEpisode ?? e.number;
                    const p = getProgress(canonicalKey, season, e.number, [d.key, pKey]) ?? getProgress(pKey, undefined, pEp);
                    const isCur = upNext === e.number && (validProgress?.season ?? season) === season;
                    const watched = !!p && p.duration > 0 && p.position / p.duration > 0.92;
                    const left = p && p.duration > 0 && !watched ? Math.max(1, Math.round((p.duration - p.position) / 60)) : null;

                    const epEntry = desktop ? findDownloadedEpisode(canonicalKey, season, e.number, audio, dl.items) : undefined;
                    const epSaved = Boolean(epEntry);
                    const savedQTag = formatQualityTag(epEntry?.quality, epEntry?.qualityVerified);
                    const epJob = desktop
                      ? dl.jobs.find(
                          (j) =>
                            !j.isFilm &&
                            j.status !== "cancelled" &&
                            j.status !== "completed" &&
                            (j.canonicalKey === canonicalKey || j.mediaKey === canonicalKey) &&
                            (j.season == null || j.season === season) &&
                            j.episode === e.number &&
                            (!audio || !j.audio || j.audio === "dual" || j.audio === audio),
                        )
                      : undefined;
                    const epBusy =
                      epJob && (epJob.status === "queued" || epJob.status === "downloading" || epJob.status === "remuxing");
                    const epPaused = epJob?.status === "paused";
                    const epFailed = epJob?.status === "failed";
                    const epResolving = desktop && batch.pendingKeys.has(batchEpisodeKey(canonicalKey, season, e.number, audio));
                    const epQShort = epJob ? formatDownloadQuality(epJob).label.replace(/^Up to /, "") : null;

                    const cardEl = (
                      <button
                        key={desktop ? undefined : e.number}
                        className={`ep-card ${isCur ? "cur" : ""} ${watched ? "seen" : ""}`}
                        style={{ ["--i" as string]: Math.min(i, 8) }}
                        onClick={() => watch(season, e.number)}
                      >
                        <div className="ec-th">
                          {still && <img src={still} alt="" loading="lazy" decoding="async" className={e.still ? "" : "dim"} />}
                          <span className="ec-num">{e.number}</span>
                          {epSaved && (
                            <span
                              className={`ec-offline ${savedQTag ? "has-q" : ""}`}
                              title={savedQTag ? `Saved offline (${savedQTag}${epEntry?.videoCodec ? ` · ${epEntry.videoCodec}` : ""})` : "Saved offline"}
                            >
                              <Icon name="download" size={10} />
                              {savedQTag && <span>{savedQTag}</span>}
                            </span>
                          )}
                          {isCur && <span className="ec-ribbon">{p && p.position > 30 ? "Resume" : "Up next"}</span>}
                          {watched && <span className="ec-seen" aria-label="Watched"><Icon name="check" size={12} /></span>}
                          {e.runtime ? <span className="ec-rt">{e.runtime}m</span> : null}
                          <span className="ec-play"><Icon name="play" size={18} /></span>
                          {p && p.duration > 0 && !watched && <div className="ec-bar"><i style={{ transform: `scaleX(${Math.min(1, p.position / p.duration)})` }} /></div>}
                          {(epBusy || epPaused) && epJob && (
                            <div className="ec-dl-bar" aria-hidden>
                              <i style={{ transform: `scaleX(${Math.max(0.03, (epJob.percent || 0) / 100)})` }} />
                            </div>
                          )}
                        </div>
                        <div className="ec-tx">
                          <div className="ec-t">{e.title}</div>
                          <div className="ec-d">{layout === "list" ? [left != null ? `${left}m left` : null, e.overview || fallback].filter(Boolean).join(" · ") : left != null ? `${left}m left` : e.overview || fallback}</div>
                        </div>
                      </button>
                    );

                    if (!desktop) return cardEl;

                    const epDlLabel = epBusy
                      ? epJob.status === "remuxing"
                        ? `Saving E${e.number}${epQShort ? ` · ${epQShort}` : ""} (${epJob.providerName})…`
                        : `Pause E${e.number} · Downloading ${epQShort ? `${epQShort} · ` : ""}${Math.round(epJob.percent)}% (${epJob.providerName})`
                      : epPaused
                        ? `Resume E${e.number}${epQShort ? ` · ${epQShort}` : ""} (${epJob.providerName})`
                        : epFailed
                          ? `Retry / Switch server for E${e.number}${epJob?.error ? ` (${epJob.error})` : ""}`
                          : epResolving
                            ? `Finding stream for E${e.number}…`
                            : epSaved
                              ? `E${e.number} saved offline${savedQTag ? ` (${savedQTag})` : ""}`
                              : `Download E${e.number}`;

                    return (
                      <div key={e.number} className="ep-slot">
                        {cardEl}
                        <button
                          type="button"
                          className={`ep-dl ${epBusy || epResolving ? "busy" : ""} ${epPaused ? "paused" : ""} ${epFailed ? "failed" : ""} ${epSaved ? "saved" : ""}`}
                          title={epDlLabel}
                          aria-label={epDlLabel}
                          disabled={epJob?.status === "remuxing" || epResolving || (epSaved && !epBusy && !epPaused)}
                          onClick={() => {
                            if (epBusy && epJob) {
                              void pauseDownload(epJob.id);
                            } else if (epFailed && epJob) {
                              void switchDownloadToNextServer(epJob);
                            } else if (epPaused && epJob) {
                              void resumeDownload(epJob.id);
                            } else if (!epSaved && !epResolving) {
                              void queueEpisodeDownload(d, season, e, audio);
                            }
                          }}
                        >
                          {epResolving ? (
                            <span className="mini-spin" />
                          ) : epBusy ? (
                            <span>
                              {epJob.status === "remuxing"
                                ? `${epQShort ?? ""}…`
                                : `${epQShort ? `${epQShort} · ` : ""}${Math.round(epJob.percent)}%`}
                            </span>
                          ) : epPaused ? (
                            <Icon name="play" size={12} />
                          ) : epFailed ? (
                            <Icon name="refresh" size={12} />
                          ) : epSaved ? (
                            <Icon name="check" size={13} />
                          ) : (
                            <Icon name="download" size={13} />
                          )}
                        </button>
                      </div>
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
      {trailerOpen && isYouTubeId(d.trailerYouTubeId) && (
        <TrailerModal id={d.trailerYouTubeId} title={d.title} onClose={() => setTrailerOpen(false)} />
      )}
    </div>
  );
}

/** Technical colophon fact sheet. Rows with no data are left out. */
function Details({ d, anime }: { d: MediaDetail; anime: boolean }) {
  const people = (jobs: RegExp) => [...new Set(d.crew.filter((c) => jobs.test(c.job)).map((c) => c.name))].join(", ");
  const ep = (e?: MediaDetail["lastEpisode"]) => (e ? `S${e.season} · E${e.episode}${e.name ? ` · ${e.name}` : ""}${e.airDate ? ` (${fmtDate(e.airDate)})` : ""}` : "");
  const multiple = d.budget && d.revenue ? d.revenue / d.budget : 0;
  const ended = !!d.status && !/return|airing|production|releasing|planned/i.test(d.status);
  const rows: [string, string | undefined | null][] = [
    [isFilm(d) ? (isUnreleasedMedia(d) ? "Releases" : "Released") : "First aired", fmtDate(d.releaseDate)],
    ["In cinemas", isFilm(d) && d.theatricalReleaseDate && d.theatricalReleaseDate !== d.releaseDate?.slice(0, 10) ? fmtDate(d.theatricalReleaseDate) : ""],
    [isFilm(d) && isFutureIsoDate(d.digitalReleaseDate) ? "Digital release" : "On digital", isFilm(d) ? fmtDate(d.digitalReleaseDate) : ""],
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
