const ALLOWED = /^(trending\/(all|movie|tv)\/(day|week)|movie\/(popular|top_rated|now_playing|upcoming|\d+)|tv\/(popular|top_rated|on_the_air|airing_today|\d+)|tv\/\d+\/season\/\d+|discover\/(movie|tv)|search\/(multi|movie|tv))$/;
const cache = new Map();
const TTL = 30 * 60_000;
const MAX = 2000;

/** Allow-listed, cached passthrough to TMDB so the key stays on the server. */
export async function tmdbProxy(req, reply) {
  const key = process.env.TMDB_KEY;
  if (!key) return reply.code(501).send({ error: "tmdb_proxy_disabled" });
  const path = req.params["*"];
  if (!ALLOWED.test(path)) return reply.code(400).send({ error: "path_not_allowed" });

  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) if (k !== "api_key") url.searchParams.set(k, String(v));
  const headers = { accept: "application/json" };
  if (key.length > 60) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  const ck = url.pathname + url.search;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return reply.header("x-cache", "hit").send(hit.body);

  const res = await fetch(url, { headers });
  const body = await res.json();
  if (res.ok) {
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    cache.set(ck, { at: Date.now(), body });
  }
  return reply.code(res.status).send(body);
}
