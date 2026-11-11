import { isTauri } from "@tauri-apps/api/core";
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
  emailVerified?: boolean;
  /** False for accounts made with Google/Discord until they set one. */
  hasPassword?: boolean;
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
  /** The server can send email (reset codes, verification). */
  mail?: boolean;
  /** Sign-in providers the server has set up, e.g. ["google", "discord"]. */
  oauth?: string[];
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
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { tmdbProxy: false, online: true, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { user: null, accessToken: null, refreshToken: null, tmdbProxy: false, online: true };
}

function set(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
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
  invalid_code: "That code is wrong or has expired. Ask for a new one.",
  mail_disabled: "This server can't send email yet.",
  denied: "Sign-in was cancelled.",
  expired: "That sign-in took too long. Try again.",
  no_email: "That account didn't share an email address.",
  unverified_email: "Verify your email with that service first.",
  provider_error: "The sign-in service didn't answer. Try again.",
  provider_unavailable: "That sign-in option isn't set up on this server.",
  network: "Can't reach the AbixCine server. Check the server address or your connection.",
};
export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? MESSAGES[e.code] ?? `Something went wrong (${e.code}).` : MESSAGES.network;

/** Render's free tier answers 502/503 (or hangs) while the instance boots after sleeping. */
export const isWaking = (e: unknown) => e instanceof ApiError && (e.code === "waking" || e.code === "timeout");

async function raw(path: string, init: RequestInit = {}, token?: string | null, timeoutMs = 15_000) {
  let res: Response;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
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
    if (state.online) set({ online: false });
    throw new ApiError(0, ctl.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(t);
  }
  if (!state.online) set({ online: true });
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new ApiError(res.status, "waking");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  }
  return res.json();
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!state.refreshToken) return false;
  refreshing ??= raw("/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: state.refreshToken }) })
    .then((r) => {
      set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
      return true;
    })
    .catch((e) => {
      // Only sign out when the server rejects the token, not when we're offline.
      if (e instanceof ApiError && e.status === 401) set({ user: null, accessToken: null, refreshToken: null });
      return false;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

/** Authenticated request with one transparent refresh on 401. */
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await raw(path, init, state.accessToken);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refresh())) return raw(path, init, state.accessToken);
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
  await checkServer();
  syncHooks.forEach((h) => h.pull?.());
}

export async function signUp(name: string, email: string, password: string) {
  await finishAuth(await raw("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) }));
}

export async function signIn(email: string, password: string) {
  await finishAuth(await raw("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }));
}

// ---------- password reset, verification, Google/Discord ----------

/** Email a 6-digit reset code (the server answers the same whether or not the account exists). */
export async function forgotPassword(email: string) {
  await raw("/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
}

/** Set a new password with the emailed code and sign in. Every other device is signed out. */
export async function resetPassword(email: string, code: string, password: string) {
  await finishAuth(await raw("/auth/reset", { method: "POST", body: JSON.stringify({ email, code: code.trim(), password }) }));
}

export async function sendVerification() {
  await api("/auth/verify/send", { method: "POST" });
}

export async function verifyEmail(code: string) {
  const r = await api("/auth/verify", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
  set({ user: r.user });
}

/** Change (or set, for Google/Discord accounts) the password. Other devices are signed out. */
export async function changePassword(current: string, password: string) {
  const r = await api("/auth/password", { method: "POST", body: JSON.stringify({ current, password }) });
  set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
}

async function openExternal(url: string) {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

/**
 * "Continue with Google/Discord": opens the provider in the browser and waits (up to 10 minutes)
 * for the server to finish the sign-in. Abort the signal to stop waiting.
 */
export async function signInWith(provider: "google" | "discord", signal?: AbortSignal) {
  const start = await raw(`/auth/oauth/${provider}/start`, { method: "POST" });
  await openExternal(start.url);
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    if (signal?.aborted) throw new ApiError(0, "denied");
    await new Promise((r) => setTimeout(r, 2000));
    let r: any;
    try {
      r = await raw("/auth/oauth/poll", { method: "POST", body: JSON.stringify({ state: start.state, poll: start.poll }) });
    } catch (e) {
      if (isWaking(e) || (e instanceof ApiError && e.status === 0)) continue; // keep waiting through hiccups
      throw e;
    }
    if (r.accessToken) return finishAuth(r);
  }
  throw new ApiError(410, "expired");
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
    if (await checkServer()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function signOut() {
  const rt = state.refreshToken;
  set({ user: null, accessToken: null, refreshToken: null, guest: false });
  clearOutbox();
  syncHooks.forEach((h) => h.clear?.());
  if (rt) raw("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: rt }) }).catch(() => {});
}

export async function updateProfile(patch: { name?: string; avatarHue?: number }) {
  const r = await api("/me", { method: "PATCH", body: JSON.stringify(patch) });
  set({ user: r.user });
}

export async function checkServer() {
  try {
    const h = await raw("/health", {}, null, 10_000);
    set({ tmdbProxy: !!h.tmdbProxy, mail: !!h.mail, oauth: Array.isArray(h.oauth) ? h.oauth : [] });
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
  syncCache ??= api("/sync").finally(() => setTimeout(() => (syncCache = null), 2000));
  return syncCache;
}

// ---------- outbox ----------
// Writes that fail (offline, server asleep) wait here and are replayed before the next pull,
// so a watchlist removal made offline isn't undone by the server's older copy.
const OUTBOX = "abx.outbox.v1";
type Pending = { method: "PUT" | "DELETE"; body?: unknown; at: number };
const readOutbox = (): Record<string, Pending> => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX) || "{}");
  } catch {
    return {};
  }
};
const writeOutbox = (o: Record<string, Pending>) => {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(o));
  } catch {
    /* ignore */
  }
};
function clearOutbox() {
  writeOutbox({});
}
const retryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

/** Write to the server; if it can't be reached, keep the latest write per path and retry later. */
export function push(path: string, method: "PUT" | "DELETE", body?: unknown) {
  if (!state.user) return;
  const o = readOutbox();
  if (o[path]) {
    delete o[path];
    writeOutbox(o);
  }
  api(path, { method, body: body ? JSON.stringify(body) : undefined }).catch((e) => {
    if (retryable(e)) writeOutbox({ ...readOutbox(), [path]: { method, body, at: Date.now() } });
  });
}

let flushing: Promise<void> | null = null;
export function flushOutbox() {
  if (!state.user) return Promise.resolve();
  flushing ??= (async () => {
    const entries = Object.entries(readOutbox()).sort((a, b) => a[1].at - b[1].at);
    for (const [path, p] of entries) {
      try {
        await api(path, { method: p.method, body: p.body ? JSON.stringify(p.body) : undefined });
      } catch (e) {
        if (retryable(e)) break; // still offline: keep the rest
      }
      const o = readOutbox();
      if (o[path]?.at === p.at) {
        delete o[path];
        writeOutbox(o);
      }
    }
  })().finally(() => (flushing = null));
  return flushing;
}

export async function bootAccount() {
  const up = await checkServer();
  if (!state.user) return;
  if (up) await flushOutbox();
  syncHooks.forEach((h) => h.pull?.());
}

// Coming back online: replay queued writes.
if (typeof window !== "undefined") window.addEventListener("online", () => void checkServer().then((up) => (up ? flushOutbox() : undefined)));
