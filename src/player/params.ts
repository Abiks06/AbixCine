/**
 * Player options carried on a /watch link, so any part of the app (or a plugin, a "resume at"
 * shortcut, a shared moment) can open the player in a precise state:
 *
 *   #/watch/tmdb:movie:550?t=754&speed=1.25&provider=local&controls=0
 *
 * Everything is optional and every bad value is ignored rather than trusted, because these
 * strings can come from outside the app.
 */
export interface PlayerParams {
  /** Start here (seconds). Wins over the saved resume point. `t` or `start`, also "12:34" / "1h2m3s". */
  start?: number;
  /** Initial playback rate, one of SPEEDS. */
  speed?: number;
  /** Prefer this provider id (e.g. "local", "jellyfin") over the picker's ranking, if it has the title. */
  provider?: string;
  /** false hides the control bar (ambient / kiosk mode). Keyboard and the command bus still work. */
  controls?: boolean;
  /** false loads the stream paused on the first frame. */
  autoplay?: boolean;
  muted?: boolean;
  /** Turn on the subtitle track in this language (e.g. "en"), or "off". */
  sub?: string;
  /** Replace the title shown in the player header. */
  title?: string;
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const flag = (v: string | null) => (v == null ? undefined : v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined);

/** "754", "12:34", "1:02:03", "1h2m3s", "90s" → seconds, or undefined. */
export function parseTime(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  let n: number | undefined;
  if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  else if (/^\d+(:\d{1,2}){1,2}$/.test(s)) n = s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
  else {
    const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (m && (m[1] || m[2] || m[3])) n = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return n != null && Number.isFinite(n) && n >= 0 && n < 100 * 3600 ? n : undefined;
}

export function parsePlayerParams(q: URLSearchParams): PlayerParams {
  const out: PlayerParams = {};
  const start = parseTime(q.get("t") ?? q.get("start"));
  if (start != null) out.start = start;
  const speed = Number(q.get("speed"));
  if ((SPEEDS as readonly number[]).includes(speed)) out.speed = speed;
  const provider = q.get("provider") ?? q.get("server");
  if (provider && /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(provider) && provider !== "auto") out.provider = provider;
  const controls = flag(q.get("controls"));
  if (controls != null) out.controls = controls;
  const autoplay = flag(q.get("autoplay"));
  if (autoplay != null) out.autoplay = autoplay;
  const muted = flag(q.get("muted"));
  if (muted != null) out.muted = muted;
  const sub = q.get("sub");
  if (sub && /^(off|[a-z]{2,3}(-[a-z0-9]{2,8})?)$/i.test(sub)) out.sub = sub.toLowerCase();
  const title = q.get("title")?.trim();
  if (title) out.title = title.slice(0, 120);
  return out;
}

/** The inverse: only non-default values are written, so links stay short. */
export function playerParamsToQuery(p: PlayerParams): Record<string, string> {
  const q: Record<string, string> = {};
  if (p.start != null && p.start > 0) q.t = String(Math.floor(p.start));
  if (p.speed != null && p.speed !== 1) q.speed = String(p.speed);
  if (p.provider) q.provider = p.provider;
  if (p.controls === false) q.controls = "0";
  if (p.autoplay === false) q.autoplay = "0";
  if (p.muted) q.muted = "1";
  if (p.sub) q.sub = p.sub;
  if (p.title) q.title = p.title;
  return q;
}
