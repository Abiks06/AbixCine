import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { burst } from "../lib/burst";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { openDossier } from "../lib/dossier";
import { useOfflineCountForMedia } from "../lib/downloads";
import { fmtRuntime, languageName } from "../lib/format";
import {
  cancelHoverPreview,
  closeHoverPreviewNow,
  computePreviewPosition,
  keepHoverPreviewOpen,
  useHoverPreview,
} from "../lib/hoverPreview";
import { previewLight } from "../lib/light";
import { playHref } from "../lib/play";
import { isFilm, type Media, type MediaDetail } from "../lib/types";
import { toggleList, useSaved } from "../lib/watchlist";
import { Art } from "./Art";
import { kindLabel, seedState } from "./Card";
import { Icon } from "./Icon";

function fmtFinishClock(runtimeMin: number): string {
  const finish = new Date(Date.now() + runtimeMin * 60_000);
  return finish.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtNextAir(next?: Media["nextAiring"]): string | null {
  if (!next) return null;
  const diff = next.at - Date.now();
  if (diff <= 0) return `Ep ${next.episode} out now`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `Ep ${next.episode} in ${Math.max(1, hours)}h`;
  const day = new Date(next.at).toLocaleDateString(undefined, { weekday: "short" });
  const tm = new Date(next.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `Ep ${next.episode} · ${day} ${tm}`;
}

function PreviewCard({
  media,
  detail,
  to,
  onRemove,
  removeLabel,
  anchor,
  vpWidth,
  vpHeight,
}: {
  media: Media;
  detail?: MediaDetail;
  to?: string;
  onRemove?: () => void;
  removeLabel?: string;
  anchor: { left: number; top: number; width: number; height: number };
  vpWidth: number;
  vpHeight: number;
}) {
  const nav = useNavigate();
  const saved = useSaved(media.key, detail?.canonicalKey, detail?.key);
  const desktop = isTauri();
  const d: MediaDetail = detail ?? { ...media, cast: [], crew: [], related: [] };
  const canonicalKey = d.canonicalKey ?? d.key;
  const rawOfflineCount = useOfflineCountForMedia(canonicalKey, d.key);
  const offlineCount = desktop ? rawOfflineCount : 0;

  const film = isFilm(d);
  const anime = d.kind === "anime" || d.key.startsWith("anilist:");
  const unreleased = isUnreleasedMedia(d);

  const seasonsCount = d.seasons?.length ?? 0;
  const epTotal =
    d.totalEpisodes ??
    d.episodeCount ??
    (d.seasons?.length ? d.seasons.reduce((sum, s) => sum + (s.episodeCount || 0), 0) : undefined);

  const lengthSpec = film
    ? fmtRuntime(d.runtime)
    : seasonsCount > 1
      ? `${seasonsCount} seasons${epTotal ? ` · ${epTotal} ep` : ""}`
      : epTotal
        ? `${epTotal} episode${epTotal === 1 ? "" : "s"}`
        : null;
  const epRuntimeSpec = !film && d.runtime ? `${d.runtime}m/ep` : null;
  const endsAt = film && d.runtime && !unreleased ? fmtFinishClock(d.runtime) : null;
  const langSpec = d.originalLanguage ? languageName(d.originalLanguage) : null;
  const airingText = fmtNextAir(d.nextAiring);
  const statusPill =
    airingText ??
    (unreleased
      ? d.releaseDate
        ? `Out ${new Date(`${d.releaseDate.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : "Coming soon"
      : anime
        ? "Sub · Dub"
        : null);

  const director = d.crew.find((c) => /^(Chief )?Director$/i.test(c.job))?.name;
  const creator = d.crew.find((c) => /^Creator$/i.test(c.job))?.name;
  const studio = d.companies?.[0] ?? d.networks?.[0];
  const topCast = d.cast
    .slice(0, 3)
    .map((c) => c.name)
    .filter(Boolean);

  const pos = computePreviewPosition(anchor, vpWidth, vpHeight);
  const targetDetailsUrl = to ?? `/title/${encodeKey(d.key)}`;
  const votesText =
    d.voteCount && d.voteCount >= 100
      ? d.voteCount >= 1000
        ? `(${(d.voteCount / 1000).toFixed(1)}k)`
        : `(${d.voteCount})`
      : null;

  return (
    <div
      className="hover-preview"
      role="dialog"
      aria-label={`${d.title} preview`}
      style={{
        left: pos.left,
        top: pos.top,
        width: pos.width,
        transformOrigin: `${pos.originX} ${pos.originY}`,
      }}
      onPointerEnter={() => {
        keepHoverPreviewOpen();
        previewLight(d);
      }}
      onPointerLeave={() => {
        cancelHoverPreview(120);
        previewLight(null);
      }}
    >
      <div className="hp-media">
        <Art media={d} variant="backdrop" size="md" eager />
        <div className="hp-scrim" aria-hidden />
        <div className="hp-top-badges">
          <span className="hp-pill">{kindLabel(d.kind, d.format)}</span>
          {offlineCount > 0 && (
            <span className="hp-pill offline">
              <Icon name="download" size={10} /> Offline
            </span>
          )}
          <span className="grow" />
          {d.certification && <span className="hp-pill cert">{d.certification}</span>}
          {d.rating != null && d.rating > 0 && (
            <span className="hp-pill star">
              ★ {d.rating.toFixed(1)}
              {votesText && <small>{votesText}</small>}
            </span>
          )}
        </div>
        {statusPill && <span className="hp-status">{statusPill}</span>}
      </div>

      <div className="hp-body">
        <div className="hp-head">
          <h4>{d.title}</h4>
          {d.tagline ? (
            <p className="hp-tagline">“{d.tagline}”</p>
          ) : d.originalTitle && d.originalTitle !== d.title ? (
            <p className="hp-orig">{d.originalTitle}</p>
          ) : null}
        </div>

        <div className="hp-specs">
          {d.year && <span>{d.year}</span>}
          {lengthSpec && <span>{lengthSpec}</span>}
          {epRuntimeSpec && <span>{epRuntimeSpec}</span>}
          {langSpec && <span>{langSpec}</span>}
          {endsAt && <span>Ends {endsAt}</span>}
        </div>

        {d.genres.length > 0 && (
          <div className="hp-genres">
            {d.genres.slice(0, 4).map((g) => (
              <span key={g} className="hp-genre">
                {g}
              </span>
            ))}
          </div>
        )}

        <p className="hp-overview">
          {d.overview?.trim() ||
            (detail ? "No synopsis available for this title." : "Loading full synopsis & cast…")}
        </p>

        {(director || creator || studio || topCast.length > 0) && (
          <div className="hp-credits">
            {(director || creator) && (
              <span>
                <b>{director ? "Director" : "Creator"}</b> {director || creator}
              </span>
            )}
            {studio && (
              <span>
                <b>{anime ? "Studio" : "Network"}</b> {studio}
              </span>
            )}
            {topCast.length > 0 && (
              <span>
                <b>Starring</b> {topCast.join(", ")}
              </span>
            )}
          </div>
        )}

        <div className="hp-acts">
          {!unreleased && (
            <button
              type="button"
              className="btn play sm"
              onClick={() => {
                closeHoverPreviewNow();
                nav(to ?? playHref(d), { viewTransition: true, state: { from: "app" } });
              }}
            >
              <Icon name="play" size={13} /> Play
            </button>
          )}
          <button
            type="button"
            className="btn glass sm"
            onClick={() => {
              closeHoverPreviewNow();
              nav(targetDetailsUrl, {
                viewTransition: true,
                state: to ? { from: "app" } : seedState(d),
              });
            }}
          >
            Details <Icon name="arrowR" size={13} />
          </button>
          <button
            type="button"
            className={`btn glass sm icon ${saved ? "on" : ""}`}
            aria-pressed={saved}
            aria-label={saved ? "Remove from My List" : "Add to My List"}
            title={saved ? "In My List" : "Add to My List"}
            onClick={(e) => {
              if (!saved) burst(e.currentTarget);
              toggleList(d);
            }}
          >
            <Icon name={saved ? "check" : "plus"} size={14} />
          </button>
          <button
            type="button"
            className="btn glass sm icon"
            aria-label={`Quick dossier for ${d.title}`}
            title="Quick dossier (I)"
            onClick={() => {
              closeHoverPreviewNow();
              openDossier(d);
            }}
          >
            <Icon name="layers" size={14} />
          </button>
          {onRemove && (
            <button
              type="button"
              className="btn glass sm icon hp-dismiss"
              aria-label={removeLabel ?? `Remove ${d.title}`}
              title={removeLabel ?? "Remove"}
              onClick={() => {
                closeHoverPreviewNow();
                onRemove();
              }}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Portal overlay displaying an expansive Liquid Glass metadata card on card hover. */
export function CardHoverPreview() {
  const state = useHoverPreview();
  const [vp, setVp] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1440,
    h: typeof window !== "undefined" ? window.innerHeight : 900,
  }));

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHoverPreviewNow();
    };
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeHoverPreviewNow);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeHoverPreviewNow);
    };
  }, []);

  if (!state || typeof document === "undefined") return null;

  return createPortal(
    <PreviewCard
      key={state.media.key}
      media={state.media}
      detail={state.detail}
      to={state.to}
      onRemove={state.onRemove}
      removeLabel={state.removeLabel}
      anchor={state.anchor}
      vpWidth={vp.w}
      vpHeight={vp.h}
    />,
    document.body,
  );
}
