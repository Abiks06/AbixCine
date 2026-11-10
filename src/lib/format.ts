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
    .replace(/[._\-:'’!?,()[\]]/g, " ")
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
