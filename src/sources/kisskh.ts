import { cached } from "../lib/cache";
import { normTitle } from "../lib/format";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { DEFAULT_UA, httpFetch, native, normalizeHeaders, proxyUrl, sniff, type StreamHeaders } from "./native";
import { inferSubtitleMeta, isThumbnailSubtitleUrl, type SourceProvider, type StreamCandidate, type SubtitleFormat, type SubtitleTrack } from "./types";

/**
 * KissKH: Korean, Chinese, Japanese, Thai and Taiwanese dramas and films with subtitles
 * (one of Sora's sources). Its public API finds the show and the episode; the episode page
 * itself mints a short-lived token, so the stream is captured from that page by the sniffer.
 * Encrypted `.txt` / `.txt1` subtitles use AES-128-CBC (per `debakarr/kisskh-dl`) and are
 * decrypted in-memory into `data:` URLs so AbixCine's subtitle engine plays them natively.
 */

const HOST = "https://kisskh.co";
const ASIAN = new Set(["ko", "zh", "cn", "ja", "th", "tw", "tl", "id", "vi"]);
const KISSKH_SUB_KEY = "8056483646328763";
const KISSKH_SUB_IV = "6852612370185273";
const SUB_FETCH_TIMEOUT_MS = 6_000;

interface Hit { id: number; title: string; episodesCount: number }
interface Drama { id: number; title: string; episodes: { id: number; number: number }[] }
interface KisskhSubItem { src?: string; label?: string; land?: string; default?: boolean }

const slug = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

let cachedSubKeyPromise: Promise<CryptoKey> | null = null;
const KISSKH_IV_BYTES = new TextEncoder().encode(KISSKH_SUB_IV);

function getKisskhSubKey(): Promise<CryptoKey> {
  if (!cachedSubKeyPromise) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return Promise.reject(new Error("WebCrypto subtle API unavailable"));
    const keyBytes = new TextEncoder().encode(KISSKH_SUB_KEY);
    cachedSubKeyPromise = subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  }
  return cachedSubKeyPromise;
}

function base64ToBytes(raw: string): Uint8Array<ArrayBuffer> | null {
  const clean = raw.trim();
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

/** Decrypt a single Base64-encoded AES-128-CBC KissKH subtitle block (PKCS#7 + trailing NUL trim). */
export async function decryptKisskhBlock(b64: string): Promise<string | null> {
  const cipher = base64ToBytes(b64);
  if (!cipher || cipher.length < 16 || cipher.length % 16 !== 0) return null;
  try {
    const key = await getKisskhSubKey();
    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: KISSKH_IV_BYTES },
      key,
      cipher,
    );
    const bytes = new Uint8Array(plainBuf);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return null;
  }
}

/**
 * Decrypt a KissKH `.txt` / `.txt1` subtitle payload.
 * Per `debakarr/kisskh-dl`, KissKH `.txt`/`.txt1` files keep SRT cue indices and timestamps in
 * plaintext while AES-128-CBC-encrypting each cue's text lines. Also handles whole-payload
 * encrypted blobs and passes through unencrypted SRT/VTT unchanged.
 */
export async function decryptKisskhSubtitle(raw: string): Promise<{ text: string; decrypted: boolean }> {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return { text: normalized, decrypted: false };

  if (!normalized.includes("-->")) {
    const whole = await decryptKisskhBlock(normalized.replace(/\s+/g, ""));
    if (whole && whole.trim()) {
      return { text: whole.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), decrypted: true };
    }
    return { text: normalized, decrypted: false };
  }

  const lines = normalized.split("\n");
  const out: string[] = [];
  let decryptedCount = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    if (!line.includes("-->")) continue;

    const cueLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      cueLines.push(lines[i]);
      i++;
    }

    if (cueLines.length > 0) {
      let cueDecrypted = 0;
      const decodedLines = await Promise.all(
        cueLines.map(async (cl) => {
          const dec = await decryptKisskhBlock(cl);
          if (dec !== null) {
            cueDecrypted++;
            return dec;
          }
          return cl;
        }),
      );

      if (cueDecrypted > 0) {
        decryptedCount += cueDecrypted;
        out.push(...decodedLines);
      } else if (cueLines.length > 1) {
        const joined = await decryptKisskhBlock(cueLines.map((l) => l.trim()).join(""));
        if (joined !== null) {
          decryptedCount++;
          out.push(joined);
        } else {
          out.push(...cueLines);
        }
      } else {
        out.push(...cueLines);
      }
    }

    if (i < lines.length && lines[i].trim() === "") {
      out.push(lines[i]);
      i++;
    }
  }

  return { text: out.join("\n"), decrypted: decryptedCount > 0 };
}

function detectDecryptedFormat(text: string): SubtitleFormat {
  const trimmed = text.trimStart();
  if (/^WEBVTT(?:\s|$|-)/i.test(trimmed)) return "vtt";
  if (/^\s*\[Script Info\]/im.test(text) || /^\s*\[Events\]/im.test(text)) return "ass";
  return "srt";
}

function toSubtitleDataUrl(text: string, format: SubtitleFormat): string {
  const mime = format === "vtt" ? "text/vtt" : "text/plain";
  const bytes = new TextEncoder().encode(text);
  return `data:${mime};charset=utf-8;base64,${bytesToBase64(bytes)}`;
}

function isEncryptedSubCandidateUrl(url: string): boolean {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  return clean.endsWith(".txt") || clean.endsWith(".txt1") || clean.endsWith(".txt2");
}

async function fetchTextWithSignal(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = httpFetch(url, headers);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), SUB_FETCH_TIMEOUT_MS);
    });
    const abort = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
      : null;
    const res = await Promise.race(abort ? [work, timeout, abort] : [work, timeout]);
    if (res.status < 200 || res.status >= 300 || !res.body) return null;
    return res.body;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchApiSubtitles(epId: number, page: string, signal?: AbortSignal): Promise<KisskhSubItem[]> {
  if (signal?.aborted) return [];
  const body = await fetchTextWithSignal(
    `${HOST}/api/Sub/${epId}`,
    { Referer: page, Origin: HOST, "User-Agent": DEFAULT_UA },
    signal,
  );
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as KisskhSubItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve KissKH subtitles from sniffed URLs + optional `/api/Sub/{epId}` metadata,
 * decrypting `.txt` / `.txt1` (or encrypted `.srt`/`.vtt`) payloads into playable `data:` URLs.
 */
export async function resolveKisskhSubtitles(
  items: { url: string; hintLang?: string; hintLabel?: string; isDefault?: boolean }[],
  headers: StreamHeaders,
  page: string,
  signal?: AbortSignal,
): Promise<SubtitleTrack[]> {
  const seen = new Set<string>();
  const unique: typeof items = [];
  for (const item of items) {
    if (!item.url || seen.has(item.url) || isThumbnailSubtitleUrl(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  if (!unique.length) return [];

  const fetchHeaders: Record<string, string> = {
    ...(headers.referer ? { Referer: headers.referer } : { Referer: page }),
    ...(headers.origin ? { Origin: headers.origin } : { Origin: HOST }),
    "User-Agent": headers.ua ?? DEFAULT_UA,
  };

  const tracks = await Promise.all(
    unique.map(async (item): Promise<SubtitleTrack> => {
      const meta = inferSubtitleMeta(item.url, item.hintLang, item.hintLabel);
      const body = await fetchTextWithSignal(item.url, fetchHeaders, signal);
      if (body) {
        const { text, decrypted } = await decryptKisskhSubtitle(body);
        if (decrypted || (isEncryptedSubCandidateUrl(item.url) && text.includes("-->"))) {
          const format = detectDecryptedFormat(text);
          return {
            lang: meta.lang,
            label: meta.label,
            url: toSubtitleDataUrl(text, format),
            format,
            isDefault: Boolean(item.isDefault || meta.isDefault),
            isForced: meta.isForced,
            isHearingImpaired: meta.isHearingImpaired,
            source: "stream",
          };
        }
      }
      return {
        lang: meta.lang,
        label: meta.label,
        url: proxyUrl(item.url, headers, page),
        ...(meta.format ? { format: meta.format } : {}),
        isDefault: Boolean(item.isDefault || meta.isDefault),
        isForced: meta.isForced,
        isHearingImpaired: meta.isHearingImpaired,
        source: "stream",
      };
    }),
  );

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
  async find(req: PlaybackRequest, _s, signal): Promise<StreamCandidate[]> {
    const lang = (req.media as MediaDetail).originalLanguage;
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
    const hit =
      hits.find((h) => normTitle(h.title) === want + (season > 1 ? String(season) : "")) ??
      hits.find((h) => normTitle(h.title).startsWith(want)) ??
      hits[0];
    if (!hit) return [];
    const d = await drama(hit.id);
    const epNo = req.media.kind === "movie" ? 1 : req.episode ?? 1;
    const ep = d?.episodes.find((e) => Math.round(e.number) === epNo);
    if (!d || !ep || signal.aborted) return [];
    const page = `${HOST}/Drama/${slug(d.title)}/Episode-${epNo}?id=${d.id}&ep=${ep.id}&page=0&pageSize=100`;
    const t0 = performance.now();
    const [got, apiSubs] = await Promise.all([
      sniff(page, 16_000, signal),
      fetchApiSubtitles(ep.id, page, signal),
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
    const subtitles = await resolveKisskhSubtitles(subItems, headers, page, signal);
    if (signal.aborted) return [];
    return [
      {
        providerId: "kisskh",
        providerName: "KissKH",
        label: `${d.title}${req.media.kind === "movie" ? "" : ` · Episode ${epNo}`}`,
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
