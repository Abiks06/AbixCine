import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getTrackingState, useAiringFor, useNowMinute } from "../lib/airing";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { fmtEpCode, fmtRuntime } from "../lib/format";
import { useFeatured, type Featured } from "../lib/useLogos";
import { toggleList, useSaved } from "../lib/watchlist";
import { playHref, watchHref } from "../lib/play";
import { setStageLight } from "../lib/light";
import { useMatchedProgress, RESUME_MIN_SEC } from "../lib/progress";
import { burst } from "../lib/burst";
import { useSettings } from "../lib/settings";
import type { Media } from "../lib/types";
import { isFilm } from "../lib/types";
import { Art } from "./Art";
import { kindLabel, seedState } from "./Card";
import { Icon } from "./Icon";
import { TitleArt } from "./TitleArt";
import { TrailerModal } from "./TrailerModal";
import { isYouTubeId } from "../lib/trailer";

const SLIDE_MS = 9000;
const pad2 = (n: number) => String(n).padStart(2, "0");

const length = (m: Featured) =>
  isFilm(m)
    ? fmtRuntime(m.runtime)
    : m.seasons?.length
      ? `${m.seasons.length} season${m.seasons.length > 1 ? "s" : ""}`
      : m.episodeCount
        ? `${m.episodeCount} episode${m.episodeCount === 1 ? "" : "s"}`
        : "";

/**
 * Asymmetric Split-Frame Hero:
 *   Left (~40%): Matte editorial plinth bounded by a 1px vertical rule — issue kicker,
 *     TitleArt, hairline spec ledger, synopsis, sharp CTA blocks, and numbered Filmstrip switcher.
 *   Right (~60%): Unobstructed, un-scrimmed widescreen cinema viewport framed by optical brackets.
 */
export function Hero({ items, label, onActive, loading = true }: { items: Media[]; label: string; onActive?: (m: Media) => void; loading?: boolean }) {
  const picks = useFeatured(items.filter((m) => m.backdrop || m.poster || m.hue != null).slice(0, 6));
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [trailer, setTrailer] = useState<{ id: string; title: string } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const n = picks.length;
  const cur = n ? i % n : 0;
  const m = picks[cur];

  useEffect(() => {
    setI(0);
  }, [label]);

  const [leaving, setLeaving] = useState<{ m: Featured; n: number } | null>(null);
  const shownRef = useRef<{ m: Featured; n: number } | null>(null);
  useEffect(() => {
    if (!m) return;
    const prev = shownRef.current;
    shownRef.current = { m, n: cur + 1 };
    if (!prev || prev.m.key === m.key) return;
    setLeaving(prev);
    const t = setTimeout(() => setLeaving((l) => (l?.m.key === prev.m.key ? null : l)), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key]);

  const root = useRef<HTMLElement>(null);
  const [away, setAway] = useState(false);
  const ready = n > 0;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let seen = true;
    const sync = () => setAway(document.hidden || !seen);
    const io = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      sync();
    }, { threshold: 0.25 });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [ready]);
  const hold = paused || userPaused || away || !!trailer;

  const still = useSettings().reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const advance = () => n > 1 && setI((x) => (x + 1) % n);

  const mounted = useRef(new Set<string>());
  for (const p of [picks[cur], picks[(cur + 1) % Math.max(1, n)], picks[(cur - 1 + n) % Math.max(1, n)]]) {
    if (p) mounted.current.add(p.key);
  }

  useEffect(() => {
    if (!m) return;
    registerMedia(m);
    setStageLight(m);
    onActive?.(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key, m?.backdrop]);

  if (!m) return loading ? <section className="hero hero-skeleton" ref={root} aria-busy aria-label={`Featured ${label}`} /> : null;
  const next = n > 1 ? picks[(cur + 1) % n] : undefined;

  return (
    <>
      <section
        className={`hero ${away ? "away" : ""}`}
        ref={root}
        data-media-key={m.key}
        aria-roledescription="carousel"
        aria-label={`Featured ${label}`}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setPaused(false)}
        onKeyDown={(e) => {
          if (n < 2) return;
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            const nextIdx = e.key === "ArrowRight" ? (cur + 1) % n : (cur - 1 + n) % n;
            setI(nextIdx);
            const activeInCopy = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest(".hero-copy"));
            if (activeInCopy) {
              requestAnimationFrame(() => stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIdx]?.focus({ preventScroll: true }));
            }
          }
        }}
      >
        <div className="hero-plinth">
          <div className="hero-copy-stack">
            {leaving && leaving.m.key !== m.key && (
              <HeroCopy key={`out-${leaving.m.key}`} m={leaving.m} n={leaving.n} total={n} label={label} out onGone={() => setLeaving(null)} />
            )}
            <HeroCopy key={m.key} m={m} n={cur + 1} total={n} label={label} onTrailer={setTrailer} />
          </div>

          {n > 1 && (
            <div className="hero-strip-row">
              <div className="hero-strip" role="tablist" aria-label="Programme slides" ref={stripRef}>
                {picks.map((p, j) => (
                  <button
                    key={p.key}
                    role="tab"
                    aria-selected={j === cur}
                    className={`hs-btn ${j === cur ? "on" : j < cur ? "done" : ""}`}
                    onClick={() => setI(j)}
                    title={`${pad2(j + 1)} · ${p.title}`}
                    aria-label={`Show ${p.title}`}
                  >
                    <span className="hs-thumb" aria-hidden><Art media={p} variant="backdrop" size="xs" eager /></span>
                    <span className="hs-num">{pad2(j + 1)}</span>
                    <span className="hs-title">{p.title}</span>
                    {j === cur && !still && (
                      <i
                        key={cur}
                        className="hs-bar"
                        onAnimationEnd={advance}
                        style={{ animationPlayState: hold ? "paused" : "running", animationDuration: `${SLIDE_MS}ms` }}
                      />
                    )}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`hero-pause ${userPaused ? "on" : ""}`}
                onClick={() => setUserPaused((v) => !v)}
                aria-label={userPaused ? "Resume slide rotation" : "Pause slide rotation"}
                aria-pressed={userPaused}
                title={userPaused ? "Resume slide rotation" : "Pause slide rotation"}
              >
                <Icon name={userPaused ? "play" : "pause"} size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="hero-viewport">
          <div className="hero-stage" style={{ viewTransitionName: "hero" }}>
            {picks.map((p, j) => (
              <div key={p.key} className={`hero-bg ${j === cur ? "on" : ""}`}>
                {mounted.current.has(p.key) && <Art media={p} variant="backdrop" hd eager priority={j === cur} />}
              </div>
            ))}
          </div>
          <span className="gate-brackets" aria-hidden><i /></span>
          <div className="hero-edge-fade" aria-hidden />

          {next && (
            <button type="button" className="hero-next" onClick={advance} aria-label={`Next: ${next.title}`}>
              <span>NEXT · {pad2(((cur + 1) % n) + 1)}</span>
              <b key={next.key}>{next.title}</b>
              <Icon name="arrowR" size={14} />
            </button>
          )}
        </div>
      </section>
      {trailer && <TrailerModal id={trailer.id} title={trailer.title} onClose={() => setTrailer(null)} />}
    </>
  );
}

function HeroCopy({
  m,
  n,
  total,
  label,
  out,
  onGone,
  onTrailer,
}: {
  m: Featured;
  n: number;
  total: number;
  label: string;
  out?: boolean;
  onGone?: () => void;
  onTrailer?: (t: { id: string; title: string }) => void;
}) {
  const nav = useNavigate();
  const saved = useSaved(m.key);
  const prog = useMatchedProgress([m.key]);
  const airSnap = useAiringFor(m.key);
  const nowMs = useNowMinute();
  const tracking = getTrackingState(m, prog, airSnap, nowMs);
  const len = length(m);
  const unreleased = isUnreleasedMedia(m);
  const canResume = Boolean(prog && !prog.caughtUp && (prog.position > RESUME_MIN_SEC || prog.upNext));
  const playTarget =
    tracking.kind === "new-episode" && tracking.nextPlay
      ? watchHref(m.key, tracking.nextPlay.season ?? prog?.season, tracking.nextPlay.episode, prog?.audio)
      : canResume && prog
        ? watchHref(m.key, prog.season, prog.episode, prog.audio)
        : playHref(m);
  const playTxt =
    tracking.kind === "new-episode" && tracking.nextPlay
      ? `Play ${fmtEpCode(tracking.nextPlay.season ?? prog?.season, tracking.nextPlay.episode)}`
      : canResume && prog
        ? isFilm(m)
          ? "Resume"
          : `Resume ${fmtEpCode(prog.season, prog.episode)}`
        : "Play";
  return (
    <div
      className={`hero-copy ${out ? "out" : ""}`}
      {...(out ? { "aria-hidden": true, inert: "" } : {})}
      onAnimationEnd={out ? (e) => e.target === e.currentTarget && onGone?.() : undefined}
    >
      <div className="kicker">
        <b>№ {pad2(n)}/{pad2(total)}</b>
        <i />
        <em>{label}</em>
        {tracking.badge && <><i /><span className={`hero-air-tag ${tracking.kind}`}>{tracking.badge}</span></>}
      </div>
      <TitleArt media={m} />
      <div className="specs">
        {m.rating ? <span className="star">★ {m.rating.toFixed(1)}</span> : null}
        <span>{kindLabel(m.kind, m.format)}</span>
        {m.year ? <span>{m.year}</span> : null}
        {len && <span>{len}</span>}
        {m.genres.length > 0 && <span>{m.genres.slice(0, 2).join(" · ")}</span>}
        {m.kind === "anime" && <span className="hi">Sub · Dub</span>}
      </div>
      <p className="desc">{m.overview}</p>
      <div className="acts">
        {!unreleased && (
          <button className="btn play" onClick={() => nav(playTarget, { viewTransition: true, state: { from: "app" } })}>
            <Icon name="play" size={15} /> {playTxt}
          </button>
        )}
        <Link
          className={`btn ${unreleased ? "play" : "glass"}`}
          to={`/title/${encodeKey(m.key)}`}
          state={{ ...seedState(m), morph: "title" }}
          viewTransition
          onClick={(e) => {
            const art = e.currentTarget.closest(".hero-copy")?.querySelector<HTMLElement>(".title-logo, .title-type");
            if (art) art.style.viewTransitionName = "hero-title";
          }}
        >
          Details <Icon name="arrowUR" size={14} />
        </Link>
        <button
          type="button"
          className="btn glass icon"
          onClick={() => openDossier(m)}
          aria-label={`Quick view for ${m.title}`}
          title="Quick view (I)"
        >
          <Icon name="layers" size={16} />
        </button>
        {isYouTubeId(m.trailerYouTubeId) && (
          <button
            type="button"
            className="btn glass icon"
            onClick={() => onTrailer?.({ id: m.trailerYouTubeId!, title: m.title })}
            aria-label={`Watch the ${m.title} trailer`}
            aria-haspopup="dialog"
            title="Trailer"
          >
            <Icon name="film" size={16} />
          </button>
        )}
        <button
          className={`btn glass icon ${saved ? "on" : ""}`}
          onClick={(e) => {
            if (!saved) burst(e.currentTarget);
            toggleList(m);
          }}
          aria-label={saved ? "Remove from My List" : "Add to My List"}
          aria-pressed={saved}
          title={saved ? "In My List" : "Add to My List"}
        >
          <Icon name={saved ? "check" : "plus"} size={17} />
        </button>
      </div>
    </div>
  );
}
