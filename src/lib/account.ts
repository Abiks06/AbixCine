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
export const setApiBase = (url: string) => {
  try {
    localStorage.setItem(API_KEY, url.trim());
  } catch {
    /* ignore */
  }
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
    if (raw) return { tmdbProxy: false, online: true, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { user: null, accessToken: null, refreshToken: null, tmdbProxy: false, online: true };
}

function set(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  try {
    if (state.user?.id !== "preview") localStorage.setItem(KEY, JSON.stringify(state));
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
  network: "Can't reach the AbixCine server. Check the server address or your connection.",
};
export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? MESSAGES[e.code] ?? `Something went wrong (${e.code}).` : MESSAGES.network;

async function raw(path: string, init: RequestInit = {}, token?: string | null) {
  let res: Response;
  try {
    res = await fetch(getApiBase() + path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    if (state.online) set({ online: false });
    throw new ApiError(0, "network");
  }
  if (!state.online) set({ online: true });
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
  set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
  await checkServer();
  syncHooks.forEach((h) => h.pull?.());
}

export async function signUp(name: string, email: string, password: string) {
  await finishAuth(await raw("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) }));
}

export async function signIn(email: string, password: string) {
  await finishAuth(await raw("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }));
}

export async function signOut() {
  const rt = state.refreshToken;
  set({ user: null, accessToken: null, refreshToken: null });
  syncHooks.forEach((h) => h.clear?.());
  if (rt) raw("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: rt }) }).catch(() => {});
}

export async function updateProfile(patch: { name?: string; avatarHue?: number }) {
  const r = await api("/me", { method: "PATCH", body: JSON.stringify(patch) });
  set({ user: r.user });
}

export async function checkServer() {
  try {
    const h = await raw("/health");
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
  syncCache ??= api("/sync").finally(() => setTimeout(() => (syncCache = null), 2000));
  return syncCache;
}

/** Fire-and-forget write; failures are retried on the next change or launch. */
export function push(path: string, method: "PUT" | "DELETE", body?: unknown) {
  if (!state.user) return;
  api(path, { method, body: body ? JSON.stringify(body) : undefined }).catch(() => {});
}

export function bootAccount() {
  checkServer();
  if (state.user) syncHooks.forEach((h) => h.pull?.());
}
