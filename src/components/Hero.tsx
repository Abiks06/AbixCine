import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { fmtRuntime } from "../lib/format";
import { useFeatured, type Featured } from "../lib/useLogos";
import { toggleList, useSaved } from "../lib/watchlist";
import { playHref } from "../lib/play";
import { setStageLight } from "../lib/light";
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
 * The living stage: a rotating spotlight with the title's own art, a ruled line of facts, the
 * actions, a timeline of slides, and the whole programme listed down the right-hand side.
 */
export function Hero({ items, label, onActive, loading = true }: { items: Media[]; label: string; onActive?: (m: Media) => void; loading?: boolean }) {
  const picks = useFeatured(items.filter((m) => m.backdrop || m.hue != null).slice(0, 6));
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [trailer, setTrailer] = useState<{ id: string; title: string } | null>(null);
  const n = picks.length;
  const cur = n ? i % n : 0;
  const m = picks[cur];

  // The slide that just left, kept long enough for its copy to dissolve (see HeroCopy `out`).
  const [leaving, setLeaving] = useState<{ m: Featured; n: number } | null>(null);
  const shownRef = useRef<{ m: Featured; n: number } | null>(null);
  useEffect(() => {
    if (!m) return;
    const prev = shownRef.current;
    shownRef.current = { m, n: cur + 1 };
    if (!prev || prev.m.key === m.key) return;
    setLeaving(prev);
    // Normally the exit's animationend clears it; this is the backstop if it never runs.
    const t = setTimeout(() => setLeaving((l) => (l?.m.key === prev.m.key ? null : l)), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key]);

  // Don't rotate while the window is in the background or the hero is scrolled away.
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
  const hold = paused || away || !!trailer;

  // The slide advances when its timeline tick finishes (onAnimationEnd below), so pausing on hover,
  // focus or visibility keeps tick and slide in step. Reduced motion: no autoplay at all (WCAG 2.2.2).
  const still = useSettings().reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const advance = () => n > 1 && setI((x) => (x + 1) % n);

  // Only slides that have been on screen carry an image: the current one and both neighbours
  // (so crossfades and either-direction nav still work), kept mounted once shown so a repeat
  // loop never re-downloads or re-fades a picture.
  const mounted = useRef(new Set<string>());
  for (const p of [picks[cur], picks[(cur + 1) % Math.max(1, n)], picks[(cur - 1 + n) % Math.max(1, n)]]) if (p) mounted.current.add(p.key);

  useEffect(() => {
    if (!m) return;
    setStageLight(m);
    onActive?.(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key, m?.backdrop]);

  // Nothing to feature once the feeds have settled (offline, no catalog): no stage at all, rather
  // than a placeholder that shimmers forever. The shelves below then start under the top bar.
  if (!m) return loading ? <section className="hero hero-skeleton" ref={root} aria-busy aria-label={`Featured ${label}`} /> : null;
  const next = n > 1 ? picks[(cur + 1) % n] : undefined;

  return (
    <>
    <section
      className={`hero ${away ? "away" : ""}`}
      ref={root}
      aria-roledescription="carousel"
      aria-label={`Featured ${label}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setPaused(false)}
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowRight") setI((cur + 1) % n);
        else if (e.key === "ArrowLeft") setI((cur - 1 + n) % n);
      }}
    >
      <div className="hero-stage" style={{ viewTransitionName: "hero" }}>
        {picks.map((p, j) => (
          <div key={p.key} className={`hero-bg ${j === cur ? "on" : ""}`}>
            {mounted.current.has(p.key) && <Art media={p} variant="backdrop" hd priority={j === cur} />}
          </div>
        ))}
      </div>
      <div className="hero-scrim" />

      <div className="hero-body pad">
        {/* The outgoing slide's copy stays a beat to dissolve upward while the new one rises
            into the same cell, so the words never cut while the art is still crossfading. */}
        <div className="hero-copy-stack">
          {leaving && leaving.m.key !== m.key && (
            <HeroCopy key={`out-${leaving.m.key}`} m={leaving.m} n={leaving.n} label={label} out onGone={() => setLeaving(null)} />
          )}
          <HeroCopy key={m.key} m={m} n={cur + 1} label={label} onTrailer={setTrailer} />
        </div>

        {n > 1 && (
          <div className="hero-queue">
            <h6><span>{label === "Tonight" ? "Tonight's programme" : `Programme · ${label}`}</span><span>{pad2(cur + 1)}/{pad2(n)}</span></h6>
            {picks.map((p, j) => (
              <button key={p.key} className={`hq ${j === cur ? "on" : ""}`} onClick={() => setI(j)} aria-label={`Show ${p.title}`} aria-current={j === cur}>
                <span className="hq-n">{pad2(j + 1)}</span>
                <Art media={p} variant="backdrop" size="sm" />
                <span>
                  <span className="hq-t">{p.title}</span>
                  <span className="hq-m">{[kindLabel(p.kind), p.year, p.genres[0]].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {n > 1 && (
        <div className="hero-ticks pad">
          {picks.map((p, j) => (
            <button key={p.key} className={j === cur ? "on" : j < cur ? "done" : ""} onClick={() => setI(j)} aria-label={`Show ${p.title}`} tabIndex={-1}>
              {j === cur && !still && (
                <i key={cur} onAnimationEnd={advance} style={{ animationPlayState: hold ? "paused" : "running", animationDuration: `${SLIDE_MS}ms` }} />
              )}
            </button>
          ))}
          <span className="hero-count"><b>{pad2(cur + 1)}</b> / {pad2(n)}</span>
          {/* Where the programme doesn't fit (laptop widths, short windows), one line says what's next. */}
          {next && (
            <button type="button" className="hero-next" onClick={advance} aria-label={`Next: ${next.title}`}>
              <span>Next</span>
              <b key={next.key}>{next.title}</b>
              <Icon name="arrowR" size={14} />
            </button>
          )}
        </div>
      )}
    </section>
    {trailer && <TrailerModal id={trailer.id} title={trailer.title} onClose={() => setTrailer(null)} />}
    </>
  );
}

/**
 * One slide's words and actions. The outgoing copy (`out`) is a picture of itself: hidden from
 * assistive tech and pointer, it plays its exit and then asks to be removed.
 */
function HeroCopy({ m, n, label, out, onGone, onTrailer }: { m: Featured; n: number; label: string; out?: boolean; onGone?: () => void; onTrailer?: (t: { id: string; title: string }) => void }) {
  const nav = useNavigate();
  const saved = useSaved(m.key);
  const len = length(m);
  const unreleased = isUnreleasedMedia(m);
  return (
    <div
      className={`hero-copy ${out ? "out" : ""}`}
      {...(out ? { "aria-hidden": true, inert: "" } : {})}
      onAnimationEnd={out ? (e) => e.target === e.currentTarget && onGone?.() : undefined}
    >
      <div className="kicker">
        <b>N°{pad2(n)}</b>
        <i />
        <em>{label}</em>
      </div>
      <TitleArt media={m} />
      <div className="specs">
        {m.rating ? <span className="star">★ {m.rating.toFixed(1)}</span> : null}
        <span>{kindLabel(m.kind)}</span>
        {m.year ? <span>{m.year}</span> : null}
        {len && <span>{len}</span>}
        {m.genres.length > 0 && <span>{m.genres.slice(0, 3).join(" · ")}</span>}
        {m.kind === "anime" && <span className="hi">Sub · Dub</span>}
      </div>
      <p className="desc">{m.overview}</p>
      <div className="acts">
        {!unreleased && (
          <button className="btn play" onClick={() => nav(playHref(m), { viewTransition: true, state: { from: "app" } })}>
            <Icon name="play" size={16} /> Play
          </button>
        )}
        <Link
          className={`btn ${unreleased ? "play" : "glass"}`}
          to={`/title/${encodeKey(m.key)}`}
          // `morph` tells the title page to name its own title art, so the two morph into each other.
          state={{ ...seedState(m), morph: "title" }}
          viewTransition
          // Tagged on click, not on render: only this navigation morphs the title. A card click on
          // the same page must not fly the hero's title into some other film's page. The hero
          // unmounts with the page, so the name never outlives the transition.
          onClick={(e) => {
            const art = e.currentTarget.closest(".hero-copy")?.querySelector<HTMLElement>(".title-logo, .title-type");
            if (art) art.style.viewTransitionName = "hero-title";
          }}
        >
          <Icon name="info" size={18} /> Details
        </Link>
        {isYouTubeId(m.trailerYouTubeId) && (
          <button type="button" className="btn glass icon" onClick={() => onTrailer?.({ id: m.trailerYouTubeId!, title: m.title })} aria-label={`Watch the ${m.title} trailer`} aria-haspopup="dialog" title="Trailer">
            <Icon name="film" size={18} />
          </button>
        )}
        <button className={`btn glass icon ${saved ? "on" : ""}`} onClick={(e) => { if (!saved) burst(e.currentTarget); toggleList(m); }} aria-label={saved ? "Remove from My List" : "Add to My List"} aria-pressed={saved} title={saved ? "In My List" : "Add to My List"}>
          <Icon name={saved ? "check" : "plus"} size={20} />
        </button>
      </div>
    </div>
  );
}
