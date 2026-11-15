import { useSyncExternalStore } from "react";

/**
 * Accounts + sync against the AbixCine API (server/ in this repo, hosted on Render).
 * Tokens live in localStorage; the access token is short-lived and refreshed transparently.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  avatarHue: number;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** Server can proxy TMDB, so users don't need their own key. */
  tmdbProxy: boolean;
  online: boolean;
  /** Using the app without an account: everything stays on this PC, nothing syncs. */
  guest?: boolean;
}

const KEY = "abx.auth.v1";
const API_KEY = "abx.api";
export const DEFAULT_API = import.meta.env.VITE_API_URL ?? "https://abixcine-api.onrender.com";

export const getApiBase = () => {
  try {
    return (localStorage.getItem(API_KEY) || DEFAULT_API).replace(/\/$/, "");
  } catch {
    return DEFAULT_API;
  }
};
/** Passwords and tokens go to this address, so it must be https (plain http only for a server on this PC). */
export function validApiBase(url: string) {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname));
  } catch {
    return false;
  }
}
export const setApiBase = (url: string) => {
  if (!validApiBase(url)) return false;
  try {
    localStorage.setItem(API_KEY, url.trim());
  } catch {
    /* ignore */
  }
  return true;
};

const listeners = new Set<() => void>();
let state: AuthState = load();

function load(): AuthState {
  // Dev-only design preview (vite dev server with ?preview): an in-memory guest, never saved
  // and never sent anywhere. Production builds strip this branch.
  if (import.meta.env.DEV && typeof location !== "undefined" && location.search.includes("preview")) {
    return { user: { id: "preview", email: "preview@localhost", name: "Preview", avatarHue: 262, createdAt: "" }, accessToken: null, refreshToken: null, tmdbProxy: false, online: false };
  }
  try {
    const raw = localStorage.getItem(KEY);
    // `online` is a live reading, not a setting: a timeout once saved "offline" for good.
    if (raw) return { tmdbProxy: false, ...JSON.parse(raw), online: true };
  } catch {
    /* ignore */
  }
  return { user: null, accessToken: null, refreshToken: null, tmdbProxy: false, online: true };
}

function persisted(): Partial<AuthState> | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<AuthState>) : null;
  } catch {
    return null;
  }
}

function set(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  try {
    if (state.user?.id !== "preview") {
      const { online: _online, ...keep } = state;
      localStorage.setItem(KEY, JSON.stringify(keep));
    }
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

// Another window signed in, signed out or rotated the tokens: adopt its state, so this one
// never presents a refresh token that has already been spent.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || state.user?.id === "preview") return;
    const next = persisted();
    const signedOut = !next?.user && !!state.user;
    state = { ...state, user: next?.user ?? null, accessToken: next?.accessToken ?? null, refreshToken: next?.refreshToken ?? null, guest: next?.guest };
    if (signedOut) {
      syncCache = null;
      syncHooks.forEach((h) => h.clear?.());
    }
    listeners.forEach((l) => l());
  });
}

export const getAuth = () => state;
export function useAuth() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

const MESSAGES: Record<string, string> = {
  invalid_email: "That email doesn't look right.",
  weak_password: "Use at least 8 characters.",
  email_taken: "An account with that email already exists.",
  bad_credentials: "Wrong email or password.",
  password_too_long: "Use 128 characters or fewer.",
  bad_server: "The server address must start with https://",
  waking: "The AbixCine server is waking up. This takes up to a minute on free hosting.",
  network: "Can't reach the AbixCine server. Check the server address or your connection.",
  timeout: "The AbixCine server took too long to answer. Try again in a moment.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  http_429: "Too many attempts. Wait a few minutes and try again.",
  invalid_refresh: "Your session expired. Sign in again.",
  unauthorized: "Your session expired. Sign in again.",
  watchlist_full: "My List is full. Remove a few titles to add more.",
  bad_request: "The server didn't accept that. Update AbixCine and try again.",
  not_found: "That account no longer exists.",
  server_error: "The AbixCine server hit a problem. Try again in a moment.",
};
export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? MESSAGES[e.code] ?? `Something went wrong (${e.code}).` : MESSAGES.network;

/** Render's free tier answers 502/503 (or hangs) while the instance boots after sleeping. */
export const isWaking = (e: unknown) => e instanceof ApiError && (e.code === "waking" || e.code === "timeout");

async function raw(path: string, init: RequestInit = {}, token?: string | null, timeoutMs = 15_000) {
  const callerSignal = init.signal;
  if (callerSignal?.aborted) {
    throw new ApiError(0, "aborted");
  }
  let res: Response;
  let timedOut = false;
  const ctl = new AbortController();
  const onCallerAbort = () => ctl.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const t = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    res = await fetch(getApiBase() + path, {
      ...init,
      signal: ctl.signal,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    if (callerSignal?.aborted) {
      throw new ApiError(0, "aborted");
    }
    if (state.online) set({ online: false });
    throw new ApiError(0, timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(t);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
  if (!state.online) set({ online: true });
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new ApiError(res.status, "waking");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  }
  return res.json();
}

/** Take the tokens another window has already rotated to, if they are newer than ours. */
function adoptStored(): boolean {
  const stored = persisted();
  if (!stored?.refreshToken || !stored.user || stored.refreshToken === state.refreshToken) return false;
  state = { ...state, user: stored.user, accessToken: stored.accessToken ?? null, refreshToken: stored.refreshToken };
  listeners.forEach((l) => l());
  return true;
}

/** Runs `fn` while holding a lock shared by every AbixCine window (falls through where locks don't exist). */
function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks?.request ? (locks.request("abx.auth.refresh", fn) as Promise<T>) : fn();
}

let refreshing: Promise<boolean> | null = null;
/**
 * Refresh tokens are single-use. Two windows refreshing at once used to mean the slower one
 * presented a spent token, got a 401, and signed the user out everywhere. Now only one window
 * refreshes at a time, the others pick up its result, and a 401 only signs out if nobody else
 * has rotated the token in the meantime.
 */
async function refresh(failedToken?: string | null): Promise<boolean> {
  if (!state.refreshToken) return false;
  refreshing ??= withAuthLock(async () => {
    // Someone else refreshed while we waited for the lock (or before we noticed the 401).
    if (adoptStored()) return true;
    if (failedToken && state.accessToken && state.accessToken !== failedToken) return true;
    const sent = state.refreshToken;
    if (!sent) return false;
    try {
      const r = await raw("/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: sent }) });
      set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
      return true;
    } catch (e) {
      // Only sign out when the server rejects the token, not when we're offline.
      if (e instanceof ApiError && e.status === 401) {
        if (adoptStored()) return true;
        if (state.refreshToken === sent) {
          set({ user: null, accessToken: null, refreshToken: null });
          syncCache = null;
        }
      }
      return false;
    }
  }).finally(() => (refreshing = null));
  return refreshing;
}

/** Authenticated request with one transparent refresh on 401. */
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const used = state.accessToken;
  try {
    return await raw(path, init, used);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refresh(used))) return raw(path, init, state.accessToken);
    throw e;
  }
}

async function finishAuth(r: { user: User; accessToken: string; refreshToken: string }) {
  set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken, guest: false });
  try {
    localStorage.setItem("abx.hadAccount", "1");
  } catch {
    /* ignore */
  }
  syncCache = null;
  await checkServer();
  // Anything saved while signed out (or as a guest) goes up before the server's copy comes down.
  await flushOutbox();
  syncHooks.forEach((h) => h.pull?.());
}

export async function signUp(name: string, email: string, password: string) {
  await finishAuth(await raw("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) }));
}

export async function signIn(email: string, password: string) {
  await finishAuth(await raw("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }));
}

/** Use AbixCine without an account. Local folders and Jellyfin work; progress stays on this PC. */
export function continueAsGuest() {
  set({ guest: true });
}

/** Guest → sign-in screen, keeping everything saved on this PC (it merges up on sign-in). */
export function leaveGuest() {
  set({ guest: false });
}

export const hadAccount = () => {
  try {
    return localStorage.getItem("abx.hadAccount") === "1";
  } catch {
    return false;
  }
};

/**
 * Poll /health until the server answers (free Render instances take up to ~60s to boot).
 * `onTick` gets elapsed seconds so the UI can show progress. Resolves false after `maxMs`.
 */
export async function wakeServer(onTick?: (secs: number) => void, maxMs = 90_000, signal?: AbortSignal) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs && !signal?.aborted) {
    onTick?.(Math.round((Date.now() - t0) / 1000));
    if (await checkServer(signal)) return !signal?.aborted;
    if (signal?.aborted) return false;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 3000);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  return false;
}

export async function signOut() {
  const rt = state.refreshToken;
  set({ user: null, accessToken: null, refreshToken: null, guest: false });
  // The next account to sign in on this PC must never be handed this one's /sync answer.
  syncCache = null;
  clearOutbox();
  syncHooks.forEach((h) => h.clear?.());
  if (rt) raw("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: rt }) }).catch(() => {});
}

export async function updateProfile(patch: { name?: string; avatarHue?: number }) {
  const r = await api("/me", { method: "PATCH", body: JSON.stringify(patch) });
  set({ user: r.user });
}

export async function checkServer(signal?: AbortSignal) {
  if (signal?.aborted) return false;
  try {
    const h = await raw("/health", { signal }, null, 10_000);
    set({ tmdbProxy: !!h.tmdbProxy });
    return true;
  } catch {
    return false;
  }
}

/** Stores register here to pull server state on sign-in and clear on sign-out. */
interface SyncHook {
  pull?: () => void;
  clear?: () => void;
}
const syncHooks: SyncHook[] = [];
export const registerSync = (h: SyncHook) => syncHooks.push(h);

let syncCache: Promise<any> | null = null;
/** One /sync request shared by all stores that pull at the same moment. */
export function fetchSync() {
  if (!syncCache) {
    const p = api("/sync").then(
      (res) => {
        // Shared only by stores pulling in the same tick; never held past the answer.
        if (syncCache === p) syncCache = null;
        return res;
      },
      (err) => {
        if (syncCache === p) syncCache = null;
        throw err;
      },
    );
    syncCache = p;
  }
  return syncCache;
}

// ---------- outbox ----------
// Writes that fail (offline, server asleep) wait here and are replayed before the next pull,
// so a watchlist removal made offline isn't undone by the server's older copy.
const OUTBOX = "abx.outbox.v1";
type Pending = { method: "PUT" | "DELETE"; body?: unknown; at: number };
/** Held in memory too, so a full disk doesn't silently drop writes for the rest of the session. */
let outboxMem: Record<string, Pending> | null = null;
const readOutbox = (): Record<string, Pending> => {
  if (outboxMem) return { ...outboxMem };
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX) || "{}");
    outboxMem = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    outboxMem = {};
  }
  return { ...outboxMem };
};
const writeOutbox = (o: Record<string, Pending>) => {
  outboxMem = o;
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(o));
  } catch {
    /* storage full or blocked: the in-memory copy still replays this session */
  }
};
function clearOutbox() {
  writeOutbox({});
}
const retryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

/** Each queued write gets a strictly increasing stamp, so a newer write to a path is never mistaken for an older one. */
let lastStamp = 0;
let kickQueued = false;
/** Writes are waiting that no send has picked up yet. */
let dirty = false;

/**
 * Write to the server; if it can't be reached, keep the latest write per path and retry later.
 * Writes made in the same tick (a list import, every title's position when the app closes) go up
 * together in one request; a lone write is sent as before.
 */
export function push(path: string, method: "PUT" | "DELETE", body?: unknown) {
  if (!state.user) return;
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  writeOutbox({ ...readOutbox(), [path]: { method, body, at: lastStamp } });
  dirty = true;
  if (kickQueued) return;
  kickQueued = true;
  queueMicrotask(() => {
    kickQueued = false;
    void flushOutbox();
  });
}

const BATCH_MAX = 25;
/** An older server without /sync/batch: send one by one for the rest of the session. */
let batchUnsupported = false;

function settle(path: string, at: number) {
  const o = readOutbox();
  if (o[path]?.at === at) {
    delete o[path];
    writeOutbox(o);
  }
}

/** Send one write. False when the server couldn't be reached (the write stays queued). */
async function sendOne(path: string, p: Pending): Promise<boolean> {
  try {
    await api(path, { method: p.method, body: p.body ? JSON.stringify(p.body) : undefined });
  } catch (e) {
    if (retryable(e)) return false;
    // Refused for good (bad data, list full): retrying would never succeed.
  }
  settle(path, p.at);
  return true;
}

/** Send queued writes oldest first. True when sending stalled (offline): the rest stay queued, in order. */
async function sendQueued(entries: [string, Pending][]): Promise<boolean> {
  if (entries.length === 1 || batchUnsupported) {
    for (const [path, p] of entries) if (!(await sendOne(path, p))) return true;
    return false;
  }
  for (let i = 0; i < entries.length; i += BATCH_MAX) {
    const chunk = entries.slice(i, i + BATCH_MAX);
    let res: { results?: { status?: number }[] } | undefined;
    try {
      res = await api("/sync/batch", {
        method: "POST",
        body: JSON.stringify({ ops: chunk.map(([path, p]) => ({ path, method: p.method, body: p.body })) }),
      });
    } catch (e) {
      if (retryable(e)) return true;
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) batchUnsupported = true;
      // Not understood as a whole: fall back to one by one for what is left.
      for (const [path, p] of entries.slice(i)) if (!(await sendOne(path, p))) return true;
      return false;
    }
    const results = Array.isArray(res?.results) ? res.results : [];
    for (let j = 0; j < chunk.length; j++) {
      const st = results[j]?.status;
      // The server stopped here (its own error): keep this write and everything after it.
      if (typeof st !== "number" || st >= 500) return true;
      settle(chunk[j][0], chunk[j][1].at);
    }
  }
  return false;
}

let flushing: Promise<void> | null = null;
let stalled = false;
export function flushOutbox(): Promise<void> {
  if (!state.user) return Promise.resolve();
  dirty = true;
  flushing ??= (async () => {
    stalled = false;
    while (dirty && !stalled) {
      dirty = false;
      const entries = Object.entries(readOutbox()).sort((a, b) => a[1].at - b[1].at);
      if (!entries.length) break;
      stalled = await sendQueued(entries);
    }
  })().finally(() => {
    flushing = null;
    // A write queued just as the last send finished: pick it up now rather than at the next resync.
    if (dirty && !stalled) void flushOutbox();
  });
  return flushing;
}

/** Queued writes first, then the server's copy: pulling first would undo what was done offline. */
async function resync() {
  if (!state.user) return;
  await flushOutbox();
  syncHooks.forEach((h) => h.pull?.());
}

export async function bootAccount() {
  if (await checkServer()) return resync();
  // A sleeping free-tier server takes up to a minute to boot: keep knocking in the background and
  // sync once it answers, instead of skipping this session's sync after one 10 s timeout.
  if (state.user && (await wakeServer(undefined, 120_000))) await resync();
}

// Coming back online: replay queued writes, then catch up with other devices.
if (typeof window !== "undefined") window.addEventListener("online", () => void checkServer().then((up) => (up ? resync() : undefined)));
