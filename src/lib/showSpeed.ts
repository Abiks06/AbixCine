/**
 * Playback speed remembered per show: change the speed on one episode and the next episode of
 * the same series starts at that speed, while every other show (and every film) starts at 1×.
 */

const STORE_KEY = "abx.showSpeed";
const MAX_SHOWS = 200;

type SpeedMap = Record<string, number>;

function read(): SpeedMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SpeedMap) : {};
  } catch {
    return {};
  }
}

function write(map: SpeedMap) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    /* storage full or unavailable: speed just won't carry over */
  }
}

const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0.25 && n <= 4;

/** The show's remembered speed, or 1. A missing key (a film, or an unknown title) is always 1. */
export function loadShowSpeed(showKey: string | undefined): number {
  if (!showKey) return 1;
  const v = read()[showKey];
  return valid(v) ? v : 1;
}

/** Remember the speed for this show. Normal speed clears the entry instead of storing 1. */
export function saveShowSpeed(showKey: string | undefined, speed: number) {
  if (!showKey) return;
  const map = read();
  delete map[showKey]; // re-insert so the most recently used show is last (oldest drop first)
  if (valid(speed) && speed !== 1) map[showKey] = speed;
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length - MAX_SHOWS; i++) delete map[keys[i]];
  write(map);
}

/** Which show an episode belongs to: the franchise key for anime split over several entries. */
export function showKeyFor(
  media: { key?: string; canonicalKey?: string } | undefined,
  episode: number | undefined,
): string | undefined {
  if (episode == null || !media) return undefined; // films don't carry a speed over
  return media.canonicalKey ?? media.key;
}
