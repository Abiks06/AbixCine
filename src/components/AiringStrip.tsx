import { useMemo } from "react";
import { Link } from "react-router-dom";
import { getTrackingState, useAiringRadar } from "../lib/airing";
import { encodeKey } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { fmtAirBadge } from "../lib/format";
import { previewLight } from "../lib/light";
import { useAllProgress } from "../lib/progress";
import { isFilm } from "../lib/types";
import { useWatchlist } from "../lib/watchlist";
import { Art } from "./Art";
import { kindLabel, seedState } from "./Card";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

/**
 * Compact weekly airing schedule strip: surfaces every ongoing show you follow (watching,
 * caught up, or in My List) with its next episode countdown and your caught-up / behind status.
 */
export function AiringStrip({ lens = "all" }: { lens?: "all" | "film" | "series" | "anime" }) {
  const progress = useAllProgress();
  const watchlist = useWatchlist();

  const trackedEntries = useMemo(() => {
    const byKey = new Map<string, { media: (typeof progress)[number]["media"]; entry?: (typeof progress)[number] }>();
    for (const p of progress) {
      if (p.finished || isFilm(p.media)) continue;
      if (lens === "anime" && p.media.kind !== "anime") continue;
      if (lens === "series" && p.media.kind !== "tv") continue;
      if (lens === "film") continue;
      byKey.set(p.media.key, { media: p.media, entry: p });
    }
    for (const w of watchlist) {
      if (isFilm(w.media)) continue;
      if (lens === "anime" && w.media.kind !== "anime") continue;
      if (lens === "series" && w.media.kind !== "tv") continue;
      if (lens === "film") continue;
      if (!byKey.has(w.media.key)) byKey.set(w.media.key, { media: w.media });
    }
    return [...byKey.values()];
  }, [progress, watchlist, lens]);

  const trackedMedia = useMemo(() => trackedEntries.map((t) => t.media), [trackedEntries]);
  const { airingMap, nowMs } = useAiringRadar(trackedMedia);

  const schedule = useMemo(() => {
    const rows = trackedEntries
      .map(({ media, entry }) => {
        const snap = airingMap[media.key];
        const state = getTrackingState(media, entry, snap, nowMs);
        if (state.kind !== "new-episode" && state.kind !== "caught-up" && !state.nextAiring) return null;
        if (state.kind === "completed") return null;
        const sortTime = state.kind === "new-episode" ? 0 : (state.nextAiring?.at ?? Number.MAX_SAFE_INTEGER);
        return { media, entry, state, sortTime };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => a.sortTime - b.sortTime);
    return rows.slice(0, 10);
  }, [trackedEntries, airingMap, nowMs]);

  if (lens === "film" || !schedule.length) return null;

  return (
    <section className="shelf airing-shelf" id="airing-schedule" aria-label="Airing schedule">
      <SectionHead
        eyebrow="Tracked series & anime simulcasts"
        title="Airing"
        accentWord="this week"
        to="/list"
        right={<span className="shelf-note">{schedule.length} TRACKED</span>}
      />
      <div className="airing-strip">
        {schedule.map(({ media, state }) => {
          registerMedia(media);
          const airBadge = state.nextAiring ? fmtAirBadge(state.nextAiring, nowMs) : state.detail;
          return (
            <article
              key={media.key}
              className={`airing-item ${state.kind}`}
              data-media-key={media.key}
              onMouseEnter={() => previewLight(media)}
              onMouseLeave={() => previewLight(null)}
            >
              <Link to={`/title/${encodeKey(media.key)}`} state={seedState(media)} viewTransition className="airing-hit">
                <span className="airing-th">
                  <Art media={media} variant="poster" size="xs" eager />
                </span>
                <span className="airing-copy">
                  <span className="airing-top">
                    <span className={`airing-pill ${state.kind}`}>
                      {state.kind === "new-episode"
                        ? state.badge
                        : state.kind === "caught-up"
                          ? "Caught up"
                          : kindLabel(media.kind, media.format)}
                    </span>
                  </span>
                  <strong>{media.title}</strong>
                  <small>{airBadge || "Waiting for next date"}</small>
                </span>
              </Link>
              <button
                type="button"
                className="icon-btn"
                title={`Quick view ${media.title}`}
                aria-label={`Quick view ${media.title}`}
                onClick={() => openDossier(media)}
              >
                <Icon name="layers" size={13} />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
