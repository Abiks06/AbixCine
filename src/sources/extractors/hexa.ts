import type { Settings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";
import { DEFAULT_UA, proxyUrl } from "../native";
import type { SourceProvider, StreamCandidate } from "../types";
import {
  abortError,
  buildStreamHeaders,
  fetchJsonWithAbort,
  fetchWithAbort,
  inferStreamKind,
  isAbortError,
  isAnimeRequest,
  isDirectExtractorEnabled,
  isMovieRequest,
  randomHex,
  resolveMediaIds,
} from "./common";
import { encDec } from "./encdec";

const HEXA_ORIGIN = "https://hexa.su";
const HEXA_CAP = "https://cap.hexa.su/15d2cf0395";
const HEXA_API = "https://theemoviedb.hexa.su/api/tmdb";
const HEXA_FINGERPRINT = "e9136c41504646444";
/** A redeemed cap token is good for 20 lookups; stop a little short so a race never hits the limit. */
const TOKEN_MAX_USES = 18;
const TOKEN_SAFETY_MS = 60_000;

interface HexaCapToken {
  token: string;
  uses: number;
  expiresAt: number;
}

interface HexaSource {
  server?: string;
  url?: string;
}

let capToken: HexaCapToken | null = null;
/** One mint at a time: concurrent lookups (movie + next-episode prefetch) share a single PoW solve. */
let inflightMint: Promise<HexaCapToken | null> | null = null;
const MINT_TIMEOUT_MS = 20_000;

/** Reset Hexa's cached cap token (unit tests). */
export function clearHexaTokenCache(): void {
  capToken = null;
  inflightMint = null;
}

const capHeaders = () => ({
  Origin: HEXA_ORIGIN,
  Referer: `${HEXA_ORIGIN}/`,
  "User-Agent": DEFAULT_UA,
  Accept: "application/json",
});

/** Solve Hexa's proof-of-work cap challenge (via enc-dec.app) and redeem it for an API token. */
async function mintCapToken(signal: AbortSignal): Promise<HexaCapToken | null> {
  const challenge = await fetchJsonWithAbort<Record<string, unknown>>(
    `${HEXA_CAP}/challenge`,
    capHeaders(),
    { method: "POST" },
    signal,
    6_000,
  );
  if (!challenge.data || signal.aborted) return null;

  const solved = await encDec<unknown>("enc-hexa", { json: { challenge_data: challenge.data } }, signal, 10_000);
  if (!solved || signal.aborted) return null;

  const redeem = await fetchJsonWithAbort<{ success?: boolean; token?: string; expires?: number }>(
    `${HEXA_CAP}/redeem`,
    { ...capHeaders(), "Content-Type": "application/json" },
    { method: "POST", body: JSON.stringify(solved) },
    signal,
    6_000,
  );
  const token = typeof redeem.data?.token === "string" ? redeem.data.token.trim() : "";
  if (!token) return null;
  const expires = Number(redeem.data?.expires);
  return {
    token,
    uses: 0,
    expiresAt: Number.isFinite(expires) && expires > Date.now() ? expires : Date.now() + 30 * 60_000,
  };
}

/** Wait for `p`, but give up as soon as the caller's own signal aborts. */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

async function fetchCapToken(signal: AbortSignal): Promise<string | null> {
  const usable = (t: HexaCapToken | null): t is HexaCapToken =>
    !!t && t.uses < TOKEN_MAX_USES && Date.now() < t.expiresAt - TOKEN_SAFETY_MS;

  if (!usable(capToken)) {
    if (!inflightMint) {
      // The mint is shared, so it must not die with whichever caller happened to start it.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("Hexa token mint timed out")), MINT_TIMEOUT_MS);
      const mint = mintCapToken(ctl.signal)
        .then((t) => {
          if (inflightMint === mint) capToken = t;
          return t;
        })
        .finally(() => {
          clearTimeout(timer);
          if (inflightMint === mint) inflightMint = null;
        });
      inflightMint = mint;
    }
    await raceSignal(inflightMint, signal);
  }
  if (!usable(capToken)) return null;
  capToken.uses += 1;
  return capToken.token;
}

/**
 * Direct Hexa extractor (`theemoviedb.hexa.su`, Movie & TV). The API answers with a payload
 * encrypted under a per-request client key; `enc-dec.app` solves the cap challenge and decrypts.
 */
export const hexaProvider: SourceProvider = {
  id: "hexa-direct",
  name: "Hexa",
  category: "external",
  priority: 23,
  timeoutMs: 15_000,
  isEnabled: (s: Settings) => isDirectExtractorEnabled("hexa-direct", s, ["hexa"]),
  async find(req: PlaybackRequest, _s: Settings, signal: AbortSignal): Promise<StreamCandidate[]> {
    if (signal.aborted) return [];
    const anime = isAnimeRequest(req);
    if (anime && (req.audio ?? "sub") === "dub") return [];

    try {
      const meta = await resolveMediaIds(req, signal);
      if (signal.aborted || !meta.tmdbId) return [];

      const isMovie = isMovieRequest(req);
      const season = req.season ?? 1;
      const episode = req.episode ?? 1;
      const apiUrl = isMovie
        ? `${HEXA_API}/movie/${meta.tmdbId}/images`
        : `${HEXA_API}/tv/${meta.tmdbId}/season/${season}/episode/${episode}/images`;

      let sources: HexaSource[] | null = null;
      for (let attempt = 0; attempt < 2 && !sources; attempt++) {
        const token = await fetchCapToken(signal);
        if (!token || signal.aborted) return [];
        const key = randomHex(32);
        const res = await fetchWithAbort(
          apiUrl,
          {
            "User-Agent": DEFAULT_UA,
            Referer: `${HEXA_ORIGIN}/`,
            Accept: "text/plain",
            "X-Fingerprint-Lite": HEXA_FINGERPRINT,
            "X-Cap-Token": token,
            "X-Api-Key": key,
          },
          undefined,
          signal,
          8_000,
        );
        if (signal.aborted) return [];
        if (res.status === 401 || res.status === 403) {
          // Token rejected (expired early or used up elsewhere): mint a fresh one once.
          clearHexaTokenCache();
          continue;
        }
        if (res.status < 200 || res.status >= 300 || !res.body.trim()) return [];
        const decrypted = await encDec<{ sources?: HexaSource[] }>(
          "dec-hexa",
          { json: { text: res.body.trim(), key } },
          signal,
        );
        if (Array.isArray(decrypted?.sources)) {
          // A valid (possibly empty) list is the answer; an empty one just means "not on Hexa".
          if (decrypted.sources.length === 0) return [];
          sources = decrypted.sources;
        } else {
          // Undecryptable payload (usually a stale token): leave `sources` null so attempt 2 runs fresh.
          clearHexaTokenCache();
        }
      }
      if (!sources?.length || signal.aborted) return [];

      const headers = buildStreamHeaders(`${HEXA_ORIGIN}/`, HEXA_ORIGIN);
      const seen = new Set<string>();
      const out: StreamCandidate[] = [];
      for (const src of sources) {
        const raw = typeof src?.url === "string" ? src.url.trim() : "";
        if (!/^https?:\/\//i.test(raw) || seen.has(raw)) continue;
        seen.add(raw);
        const server = (src.server ?? "").trim();
        const kind = inferStreamKind(raw);
        out.push({
          providerId: "hexa-direct",
          providerName: "Hexa",
          label: `Hexa${server ? ` · ${server.charAt(0).toUpperCase()}${server.slice(1)}` : ""} · ${kind.toUpperCase()}`,
          url: proxyUrl(raw, headers, HEXA_ORIGIN),
          kind,
          via: "direct",
          headers,
          ...(anime ? { audio: "sub" as const } : {}),
        });
      }
      return out;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return [];
      throw err;
    }
  },
};
