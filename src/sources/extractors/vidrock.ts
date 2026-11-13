import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  aes256GcmDecrypt,
  base64ToBytes,
  buildStreamHeaders,
  fetchJsonWithAbort,
  hexToBytes,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  normalizeQuality,
  resolveMediaIds,
} from "./common";

const VIDROCK_API = "https://vidrock.ru";
const VIDROCK_KEY_HEX = "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
const VIDROCK_KEY = hexToBytes(VIDROCK_KEY_HEX);

type VidrockServerValue = string | { url?: string; quality?: string | number; type?: string };

/**
 * Decrypt a Vidrock encrypted server URL payload:
 * `base64url(nonce[12] || ciphertext || gcmTag[16])` via WebCrypto AES-256-GCM.
 */
export async function decryptVidrockUrl(payload: string): Promise<string | null> {
  if (!payload || typeof payload !== "string") return null;
  try {
    const raw = base64ToBytes(payload);
    if (raw.length <= 28) return null;
    const nonce = raw.subarray(0, 12);
    const ciphertextWithTag = raw.subarray(12);
    const decrypted = await aes256GcmDecrypt(VIDROCK_KEY, nonce, ciphertextWithTag);
    if (!decrypted || !/^https?:\/\//i.test(decrypted.trim())) return null;
    return decrypted.trim();
  } catch {
    return null;
  }
}

/**
 * Direct Vidrock extractor (`vidrock.ru/api/...`) with local WebCrypto AES-256-GCM decryption.
 */
export const vidrockProvider: SourceProvider = {
  id: "vidrock",
  name: "Vidrock",
  category: "external",
  priority: 24.5,
  timeoutMs: 12_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("vidrock", s),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    const audio = req.audio ?? "sub";
    if (anime && audio === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const isMovie = req.media.kind === "movie";
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const endpoint = isMovie
        ? `${VIDROCK_API}/api/movie/${meta.tmdbId}/`
        : `${VIDROCK_API}/api/tv/${meta.tmdbId}_${season}_${episode}/`;

      const res = await fetchJsonWithAbort<Record<string, VidrockServerValue>>(
        endpoint,
        {
          Origin: VIDROCK_API,
          Referer: `${VIDROCK_API}/`,
          "User-Agent": DEFAULT_UA,
          Accept: "application/json, text/plain, */*",
        },
        undefined,
        signal,
        10_000,
      );
      if (signal.aborted || !res.data || typeof res.data !== "object") return [];

      const streamHeaders = buildStreamHeaders(`${VIDROCK_API}/`, VIDROCK_API);
      const entries = Object.entries(res.data);
      const decoded = await Promise.all(
        entries.map(async ([server, val]) => {
          const enc = typeof val === "string" ? val : val?.url;
          if (!enc || enc === "error" || enc === "null") return null;
          const url = await decryptVidrockUrl(enc);
          if (!url) return null;
          const hintType = typeof val === "object" && val ? val.type : undefined;
          const quality = normalizeQuality(typeof val === "object" && val ? val.quality : undefined) ?? normalizeQuality(url);
          const kind = inferStreamKind(url, hintType);
          return {
            providerId: "vidrock",
            providerName: "Vidrock",
            label: `Vidrock · ${server}${quality ? ` · ${quality}p` : ""}`,
            url: proxyUrl(url, streamHeaders, VIDROCK_API),
            kind,
            via: "direct" as const,
            pageUrl: `${VIDROCK_API}/`,
            headers: streamHeaders,
            ...(quality ? { quality } : {}),
            ...(anime ? { audio: "sub" as const } : {}),
          } satisfies StreamCandidate;
        }),
      );

      if (signal.aborted) return [];
      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const cand of decoded) {
        if (!cand || seen.has(cand.url)) continue;
        seen.add(cand.url);
        out.push(cand);
      }
      return out.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
    } catch (err) {
      if (isAbortError(err)) return [];
      return [];
    }
  },
};
