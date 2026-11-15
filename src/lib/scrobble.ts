import { useSyncExternalStore } from "react";
import { httpFetch } from "../sources/native";
import type { MediaDetail } from "./types";
import { isFilm } from "./types";

/**
 * Scrobbling: when you finish a film or an episode, tell the trackers you've connected.
 *
 *   AniList  your list's progress for that show (or the film marked completed)
 *   Trakt    the play added to your history
 *   SIMKL    the same, to your SIMKL history
 *
 * Each needs its own API app (a client ID, and for Trakt a secret too), made on that site and
 * pasted into Settings: AbixCine ships none, and tokens stay on this PC (never synced). A finish
 * that can't be sent (offline) waits in a short queue and goes with the next one.
 */
export type Service = "anilist" | "trakt" | "simkl";

export interface Connection {
  clientId: string;
  clientSecret?: string;
  token: string;
  refreshToken?: string;
  /** Epoch ms the token stops working, when the service says. */
  expiresAt?: number;
  user?: string;
}

/** One finished film or episode, with every ID the trackers might match on. */
export interface Watched {
  title: string;
  film: boolean;
  tmdb?: { kind: "movie" | "tv"; id: number };
  season?: number;
  episode?: number;
  /** The specific AniList entry (a season or cour) and the episode number within it. */
  anilistId?: number;
  malId?: number;
  entryEpisode?: number;
  entryEpisodes?: number;
  at: number;
}

interface Store {
  conns: Partial<Record<Service, Connection>>;
  /** Finishes already sent (service + item), newest last, so a rewatch tick doesn't repeat one. */
  sent: string[];
  queue: Watched[];
  last?: Partial<Record<Service, { ok: boolean; at: number; note?: string }>>;
}

const KEY = "abx.scrobble.v1";
const MAX_SENT = 400;
const MAX_QUEUE = 50;
const listeners = new Set<() => void>();

function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Store> | null;
    if (raw && typeof raw === "object") return { conns: raw.conns ?? {}, sent: Array.isArray(raw.sent) ? raw.sent : [], queue: Array.isArray(raw.queue) ? raw.queue : [], last: raw.last ?? {} };
  } catch {
    /* corrupt */
  }
  return { conns: {}, sent: [], queue: [], last: {} };
}
let store = load();

function save(next: Store) {
  store = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage full: memory copy still works this session */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
export const useScrobble = () => useSyncExternalStore(subscribe, () => store);
export const connection = (s: Service) => store.conns[s];

export function disconnect(s: Service) {
  const { [s]: _, ...rest } = store.conns;
  save({ ...store, conns: rest });
}

function setConnection(s: Service, c: Connection) {
  save({ ...store, conns: { ...store.conns, [s]: c }, last: { ...store.last, [s]: { ok: true, at: Date.now(), note: "Connected" } } });
}

function note(s: Service, ok: boolean, msg?: string) {
  save({ ...store, last: { ...store.last, [s]: { ok, at: Date.now(), note: msg } } });
}

/* ------------------------------------------------------------------ */
/* What was watched                                                    */
/* ------------------------------------------------------------------ */

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const idOf = (key: string | undefined, prefix: string) => (key?.startsWith(prefix) ? num(Number(key.slice(prefix.length))) : undefined);

/** The IDs for one finished film or episode of a title, as the player knows it. */
export function watchedFrom(d: MediaDetail, key: string, season?: number, episode?: number): Watched {
  const film = isFilm(d);
  const out: Watched = { title: d.title, film, at: Date.now() };
  const movie = idOf(key, "tmdb:movie:") ?? idOf(d.key, "tmdb:movie:");
  const tv = idOf(key, "tmdb:tv:") ?? idOf(d.key, "tmdb:tv:");
  if (movie) out.tmdb = { kind: "movie", id: movie };
  else if (tv) out.tmdb = { kind: "tv", id: tv };
  else if (num(d.tmdbId)) out.tmdb = { kind: film ? "movie" : "tv", id: d.tmdbId! };
  if (!film) {
    out.season = season;
    out.episode = episode;
  }

  // Anime: find the AniList entry that holds this episode (a season, or one cour of it).
  const anilist = idOf(key, "anilist:") ?? idOf(d.key, "anilist:");
  if (anilist || d.kind === "anime") {
    const s = d.seasons?.find((x) => x.number === season) ?? d.specials?.find((x) => x.number === season);
    const cour = s?.cours?.find((c) => episode != null && episode >= c.startEpisode && episode <= c.endEpisode);
    if (cour) {
      out.anilistId = cour.anilistId ?? idOf(cour.key, "anilist:");
      out.malId = cour.malId;
      out.entryEpisode = episode! - cour.startEpisode + 1;
      out.entryEpisodes = cour.episodeCount;
    } else if (s) {
      out.anilistId = s.anilistId ?? idOf(s.key, "anilist:");
      out.malId = s.malId;
      out.entryEpisode = episode;
      out.entryEpisodes = s.episodeCount;
    } else {
      out.anilistId = anilist;
      out.malId = d.malId;
      out.entryEpisode = film ? 1 : episode;
      out.entryEpisodes = film ? 1 : num(d.episodeCount);
    }
    if (film) {
      out.entryEpisode = 1;
      out.entryEpisodes = 1;
    }
  }
  return out;
}

const itemId = (w: Watched) =>
  w.anilistId ? `al${w.anilistId}e${w.entryEpisode ?? 1}` : w.tmdb ? `${w.tmdb.kind}${w.tmdb.id}s${w.season ?? 0}e${w.episode ?? 0}` : `t${w.title}s${w.season ?? 0}e${w.episode ?? 0}`;

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

class Offline extends Error {}

async function call(url: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  let r;
  try {
    r = await httpFetch(url, { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, { method, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Offline("unreachable");
  }
  if (r.status === 0 || r.status >= 500 || r.status === 429) throw new Offline(`HTTP ${r.status}`);
  let json: unknown = null;
  try {
    json = r.body ? JSON.parse(r.body) : null;
  } catch {
    /* not JSON */
  }
  return { status: r.status, json: json as Record<string, any> | null };
}

/* AniList ------------------------------------------------------------ */

const ANILIST = "https://graphql.anilist.co";

async function anilistGql(token: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await call(ANILIST, { Authorization: `Bearer ${token}` }, "POST", { query, variables });
  if (r.status === 401 || r.status === 400) throw new Error(r.json?.errors?.[0]?.message ?? "AniList refused the token");
  if (r.status !== 200) throw new Error(`AniList answered ${r.status}`);
  return r.json?.data as Record<string, any>;
}

export function anilistAuthorizeUrl(clientId: string) {
  return `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token`;
}

/** AniList: paste the token its PIN page shows after authorizing. */
export async function connectAnilist(clientId: string, token: string) {
  const t = token.trim();
  const d = await anilistGql(t, `query { Viewer { name } }`);
  setConnection("anilist", { clientId: clientId.trim(), token: t, user: d?.Viewer?.name, expiresAt: Date.now() + 360 * 86400_000 });
}

async function sendAnilist(c: Connection, w: Watched) {
  if (!w.anilistId) return "skip";
  const d = await anilistGql(c.token, `query($id:Int){ Media(id:$id){ episodes mediaListEntry { progress status } } }`, { id: w.anilistId });
  const have = d?.Media?.mediaListEntry as { progress?: number; status?: string } | null;
  const total = num(d?.Media?.episodes) ?? w.entryEpisodes;
  const progress = w.entryEpisode ?? 1;
  // Never move a list backwards (rewatching an early episode), and leave completed shows alone.
  if (have && ((have.progress ?? 0) >= progress || have.status === "COMPLETED")) return "ok";
  const status = total && progress >= total ? "COMPLETED" : "CURRENT";
  await anilistGql(c.token, `mutation($id:Int,$p:Int,$s:MediaListStatus){ SaveMediaListEntry(mediaId:$id, progress:$p, status:$s){ id } }`, { id: w.anilistId, p: progress, s: status });
  return "ok";
}

/* Trakt -------------------------------------------------------------- */

const TRAKT = "https://api.trakt.tv";
const traktHeaders = (c: { clientId: string; token?: string }) => ({
  "trakt-api-version": "2",
  "trakt-api-key": c.clientId,
  ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
});

export interface DeviceCode {
  userCode: string;
  url: string;
  /** Stop polling after this (epoch ms). */
  expiresAt: number;
  intervalMs: number;
  /** Resolves when the code is approved and the account connected; rejects on expiry, denial or abort. */
  done: Promise<void>;
}

function poll(intervalMs: number, expiresAt: number, signal: AbortSignal | undefined, step: () => Promise<"wait" | "slow" | "done">) {
  return new Promise<void>((resolve, reject) => {
    let wait = intervalMs;
    const tick = async () => {
      if (signal?.aborted) return reject(new DOMException("Cancelled", "AbortError"));
      if (Date.now() > expiresAt) return reject(new Error("The code expired. Start again."));
      try {
        const r = await step();
        if (r === "done") return resolve();
        if (r === "slow") wait += 1000;
      } catch (e) {
        if (!(e instanceof Offline)) return reject(e);
      }
      setTimeout(tick, wait);
    };
    setTimeout(tick, wait);
  });
}

/** Trakt: device code. Show `userCode`, open `url`; `done` resolves once you approve it there. */
export async function connectTrakt(clientId: string, clientSecret: string, signal?: AbortSignal): Promise<DeviceCode> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  const r = await call(`${TRAKT}/oauth/device/code`, traktHeaders({ clientId: id }), "POST", { client_id: id });
  if (r.status !== 200 || !r.json?.device_code) throw new Error(r.status === 401 || r.status === 403 ? "Trakt didn't accept that client ID" : `Trakt answered ${r.status}`);
  const code = String(r.json.device_code);
  const expiresAt = Date.now() + (num(r.json.expires_in) ?? 600) * 1000;
  const intervalMs = (num(r.json.interval) ?? 5) * 1000;
  const done = poll(intervalMs, expiresAt, signal, async () => {
    const t = await call(`${TRAKT}/oauth/device/token`, traktHeaders({ clientId: id }), "POST", { code, client_id: id, client_secret: secret });
    if (t.status === 200 && t.json?.access_token) {
      const created = num(t.json.created_at) ? t.json.created_at * 1000 : Date.now();
      const conn: Connection = { clientId: id, clientSecret: secret, token: t.json.access_token, refreshToken: t.json.refresh_token, expiresAt: created + (num(t.json.expires_in) ?? 7776000) * 1000 };
      const me = await call(`${TRAKT}/users/settings`, traktHeaders(conn)).catch(() => null);
      setConnection("trakt", { ...conn, user: me?.json?.user?.username });
      return "done";
    }
    if (t.status === 400) return "wait"; // not approved yet
    if (t.status === 429) return "slow";
    if (t.status === 418) throw new Error("The code was denied on Trakt.");
    if (t.status === 410 || t.status === 404) throw new Error("The code expired. Start again.");
    if (t.status === 409) throw new Error("That code was already used.");
    throw new Error(t.status === 401 ? "Trakt didn't accept that client secret" : `Trakt answered ${t.status}`);
  });
  return { userCode: String(r.json.user_code), url: String(r.json.verification_url ?? "https://trakt.tv/activate"), expiresAt, intervalMs, done };
}

async function traktToken(c: Connection): Promise<Connection> {
  if (!c.refreshToken || !c.clientSecret || !c.expiresAt || c.expiresAt - Date.now() > 86400_000) return c;
  const r = await call(`${TRAKT}/oauth/token`, traktHeaders({ clientId: c.clientId }), "POST", {
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
    grant_type: "refresh_token",
  });
  if (r.status !== 200 || !r.json?.access_token) return c;
  const next = { ...c, token: r.json.access_token, refreshToken: r.json.refresh_token ?? c.refreshToken, expiresAt: Date.now() + (num(r.json.expires_in) ?? 7776000) * 1000 };
  save({ ...store, conns: { ...store.conns, trakt: next } });
  return next;
}

/** The history body Trakt and SIMKL both read. */
function historyBody(w: Watched, anime: boolean) {
  const watched_at = new Date(w.at).toISOString();
  if (anime && w.malId && !w.tmdb) {
    return w.film
      ? { movies: [{ title: w.title, ids: { mal: w.malId }, watched_at }] }
      : { shows: [{ title: w.title, ids: { mal: w.malId }, seasons: [{ number: 1, episodes: [{ number: w.entryEpisode ?? w.episode ?? 1, watched_at }] }] }] };
  }
  if (!w.tmdb) return null;
  if (w.film || w.tmdb.kind === "movie") return { movies: [{ title: w.title, ids: { tmdb: w.tmdb.id }, watched_at }] };
  if (w.episode == null) return null;
  return { shows: [{ title: w.title, ids: { tmdb: w.tmdb.id }, seasons: [{ number: w.season ?? 1, episodes: [{ number: w.episode, watched_at }] }] }] };
}

async function sendTrakt(c: Connection, w: Watched) {
  const body = historyBody(w, false);
  if (!body) return "skip";
  const conn = await traktToken(c);
  const r = await call(`${TRAKT}/sync/history`, traktHeaders(conn), "POST", body);
  if (r.status === 401 || r.status === 403) throw new Error("Trakt sign-in expired: connect again");
  if (r.status !== 201 && r.status !== 200) throw new Error(`Trakt answered ${r.status}`);
  return "ok";
}

/* SIMKL -------------------------------------------------------------- */

const SIMKL = "https://api.simkl.com";

/** SIMKL: PIN code. Show `userCode`, open `url`; `done` resolves once you approve it there. */
export async function connectSimkl(clientId: string, signal?: AbortSignal): Promise<DeviceCode> {
  const id = clientId.trim();
  const r = await call(`${SIMKL}/oauth/pin?client_id=${encodeURIComponent(id)}`, { "simkl-api-key": id });
  if (r.status !== 200 || !r.json?.user_code) throw new Error(r.status === 401 || r.status === 403 ? "SIMKL didn't accept that client ID" : `SIMKL answered ${r.status}`);
  const userCode = String(r.json.user_code);
  const expiresAt = Date.now() + (num(r.json.expires_in) ?? 900) * 1000;
  const intervalMs = (num(r.json.interval) ?? 5) * 1000;
  const done = poll(intervalMs, expiresAt, signal, async () => {
    const t = await call(`${SIMKL}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(id)}`, { "simkl-api-key": id });
    if (t.json?.result === "OK" && t.json.access_token) {
      const conn: Connection = { clientId: id, token: t.json.access_token };
      const me = await call(`${SIMKL}/users/settings`, { "simkl-api-key": id, Authorization: `Bearer ${conn.token}` }, "POST").catch(() => null);
      setConnection("simkl", { ...conn, user: me?.json?.user?.name });
      return "done";
    }
    if (t.status === 404) throw new Error("The code expired. Start again.");
    return "wait";
  });
  return { userCode, url: String(r.json.verification_uri ?? r.json.verification_url ?? "https://simkl.com/pin"), expiresAt, intervalMs, done };
}

async function sendSimkl(c: Connection, w: Watched) {
  const body = historyBody(w, !!w.anilistId);
  if (!body) return "skip";
  const r = await call(`${SIMKL}/sync/history`, { "simkl-api-key": c.clientId, Authorization: `Bearer ${c.token}` }, "POST", body);
  if (r.status === 401 || r.status === 403) throw new Error("SIMKL sign-in expired: connect again");
  if (r.status !== 201 && r.status !== 200) throw new Error(`SIMKL answered ${r.status}`);
  return "ok";
}

/* ------------------------------------------------------------------ */

const senders: Record<Service, (c: Connection, w: Watched) => Promise<"ok" | "skip">> = {
  anilist: sendAnilist,
  trakt: sendTrakt,
  simkl: sendSimkl,
};

let running: Promise<void> | null = null;

async function drain() {
  // Each queued finish goes to every connected service it hasn't reached yet.
  for (const w of [...store.queue]) {
    let offline = false;
    for (const s of Object.keys(store.conns) as Service[]) {
      const c = store.conns[s];
      const id = `${s}:${itemId(w)}`;
      if (!c || store.sent.includes(id)) continue;
      try {
        const r = await senders[s](c, w);
        save({ ...store, sent: [...store.sent, id].slice(-MAX_SENT) });
        if (r === "ok") note(s, true, `Sent: ${w.title}${w.episode != null && !w.film ? ` · episode ${w.entryEpisode ?? w.episode}` : ""}`);
      } catch (e) {
        if (e instanceof Offline) {
          offline = true;
          continue;
        }
        // A refusal won't get better by retrying: record it and move on.
        save({ ...store, sent: [...store.sent, id].slice(-MAX_SENT) });
        note(s, false, e instanceof Error ? e.message : "failed");
      }
    }
    if (offline) return; // keep it (and the rest) for next time
    save({ ...store, queue: store.queue.filter((q) => q !== w) });
  }
}

/** A film or episode was watched to the end: send it to every connected tracker. */
export function scrobble(w: Watched) {
  if (!Object.keys(store.conns).length) return;
  if (store.queue.some((q) => itemId(q) === itemId(w))) return;
  save({ ...store, queue: [...store.queue, w].slice(-MAX_QUEUE) });
  kick();
}

/** Retry anything queued (at boot, coming back online). */
export function kick() {
  if (!store.queue.length || !Object.keys(store.conns).length) return;
  running ??= drain()
    .catch(() => {})
    .finally(() => (running = null));
}

if (typeof window !== "undefined") window.addEventListener("online", kick);
