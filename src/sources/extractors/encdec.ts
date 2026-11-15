import { DEFAULT_UA } from "../native";
import { abortError, fetchWithAbort, isAbortError } from "./common";

/**
 * Shared client for the `enc-dec.app` crypto microservice (`smy778/EncDecEndpoints`), used by
 * Hexa, Vidup, Cinejoy, MeowTV, VidLink and KissKH, whose sites rotate their client-side crypto.
 *
 * - A 3-slot queue: a session starts every extractor at once, and an unthrottled burst of ~15
 *   calls is exactly what makes the service answer 429.
 * - One jittered retry on 429.
 * - The outage cooldown opens only after 3 consecutive transport/5xx failures, so a single slow
 *   reply doesn't take down every dependent extractor for a minute.
 * - Outage errors carry `dependencyOutage`, which the session reads to keep them out of each
 *   provider's circuit breaker: the provider isn't broken, a service it shares is.
 */
export const ENC_DEC_API = "https://enc-dec.app/api";
const ENC_DEC_COOLDOWN_MS = 60_000;
const ENC_DEC_TIMEOUT_MS = 7_000;
const FAILURES_TO_COOL_DOWN = 3;
const MAX_CONCURRENT = 3;
const RETRY_BASE_MS = 400;

let downUntil = 0;
let consecutiveFailures = 0;
let active = 0;
const waiters: (() => void)[] = [];

/** Reset the shared outage state and queue (unit tests). */
export function resetEncDecCooldown(): void {
  downUntil = 0;
  consecutiveFailures = 0;
}

export function encDecAvailable(now = Date.now()): boolean {
  return now >= downUntil;
}

export class EncDecUnavailableError extends Error {
  /** Read by the session: a shared-dependency outage must not open the provider's own circuit. */
  readonly dependencyOutage = true;
  constructor(detail: string) {
    super(`enc-dec.app unavailable: ${detail}`);
    this.name = "EncDecUnavailableError";
  }
}

function noteFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURES_TO_COOL_DOWN) {
    downUntil = Date.now() + ENC_DEC_COOLDOWN_MS;
    consecutiveFailures = 0;
  }
}

async function acquire(signal: AbortSignal): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener("abort", onAbort);
      active += 1;
      resolve();
    };
    const onAbort = () => {
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      reject(abortError(signal));
    };
    waiters.push(grant);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function release(): void {
  active = Math.max(0, active - 1);
  waiters.shift()?.();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Call an `enc-dec.app` endpoint. Returns its `result` when the service answers successfully,
 * `null` when it answers but cannot handle the input, and throws when the service is unreachable
 * (an `EncDecUnavailableError`) or the signal aborts.
 */
export async function encDec<T>(
  path: string,
  opts: { query?: Record<string, string>; json?: unknown },
  signal: AbortSignal = new AbortController().signal,
  timeoutMs = ENC_DEC_TIMEOUT_MS,
): Promise<T | null> {
  if (!encDecAvailable()) throw new EncDecUnavailableError("cooling down after repeated failures");

  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const url = `${ENC_DEC_API}/${path}${qs}`;
  const headers: Record<string, string> = { "User-Agent": DEFAULT_UA, Accept: "application/json" };
  let init: { method?: string; body?: string } | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    init = { method: "POST", body: JSON.stringify(opts.json) };
  }

  await acquire(signal);
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<typeof fetchWithAbort>>;
      try {
        res = await fetchWithAbort(url, headers, init, signal, timeoutMs);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        noteFailure();
        throw new EncDecUnavailableError(err instanceof Error ? err.message : "network error");
      }

      if (res.status === 429 && attempt === 0) {
        await sleep(RETRY_BASE_MS + Math.random() * RETRY_BASE_MS, signal);
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        noteFailure();
        throw new EncDecUnavailableError(`HTTP ${res.status}`);
      }
      consecutiveFailures = 0;
      if (res.status < 200 || res.status >= 300) return null;

      try {
        const parsed = JSON.parse(res.body) as { status?: number; result?: T };
        const ok = parsed?.status === undefined || parsed.status === 200;
        return ok && parsed?.result != null ? parsed.result : null;
      } catch {
        return null;
      }
    }
  } finally {
    release();
  }
}
