import { cached } from "../lib/cache";
import { normTitle } from "../lib/format";
import type { Settings } from "../lib/settings";
import { langBase } from "../lib/subtitles";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { isFilm } from "../lib/types";
import { DEFAULT_UA, httpFetch, native, normalizeHeaders, proxyUrl, sniff, type StreamHeaders } from "./native";
import { inferSubtitleMeta, isThumbnailSubtitleUrl, type SourceProvider, type StreamCandidate, type SubtitleTrack } from "./types";
import { encDec } from "./extractors/encdec";
import { decryptKisskhBlock, decryptKisskhSubtitle, isEncryptedSubCandidateUrl } from "../lib/kisskhSubs";

export { decryptKisskhBlock, decryptKisskhSubtitle };

/**
 * KissKH: Korean, Chinese, Japanese, Thai and Taiwanese dramas and films with subtitles
 * (one of Sora's sources). Its public API finds the show and the episode; the episode page
 * itself mints a short-lived token, so the stream is captured from that page by the sniffer.
 * Encrypted `.txt` / `.txt1` subtitles use AES-128-CBC (per `debakarr/kisskh-dl`) and are
 * decrypted in-memory into `data:` URLs so AbixCine's subtitle engine plays them natively.
 */

const HOST = "https://kisskh.co";
const ASIAN = new Set(["ko", "zh", "cn", "ja", "th", "tw", "tl", "id", "vi"]);
const SUB_FETCH_TIMEOUT_MS = 2_500;
const DIRECT_FETCH_TIMEOUT_MS = 4_500;

interface Hit { id: number; title: string; episodesCount: number }
interface Drama { id: number; title: string; episodes: { id: number; number: number }[] }
interface KisskhSubItem { src?: string; label?: string; land?: string; default?: boolean }

const slug = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");


async function fetchTextWithSignal(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = SUB_FETCH_TIMEOUT_MS,
): Promise<string | null> {
  if (signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const work = httpFetch(url, headers);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    const abort = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;
    const res = await Promise.race(abort ? [work, timeout, abort] : [work, timeout]);
    if (res.status < 200 || res.status >= 300 || !res.body) return null;
    return res.body;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function fetchKisskhKkey(epId: number, kind: "vid" | "sub", signal?: AbortSignal): Promise<string | null> {
  try {
    const kkey = await encDec<string>(
      "enc-kisskh",
      { query: { text: String(epId), type: kind } },
      signal,
      DIRECT_FETCH_TIMEOUT_MS,
    );
    return typeof kkey === "string" && kkey.trim() ? kkey.trim() : null;
  } catch {
    // No kkey (service down or aborted): the caller falls back to capturing the episode page.
    return null;
  }
}

async function fetchDirectEpisodeVideo(epId: number, page: string, signal?: AbortSignal): Promise<string | null> {
  const kkey = await fetchKisskhKkey(epId, "vid", signal);
  if (!kkey || signal?.aborted) return null;
  const body = await fetchTextWithSignal(
    `${HOST}/api/DramaList/Episode/${epId}.png?err=false&ts=&time=&kkey=${encodeURIComponent(kkey)}`,
    { Referer: page, Origin: HOST, Accept: "application/json", "User-Agent": DEFAULT_UA },
    signal,
    DIRECT_FETCH_TIMEOUT_MS,
  );
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { Video?: string; video?: string };
    const videoUrl = (parsed?.Video ?? parsed?.video ?? "").trim();
    return /^https?:\/\//i.test(videoUrl) ? videoUrl : null;
  } catch {
    return null;
  }
}

async function fetchApiSubtitles(epId: number, page: string, signal?: AbortSignal): Promise<KisskhSubItem[]> {
  if (signal?.aborted) return [];
  const kkey = await fetchKisskhKkey(epId, "sub", signal);
  const query = kkey ? `?kkey=${encodeURIComponent(kkey)}` : "";
  let body = await fetchTextWithSignal(
    `${HOST}/api/Sub/${epId}${query}`,
    { Referer: page, Origin: HOST, "User-Agent": DEFAULT_UA },
    signal,
  );
  if (!body && kkey) {
    body = await fetchTextWithSignal(
      `${HOST}/api/Sub/${epId}`,
      { Referer: page, Origin: HOST, "User-Agent": DEFAULT_UA },
      signal,
    );
  }
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as KisskhSubItem[]) : [];
  } catch {
    return [];
  }
}

function scoreSubPriority(
  lang: string,
  isDefault: boolean,
  prefBases: string[],
): number {
  const base = langBase(lang);
  if (prefBases[0] && base === prefBases[0]) return 4;
  if (prefBases.includes(base)) return 3;
  if (base === "en") return 2;
  if (isDefault) return 1;
  return 0;
}

/**
 * Resolve KissKH subtitles from sniffed URLs + optional `/api/Sub/{epId}` metadata,
 * prioritizing user language / English and capping parallel decryption so stream candidates
 * return promptly without blocking on 10+ secondary language tracks.
 */
export async function resolveKisskhSubtitles(
  items: { url: string; hintLang?: string; hintLabel?: string; isDefault?: boolean }[],
  headers: StreamHeaders,
  page: string,
  _signal?: AbortSignal,
  preferredLangs: string[] = [],
): Promise<SubtitleTrack[]> {
  const seen = new Set<string>();
  const unique: typeof items = [];
  for (const item of items) {
    if (!item.url || seen.has(item.url) || isThumbnailSubtitleUrl(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  if (!unique.length) return [];

  const prefBases = preferredLangs
    .map((l) => langBase(l))
    .filter((l) => l && l !== "und");

  const annotated = unique.map((item, idx) => {
    const meta = inferSubtitleMeta(item.url, item.hintLang, item.hintLabel);
    const isDefault = Boolean(item.isDefault || meta.isDefault);
    const priority = scoreSubPriority(meta.lang, isDefault, prefBases);
    return { item, meta, isDefault, priority, idx };
  });

  // Every track is handed over as a proxied URL: the subtitle loader decrypts KissKH's encrypted
  // `.txt`/`.txt1` files when a track is actually opened (lib/subtitleProviders.ts). Fetching and
  // decrypting the top three here held every lookup up by up to 2.5 s.
  const ordered = [...annotated].sort((a, b) => (b.priority - a.priority) || (a.idx - b.idx));
  const tracks = ordered.map(({ item, meta, isDefault }): SubtitleTrack => {
    const encrypted = isEncryptedSubCandidateUrl(item.url);
    return {
      lang: meta.lang,
      label: meta.label,
      url: proxyUrl(item.url, headers, page),
      ...(encrypted ? { format: "srt" as const } : meta.format ? { format: meta.format } : {}),
      isDefault,
      isForced: meta.isForced,
      isHearingImpaired: meta.isHearingImpaired,
      source: "stream",
    };
  });

  const labelCounts = new Map<string, number>();
  for (const t of tracks) {
    const count = (labelCounts.get(t.label) ?? 0) + 1;
    labelCounts.set(t.label, count);
    if (count > 1) t.label = `${t.label} ${count}`;
  }
  return tracks;
}

async function search(q: string): Promise<Hit[]> {
  try {
    return await cached(`kisskh:s:${q}`, 6 * 3600_000, async () => {
      const r = await httpFetch(`${HOST}/api/DramaList/Search?q=${encodeURIComponent(q)}&type=0`, {
        Referer: `${HOST}/`,
        Origin: HOST,
        "User-Agent": DEFAULT_UA,
      });
      if (r.status !== 200) throw new Error(`KissKH search HTTP ${r.status}`);
      const parsed = JSON.parse(r.body) as Hit[];
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty");
      return parsed;
    });
  } catch {
    return [];
  }
}

async function drama(id: number): Promise<Drama | null> {
  try {
    return await cached(`kisskh:d:${id}`, 3600_000, async () => {
      const r = await httpFetch(`${HOST}/api/DramaList/Drama/${id}?isq=false`, {
        Referer: `${HOST}/`,
        Origin: HOST,
        "User-Agent": DEFAULT_UA,
      });
      if (r.status !== 200) throw new Error(`KissKH drama HTTP ${r.status}`);
      const parsed = JSON.parse(r.body) as Drama;
      if (!parsed?.episodes?.length) throw new Error("no episodes");
      return parsed;
    });
  } catch {
    return null;
  }
}

export const kisskhProvider: SourceProvider = {
  id: "kisskh",
  name: "KissKH",
  category: "external",
  priority: 18,
  timeoutMs: 26_000,
  isEnabled: (s) => native && !s.disabledSources?.includes("kisskh"),
  async find(req: PlaybackRequest, s: Settings, signal): Promise<StreamCandidate[]> {
    // "zh-CN", "ZH" and "zh" are all Chinese.
    const lang = (req.media as MediaDetail).originalLanguage?.toLowerCase().split(/[-_]/)[0];
    if (!lang || !ASIAN.has(lang) || req.media.kind === "anime" || signal.aborted) return [];
    const want = normTitle(req.media.title);
    const season = req.season ?? 1;
    const q = season > 1 ? `${req.media.title} ${season}` : req.media.title;
    const [primaryHits, altHits] = await Promise.all([
      search(q),
      req.media.originalTitle && req.media.originalTitle !== req.media.title ? search(req.media.originalTitle) : Promise.resolve([] as Hit[]),
    ]);
    if (signal.aborted) return [];
    const hits = primaryHits.concat(altHits);
    const seasonForms = season > 1 ? [`${want} ${season}`, `${want}${season}`, `${want} season ${season}`] : [want];
    // No blind fallback to the first hit: a show that isn't on KissKH must come back empty, not
    // as whatever the search happened to list first.
    const hit =
      hits.find((h) => seasonForms.includes(normTitle(h.title))) ??
      (season > 1 ? undefined : hits.find((h) => normTitle(h.title).startsWith(want)));
    if (!hit) return [];
    const d = await drama(hit.id);
    const epNo = isFilm(req.media) ? 1 : req.episode ?? 1;
    // Exact first. Rounding is only for "12.0"-style numbers; it used to turn a 0.5 preview into episode 1.
    const ep = d?.episodes.find((e) => e.number === epNo) ?? d?.episodes.find((e) => e.number >= 1 && Math.round(e.number) === epNo);
    if (!d || !ep || signal.aborted) return [];
    const page = `${HOST}/Drama/${slug(d.title)}/Episode-${epNo}?id=${d.id}&ep=${ep.id}&page=0&pageSize=100`;
    const t0 = performance.now();
    const apiSubsPromise = fetchApiSubtitles(ep.id, page, signal);
    const directVideoUrl = await fetchDirectEpisodeVideo(ep.id, page, signal);
    if (signal.aborted) return [];
    const prefLangs = [s.subtitlePref?.lang, s.subtitlePref?.secondaryLang].filter(
      (v): v is string => Boolean(v?.trim()),
    );

    if (directVideoUrl) {
      const apiSubs = await apiSubsPromise;
      if (signal.aborted) return [];
      const headers = normalizeHeaders({ referer: page, origin: HOST, ua: DEFAULT_UA }, page);
      const subItems = apiSubs
        .filter((sub) => typeof sub?.src === "string" && sub.src.trim())
        .map((sub) => ({
          url: sub.src!.trim(),
          hintLang: sub.land?.trim() || undefined,
          hintLabel: sub.label?.trim() || undefined,
          isDefault: Boolean(sub.default),
        }));
      const subtitles = await resolveKisskhSubtitles(subItems, headers, page, signal, prefLangs);
      if (signal.aborted) return [];
      return [
        {
          providerId: "kisskh",
          providerName: "KissKH",
          label: `${d.title}${isFilm(req.media) ? "" : ` · Episode ${epNo}`}`,
          url: proxyUrl(directVideoUrl, headers, page),
          kind: /\.mp4(?:[?#]|$)/i.test(directVideoUrl) ? "file" : "hls",
          via: "direct",
          headers,
          subtitles,
          lookupMs: Math.round(performance.now() - t0),
        },
      ];
    }

    const [got, apiSubs] = await Promise.all([
      sniff(page, 16_000, signal),
      apiSubsPromise,
    ]);
    if (!got || got.verified === false || signal.aborted) return [];
    const headers = normalizeHeaders(got.headers, page);
    const subItems: { url: string; hintLang?: string; hintLabel?: string; isDefault?: boolean }[] = [
      ...apiSubs
        .filter((s) => typeof s?.src === "string" && s.src.trim())
        .map((s) => ({
          url: s.src!.trim(),
          hintLang: s.land?.trim() || undefined,
          hintLabel: s.label?.trim() || undefined,
          isDefault: Boolean(s.default),
        })),
      ...got.subtitles.map((url) => ({ url })),
    ];
    const subtitles = await resolveKisskhSubtitles(subItems, headers, page, signal, prefLangs);
    if (signal.aborted) return [];
    return [
      {
        providerId: "kisskh",
        providerName: "KissKH",
        label: `${d.title}${isFilm(req.media) ? "" : ` · Episode ${epNo}`}`,
        url: proxyUrl(got.url, headers, page),
        kind: got.kind === "mp4" ? "file" : got.kind === "dash" ? "dash" : "hls",
        via: "sniffed",
        pageUrl: page,
        headers,
        subtitles,
        ...(got.verified === true
          ? { probe: { ok: true, latencyMs: Math.round(performance.now() - t0), quality: got.quality ?? undefined } }
          : {}),
      },
    ];
  },
};
