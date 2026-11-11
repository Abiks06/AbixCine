import { readFile } from "node:fs/promises";

/**
 * Anime ID map: AniList ↔ MyAnimeList ↔ TMDB ↔ TVDB ↔ IMDb, from the community-maintained
 * Fribb/anime-lists dataset (about 40k entries, refreshed daily upstream). The server holds it
 * once in memory so every app gets instant lookups without downloading 6 MB itself.
 *
 * Used for: playing anime from Jellyfin/Plex libraries organised by TMDB/TVDB, merging the TMDB
 * and AniList copies of the same show, season numbers for sequels ("Season 2" is AniList id X,
 * TVDB season 2), and MyAnimeList ids for AniSkip.
 */
const SOURCE = process.env.ANIME_LIST_URL ?? "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 10 * 60_000;

let maps = null;
let loadedAt = 0;
let failedAt = 0;
let loading = null;

/** Keep only what lookups need. */
export function slim(e) {
  const tmdb = e.themoviedb_id ?? {};
  return {
    anilist: e.anilist_id ?? null,
    mal: e.mal_id ?? null,
    tmdbTv: typeof tmdb === "number" ? null : tmdb.tv ?? null,
    tmdbMovie: typeof tmdb === "number" ? tmdb : tmdb.movie ?? null,
    tvdb: e.tvdb_id ?? e.thetvdb_id ?? null,
    imdb: Array.isArray(e.imdb_id) ? e.imdb_id[0] ?? null : e.imdb_id ?? null,
    type: e.type ?? null,
    season: e.season ? { tvdb: e.season.tvdb ?? null, tmdb: e.season.tmdb ?? null } : null,
  };
}

export function buildMaps(list) {
  const byAnilist = new Map();
  const byTmdbTv = new Map();
  const byTmdbMovie = new Map();
  const byMal = new Map();
  for (const raw of list) {
    const e = slim(raw);
    if (e.anilist) byAnilist.set(e.anilist, e);
    if (e.mal) byMal.set(e.mal, e);
    if (e.tmdbTv) (byTmdbTv.get(e.tmdbTv) ?? byTmdbTv.set(e.tmdbTv, []).get(e.tmdbTv)).push(e);
    if (e.tmdbMovie) (byTmdbMovie.get(e.tmdbMovie) ?? byTmdbMovie.set(e.tmdbMovie, []).get(e.tmdbMovie)).push(e);
  }
  // Seasons in order, so "the anime for TMDB show X" is its first season.
  const order = (a, b) => (a.season?.tmdb ?? 99) - (b.season?.tmdb ?? 99) || (a.type === "TV" ? -1 : 1);
  for (const v of byTmdbTv.values()) v.sort(order);
  return { byAnilist, byTmdbTv, byTmdbMovie, byMal, size: byAnilist.size };
}

async function fetchList() {
  if (process.env.ANIME_LIST_FILE) return JSON.parse(await readFile(process.env.ANIME_LIST_FILE, "utf8"));
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`anime list ${res.status}`);
  return res.json();
}

/** The maps, loading or refreshing in the background. Resolves null if the dataset is unavailable. */
export async function getMaps() {
  const stale = Date.now() - loadedAt > REFRESH_MS;
  if (maps && !stale) return maps;
  if (!loading && (!failedAt || Date.now() - failedAt > RETRY_MS)) {
    loading = fetchList()
      .then((list) => {
        maps = buildMaps(list);
        loadedAt = Date.now();
        failedAt = 0;
      })
      .catch(() => {
        failedAt = Date.now();
      })
      .finally(() => (loading = null));
  }
  // A stale copy answers now; only the very first load waits.
  if (maps) return maps;
  await loading;
  return maps;
}

/** For tests. */
export function resetMaps() {
  maps = null;
  loadedAt = 0;
  failedAt = 0;
}

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null;
};

export function registerIdmap(app) {
  const limit = { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } };
  const cache = (reply) => reply.header("cache-control", "public, max-age=86400");

  /** Everything known about one AniList entry, plus its sibling seasons under the same TMDB show. */
  app.get("/idmap/anilist/:id", limit, async (req, reply) => {
    const id = int(req.params.id);
    if (!id) return reply.code(400).send({ error: "bad_request" });
    const m = await getMaps();
    if (!m) return reply.code(503).send({ error: "idmap_unavailable" });
    const e = m.byAnilist.get(id);
    if (!e) return cache(reply).code(404).send({ error: "not_found" });
    const seasons = e.tmdbTv ? (m.byTmdbTv.get(e.tmdbTv) ?? []).map((x) => ({ anilist: x.anilist, season: x.season, type: x.type })) : [];
    return cache(reply).send({ ...e, seasons });
  });

  /** Which AniList entries are these TMDB titles? ?kind=tv&ids=1,2,3 (up to 60). */
  app.get("/idmap/tmdb", limit, async (req, reply) => {
    const kind = req.query?.kind === "movie" ? "movie" : "tv";
    const ids = String(req.query?.ids ?? "").split(",").map(int).filter(Boolean).slice(0, 60);
    if (!ids.length) return reply.code(400).send({ error: "bad_request" });
    const m = await getMaps();
    if (!m) return reply.code(503).send({ error: "idmap_unavailable" });
    const src = kind === "movie" ? m.byTmdbMovie : m.byTmdbTv;
    const out = {};
    for (const id of ids) {
      const list = src.get(id);
      if (list?.length) out[id] = list.map((x) => ({ anilist: x.anilist, mal: x.mal, season: x.season, type: x.type }));
    }
    return cache(reply).send({ kind, map: out });
  });
}
