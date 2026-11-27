export function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function fmtRuntime(min?: number) {
  if (!min) return "";
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();

/** Lowercase, drop punctuation and articles: used to match catalog titles to file names. */
export function normTitle(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "") // "Journey's" and "Journeys" are the same release name
    .replace(/[._\-:!?,()[\]&]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "$185M", "$1.2B", "$850K"; empty for 0/unknown. */
export function fmtMoney(n?: number) {
  if (!n) return "";
  const f = (v: number, u: string) => `$${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${u}`;
  if (n >= 1e9) return f(n / 1e9, "B");
  if (n >= 1e6) return f(n / 1e6, "M");
  if (n >= 1e3) return f(n / 1e3, "K");
  return `$${n}`;
}

export function fmtDate(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return isNaN(+d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function languageName(code?: string) {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "4 min ago" style label. */
export function fmtAgo(t?: number) {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Compact episode code ("S2·E5" or "E18"). */
export function fmtEpCode(season?: number, episode?: number) {
  if (episode == null) return season != null ? `S${season}` : "";
  return season != null && season > 0 ? `S${season}·E${episode}` : season === 0 ? `Sp·E${episode}` : `E${episode}`;
}

/** Normalize an airing timestamp (seconds or milliseconds) into milliseconds. */
export function toAiringMs(at: number): number {
  return at > 1e11 ? at : at * 1000;
}

/** Difference in local calendar days between `target` and `now` (0 = today, 1 = tomorrow). */
function localDayDiff(target: Date, now: Date): number {
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

/**
 * Human-readable countdown or date for an upcoming episode.
 * Date-only sources (TMDB) never invent a clock time like "12:00".
 */
export function fmtCountdown(at: number, dateOnly = false, nowMs = Date.now()): string {
  const targetMs = toAiringMs(at);
  const d = new Date(targetMs);
  if (isNaN(+d)) return "";
  const now = new Date(nowMs);
  const dayDiff = localDayDiff(d, now);

  if (dateOnly) {
    if (dayDiff <= 0) return "Out today";
    if (dayDiff === 1) return "Tomorrow";
    if (dayDiff < 7) {
      const wd = d.toLocaleDateString(undefined, { weekday: "short" });
      return `in ${dayDiff}d · ${wd}`;
    }
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  const diffSec = Math.round((targetMs - nowMs) / 1000);
  if (diffSec <= 0) return "Out now";
  if (diffSec < 3600) return `in ${Math.max(1, Math.round(diffSec / 60))}m`;
  if (diffSec < 86_400) {
    const hrs = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    return mins >= 10 && hrs < 6 ? `in ${hrs}h ${mins}m` : `in ${hrs}h`;
  }
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (dayDiff === 1) return `Tomorrow · ${timeStr}`;
  if (dayDiff < 7) {
    const wd = d.toLocaleDateString(undefined, { weekday: "short" });
    return `${wd} · ${timeStr}`;
  }
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `in ${dayDiff}d · ${dateStr}`;
}

/** Single formatted badge string such as "S2·E5 · in 2d" or "E18 · Sun · 5:30 PM". */
export function fmtAirBadge(
  next?: { episode: number; season?: number; at: number; dateOnly?: boolean },
  nowMs = Date.now(),
): string {
  if (!next) return "";
  const code = fmtEpCode(next.season, next.episode);
  const when = fmtCountdown(next.at, Boolean(next.dateOnly), nowMs);
  return [code, when].filter(Boolean).join(" · ");
}
