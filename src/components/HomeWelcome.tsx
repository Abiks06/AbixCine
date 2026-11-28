import { Link } from "react-router-dom";
import { useAuth } from "../lib/account";
import { getTrackingState, useAiringMap, useNowMinute } from "../lib/airing";
import { toggleTasteSeed, useTasteSeeds } from "../lib/dismissed";
import { useAllProgress } from "../lib/progress";
import type { Lane } from "../lib/taste";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import { useWatchlist } from "../lib/watchlist";
import { Icon } from "./Icon";

export type HomeLens = "all" | Lane;

const LENSES: { id: HomeLens; label: string }[] = [
  { id: "all", label: "All" },
  { id: "film", label: "Films" },
  { id: "series", label: "Series" },
  { id: "anime", label: "Anime" },
];

const STARTER_MOODS = ["Sci-Fi", "Thriller", "Action", "Drama", "Fantasy", "Comedy", "Mystery", "Romance", "Horror"] as const;

function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  if (h >= 17 && h < 22) return "Good evening";
  return "Late-night screening";
}

/**
 * Warm personal welcome & programme status bar:
 * Gives the user an immediate sense of home—who's signed in, what episodes just dropped,
 * what they're caught up on, quick lens switching, and lightweight cold-start mood seeds.
 */
export function HomeWelcome({
  lens,
  onLens,
  catalog,
  filmPct,
  seriesPct,
  animePct,
  topGenres,
  hasSignals,
  hasDownloads,
}: {
  lens: HomeLens;
  onLens: (l: HomeLens) => void;
  catalog: boolean;
  filmPct: number;
  seriesPct: number;
  animePct: number;
  topGenres: string[];
  hasSignals: boolean;
  hasDownloads: boolean;
}) {
  const { user } = useAuth();
  const lensInd = useSlidingIndicator();
  const allProgress = useAllProgress();
  const watchlist = useWatchlist();
  const airingMap = useAiringMap();
  const nowMs = useNowMinute();
  const seeds = useTasteSeeds();

  const firstName = user?.name?.trim().split(/\s+/)[0];
  const greeting = greetingForHour(new Date(nowMs).getHours());

  let newEpCount = 0;
  let caughtUpCount = 0;
  let inProgressCount = 0;
  for (const p of allProgress) {
    if (p.finished) continue;
    const st = getTrackingState(p.media, p, airingMap[p.media.key], nowMs);
    if (st.kind === "new-episode") newEpCount += 1;
    else if (st.kind === "caught-up") caughtUpCount += 1;
    else if (p.position > 15 || p.upNext) inProgressCount += 1;
  }

  return (
    <section className="home-welcome pad" aria-label="Your screening room">
      <div className="hw-top">
        <div className="hw-greeting">
          <div className="hw-hello">
            <h2>
              {greeting}
              {firstName ? `, ${firstName}` : ""}
            </h2>
            {topGenres.length > 0 && (
              <span className="taste-genres">
                {topGenres.slice(0, 3).map((g) => (
                  <span key={g} className="badge dim">
                    {g}
                  </span>
                ))}
              </span>
            )}
          </div>

          <div className="hw-pulse">
            {newEpCount > 0 && (
              <a href="#active-reel" className="hw-pill new-ep">
                <Icon name="spark" size={12} /> {newEpCount} new episode{newEpCount === 1 ? "" : "s"} out
              </a>
            )}
            {inProgressCount > 0 && (
              <a href="#active-reel" className="hw-pill">
                <Icon name="play" size={11} /> {inProgressCount} in progress
              </a>
            )}
            {caughtUpCount > 0 && (
              <a href="#airing-schedule" className="hw-pill caught-up">
                <Icon name="check" size={12} /> {caughtUpCount} caught up
              </a>
            )}
            {watchlist.length > 0 && (
              <Link to="/list" viewTransition className="hw-pill">
                <Icon name="bookmark" size={12} /> {watchlist.length} saved
              </Link>
            )}
            {hasDownloads && (
              <Link to="/library" viewTransition className="hw-pill offline">
                <Icon name="download" size={12} /> Vault ready
              </Link>
            )}
            {allProgress.length > 0 && (
              <Link
                to="/list?tab=history"
                viewTransition
                className="hw-pill"
                title={hasSignals ? `Home mix: ${filmPct}% Film · ${seriesPct}% Series · ${animePct}% Anime` : "View watch history and stats"}
              >
                <Icon name="clock" size={12} /> Activity
              </Link>
            )}
          </div>
        </div>

        <div className="seg-pills" role="tablist" aria-label="Filter home programme" ref={lensInd}>
          {LENSES.filter((l) => catalog || l.id === "all" || l.id === "anime").map((l) => (
            <button
              key={l.id}
              role="tab"
              aria-selected={lens === l.id}
              className={lens === l.id ? "on" : ""}
              onClick={() => onLens(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {!allProgress.length && !watchlist.length && (
        <div className="hw-seeds" aria-label="Shape your initial recommendations">
          <span className="hw-seeds-lbl">Pick genres you love to personalize Home:</span>
          <div className="hw-seeds-list">
            {STARTER_MOODS.map((g) => {
              const on = seeds.includes(g);
              return (
                <button
                  key={g}
                  type="button"
                  className={`chip ${on ? "on" : ""}`}
                  aria-pressed={on}
                  onClick={() => toggleTasteSeed(g)}
                >
                  {on && <Icon name="check" size={11} />}
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
