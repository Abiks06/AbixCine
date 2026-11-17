/** YouTube video ids are 11 chars of [A-Za-z0-9_-]; anything else is not embeddable. */
export const isYouTubeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);

/**
 * The trailer embed URL. `origin` + `enablejsapi` let the player post its state/errors back to
 * us; the privacy-enhanced host keeps YouTube cookies out of the app.
 * The iframe must also send a Referer (referrerPolicy "strict-origin-when-cross-origin"): without
 * one YouTube answers "Error 153 – video player configuration error".
 */
export function trailerEmbedUrl(id: string, origin?: string): string {
  const p = new URLSearchParams({
    autoplay: "1",
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
    iv_load_policy: "3",
    enablejsapi: "1",
  });
  if (origin && /^https?:\/\/[^/]+$/i.test(origin)) p.set("origin", origin);
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${p}`;
}

export const trailerWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** Embeds YouTube refuses to play in an iframe (owner disabled embedding, removed, config). */
const FATAL = new Set([2, 5, 100, 101, 150, 152, 153]);

export type TrailerSignal = { kind: "ready" } | { kind: "error"; code: number } | null;

/** Parse a message from the YouTube iframe API (JSON strings like `{"event":"onError","info":153}`). */
export function parseTrailerMessage(data: unknown): TrailerSignal {
  let msg: unknown = data;
  if (typeof data === "string") {
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== "object") return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event === "onReady" || event === "initialDelivery") return { kind: "ready" };
  if (event === "onError") {
    const code = Number(info);
    return FATAL.has(code) ? { kind: "error", code } : null;
  }
  if (event === "infoDelivery" && info && typeof info === "object") {
    const state = (info as { playerState?: unknown }).playerState;
    if (state === 1 || state === 3) return { kind: "ready" };
  }
  return null;
}

export const isYouTubeOrigin = (origin: string) =>
  /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com$/i.test(origin);
