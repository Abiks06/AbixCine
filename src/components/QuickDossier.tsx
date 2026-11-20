import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  clampEpisode,
  clampSeason,
  decodeKey,
  encodeKey,
  getDetail,
  isTheatricalOnly,
  isUnreleasedMedia,
  resolvePlaybackRequest,
} from "../lib/catalog";
import { closeDossier, useDossier } from "../lib/dossier";
import { fmtDate, fmtRuntime } from "../lib/format";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import { audioFor, setAudioFor, useSettings } from "../lib/settings";
import { burst } from "../lib/burst";
import { isYouTubeId } from "../lib/trailer";
import { isFilm, type Media, type MediaDetail } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { toggleList, useSaved } from "../lib/watchlist";
import { Art } from "./Art";
import { AudioToggle } from "./AudioToggle";
import { kindLabel, seedState } from "./Card";
import { Icon } from "./Icon";
import { TitleArt } from "./TitleArt";
import { TrailerModal } from "./TrailerModal";

const LazySmartSource = lazy(() => import("./SmartSource").then((m) => ({ default: m.SmartSource })));

const CLOSE_MS = 180;

/**
 * Slide-over Screening Pass drawer: inspect full credits, runtime end-time, synopsis,
 * trailer, and live stream readiness without bouncing off the current page.
 */
export function QuickDossier() {
  const media = useDossier();
  const [rendered, setRendered] = useState<Media | null>(media);
  const [closing, setClosing] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (media) {
      if (!rendered) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setRendered(media);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const t = window.setTimeout(() => {
      setRendered(null);
      setClosing(false);
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    }, CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [media]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rendered) return null;
  return <DrawerBody key={rendered.key} media={rendered} closing={closing} />;
}

function DrawerBody({ media, closing }: { media: Media; closing: boolean }) {
  const nav = useNavigate();
  useSettings();
  const key = decodeKey(media.key);
  const { data: detail } = useAsync(() => getDetail(key), [key]);
  const d: MediaDetail = useMemo(
    () => detail ?? { ...media, cast: [], crew: [], related: [] },
    [detail, media],
  );
  const [trailerOpen, setTrailerOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [key]);

  useEffect(() => {
    previewLight(media);
    return () => previewLight(null);
  }, [media]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".palette-scrim, .trailer-scrim")) return;
      e.preventDefault();
      e.stopPropagation();
      closeDossier();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const film = isFilm(d);
  const anime = key.startsWith("anilist:") || d.kind === "anime";
  const canonicalKey = d.canonicalKey ?? d.key ?? key;
  const audio = anime ? audioFor(canonicalKey, [key, d.key]) : undefined;
  const saved = useSaved(key, d.canonicalKey, d.key);
  const unreleased = detail ? isUnreleasedMedia(d) : false;
  const theatrical = detail ? !unreleased && film && isTheatricalOnly(d) : false;

  const activeSeason = useMemo(() => (film ? undefined : clampSeason(d, d.initialSeason)), [d, film]);
  const startS = activeSeason?.number;
  const startE = useMemo(
    () => (film ? undefined : clampEpisode(activeSeason, 1, d.episodeCount)),
    [film, activeSeason, d.episodeCount],
  );

  const hasPlayable = film ? !unreleased : !!((d.seasons && d.seasons.length > 0) || (d.specials && d.specials.length > 0) || (d.episodeCount && d.episodeCount > 0));
  const req = useMemo(
    () => (detail && hasPlayable && !theatrical ? resolvePlaybackRequest(detail, startS, startE, audio) : null),
    [detail, hasPlayable, theatrical, startS, startE, audio],
  );

  const endsAt = useMemo(() => {
    if (!d.runtime) return null;
    return new Date(Date.now() + d.runtime * 60_000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }, [d.runtime]);

  const director = d.crew.find((c) => /^(Chief )?Director$/i.test(c.job))?.name;
  const creator = d.crew.find((c) => /^Creator$/i.test(c.job))?.name;
  const leadStudio = d.companies?.[0] ?? d.networks?.[0];
  const mainSeasons = d.seasons?.length ?? 0;
  const lengthLabel = film
    ? fmtRuntime(d.runtime)
    : mainSeasons > 1
      ? `${mainSeasons} seasons`
      : mainSeasons === 1 && d.seasons?.[0]
        ? `${d.seasons[0].episodeCount} ep`
        : d.episodeCount
          ? `${d.episodeCount} ep`
          : "";

  const openMonograph = () => {
    closeDossier();
    nav(`/title/${encodeKey(d.key)}`, { viewTransition: true, state: seedState(d) });
  };

  const watchNow = (srv?: string) => {
    closeDossier();
    if (srv && req) {
      const qs = new URLSearchParams({
        ...(req.season != null ? { s: String(req.season) } : {}),
        ...(req.episode != null ? { e: String(req.episode) } : {}),
        ...(audio ? { a: audio } : {}),
        srv,
      });
      nav(`/watch/${encodeKey(req.media.key)}?${qs}`, { viewTransition: true, state: { from: "app" } });
      return;
    }
    nav(playHref(d), { viewTransition: true, state: { from: "app" } });
  };

  return (
    <>
      <div className={`qd-scrim ${closing ? "closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && closeDossier()}>
        <aside className="qd-drawer" role="dialog" aria-modal="true" aria-label={`${d.title} screening pass`}>
          <div className="qd-head">
            <div className="qd-pass-id">
              <b>SCREENING PASS</b>
              {endsAt && <span>START NOW → ENDS {endsAt}</span>}
            </div>
            <button ref={closeRef} type="button" className="icon-btn" onClick={closeDossier} aria-label="Close quick dossier">
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="qd-scroll">
            <div className="qd-frame gate-frame">
              <Art media={d} variant="backdrop" hd eager />
              <span className="gate-brackets" aria-hidden><i /></span>
            </div>

            <div className="qd-body">
              <div className="kicker">
                <b>{kindLabel(d.kind, d.format)}</b>
                {d.genres.length > 0 && <><i /><span>{d.genres.slice(0, 3).join(" · ")}</span></>}
              </div>

              <TitleArt media={d} size="md" />
              {d.tagline && <div className="qd-tagline">{d.tagline}</div>}

              <div className="specs">
                {d.rating ? <span className="star">★ {d.rating.toFixed(1)}</span> : null}
                {d.year ? <span>{d.year}</span> : null}
                {d.certification && <span className="cert">{d.certification}</span>}
                {lengthLabel && <span>{lengthLabel}</span>}
                {!film && d.runtime ? <span>{d.runtime}m/ep</span> : null}
              </div>

              {(director || creator || leadStudio) && (
                <div className="qd-credits">
                  {director && <span><b>Director</b> {director}</span>}
                  {!director && creator && <span><b>Creator</b> {creator}</span>}
                  {leadStudio && <span><b>{anime ? "Studio" : "Production"}</b> {leadStudio}</span>}
                </div>
              )}

              {d.overview && <p className="qd-overview">{d.overview}</p>}

              {unreleased && (
                <div className="airing"><Icon name="clock" size={14} /> {d.releaseDate ? `Releases ${fmtDate(d.releaseDate)}` : "Not released yet"}</div>
              )}
              {theatrical && (
                <div className="airing"><Icon name="clock" size={14} /> In cinemas now</div>
              )}

              <div className="qd-acts">
                {!unreleased && (
                  <button type="button" className="btn play sm" onClick={() => watchNow()}>
                    <Icon name="play" size={14} /> Play now
                  </button>
                )}
                <button type="button" className="btn glass sm" onClick={openMonograph}>
                  Full dossier <Icon name="arrowR" size={14} />
                </button>
                {isYouTubeId(d.trailerYouTubeId) && (
                  <button type="button" className="btn glass sm icon" onClick={() => setTrailerOpen(true)} title="Watch trailer" aria-label="Watch trailer">
                    <Icon name="film" size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className={`btn glass sm icon ${saved ? "on" : ""}`}
                  onClick={(e) => { if (!saved) burst(e.currentTarget); toggleList(d); }}
                  aria-pressed={saved}
                  aria-label={saved ? "Remove from My List" : "Add to My List"}
                  title={saved ? "In My List" : "Add to My List"}
                >
                  <Icon name={saved ? "check" : "plus"} size={16} />
                </button>
              </div>

              {audio && (
                <div className="qd-audio">
                  <span>Audio</span>
                  <AudioToggle value={audio} compact onChange={(a) => setAudioFor(canonicalKey, a, [key, d.key])} />
                </div>
              )}

              {req && (
                <div className="qd-sources">
                  <Suspense fallback={<aside className="smart" aria-busy><div className="smart-note">Checking servers…</div></aside>}>
                    <LazySmartSource req={req} what={film ? "this film" : `S${startS ?? 1} E${startE ?? 1}`} onPlay={watchNow} />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
      {trailerOpen && isYouTubeId(d.trailerYouTubeId) && (
        <TrailerModal id={d.trailerYouTubeId} title={d.title} onClose={() => setTrailerOpen(false)} />
      )}
    </>
  );
}
