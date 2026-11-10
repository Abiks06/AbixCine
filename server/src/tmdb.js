const ALLOWED = /^(trending\/(all|movie|tv)\/(day|week)|movie\/(popular|top_rated|now_playing|upcoming|\d+)|tv\/(popular|top_rated|on_the_air|airing_today|\d+)|tv\/\d+\/season\/\d+|discover\/(movie|tv)|search\/(multi|movie|tv))$/;
/** Only parameters the app actually sends. Anything else would just be a cache-buster. */
const PARAMS = new Set([
  "page", "language", "query", "region", "include_adult", "with_genres", "sort_by", "year", "first_air_date_year",
  "primary_release_year", "with_original_language", "append_to_response", "vote_count.gte", "with_keywords",
  "include_image_language", "with_origin_country",
]);
const cache = new Map();
const TTL = 30 * 60_000;
const MAX = 500;
const MAX_BODY = 512 * 1024;

/** Allow-listed, cached passthrough to TMDB so the key stays on the server. */
export async function tmdbProxy(req, reply) {
  const key = process.env.TMDB_KEY;
  if (!key) return reply.code(501).send({ error: "tmdb_proxy_disabled" });
  const path = req.params["*"];
  if (!ALLOWED.test(path)) return reply.code(400).send({ error: "path_not_allowed" });

  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) if (PARAMS.has(k)) url.searchParams.set(k, String(v).slice(0, 200));
  url.searchParams.sort();

  const ck = url.pathname + url.search;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return reply.header("x-cache", "hit").send(hit.body);
  if (hit) cache.delete(ck);

  const headers = { accept: "application/json" };
  if (key.length > 60) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  let res, text;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    text = await res.text();
  } catch {
    return reply.code(504).send({ error: "upstream_timeout" });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return reply.code(502).send({ error: "upstream_error" });
  }
  if (res.ok && text.length < MAX_BODY) {
    while (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(ck, { at: Date.now(), body });
  }
  return reply.code(res.status).send(body);
}
