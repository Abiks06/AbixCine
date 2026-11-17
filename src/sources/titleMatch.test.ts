import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, updateSettings } from "../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { pickBestTmdbMatch, resolveTmdbId, searchedTmdbMatch } from "./embeds";
import { pickBestCastleHit } from "./extractors/castle";
import { pickBestOttMatch } from "./extractors/onetouchtv";
import { jellyfinProvider } from "./jellyfin";
import { matchTargetFor, normalizeMatchTitle, pickTitleMatch, splitSeasonSuffix } from "./titleMatch";

/**
 * "Some servers return the wrong movie": watching The Odyssey (Christopher Nolan, 2026) played
 * the 1997 miniseries or another same-named title. Every title search now goes through one strict
 * matcher; these pin it down on exactly that case.
 */

const media = (over: Partial<MediaDetail> = {}): MediaDetail => ({
  key: "test:odyssey-2026",
  kind: "movie",
  title: "The Odyssey",
  originalTitle: "The Odyssey",
  overview: "",
  year: 2026,
  runtime: 150,
  genres: [],
  cast: [],
  crew: [],
  related: [],
  ...over,
});

const film2026: PlaybackRequest = { media: media() };

/** What a catalog search for "The Odyssey" turns up. */
const ODYSSEYS = [
  { id: "mini-1997", title: "The Odyssey", year: 1997, kind: "tv" as const },
  { id: "tvmovie-1997", title: "The Odyssey", year: 1997, kind: "movie" as const },
  { id: "doc-2016", title: "The Odyssey", year: 2016, kind: "movie" as const },
  { id: "nolan-2026", title: "The Odyssey", year: 2026, kind: "movie" as const },
  { id: "space-2001", title: "2001: A Space Odyssey", year: 1968, kind: "movie" as const },
];
const describeRow = (r: (typeof ODYSSEYS)[number]) => ({ titles: [r.title], year: r.year, kind: r.kind });

describe("normalizeMatchTitle", () => {
  it("ignores case, diacritics, punctuation, a leading article, '&' and a trailing year", () => {
    expect(normalizeMatchTitle("The Odyssey")).toBe("odyssey");
    expect(normalizeMatchTitle("Odyssey, The")).toBe("odyssey");
    expect(normalizeMatchTitle("THE ODYSSEY (2026)")).toBe("odyssey");
    expect(normalizeMatchTitle("Amélie")).toBe(normalizeMatchTitle("Amelie"));
    expect(normalizeMatchTitle("Fast & Furious")).toBe(normalizeMatchTitle("Fast and Furious"));
    expect(normalizeMatchTitle("Spider-Man: No Way Home")).toBe("spider man no way home");
    expect(normalizeMatchTitle("Rocky II")).toBe(normalizeMatchTitle("Rocky 2"));
    expect(normalizeMatchTitle("Ocean's Eleven")).toBe("oceans eleven");
    // Other scripts are kept, so an original title still compares.
    expect(normalizeMatchTitle("무빙")).not.toBe("");
    // A word that merely starts like an article is left alone.
    expect(normalizeMatchTitle("Anora")).toBe("anora");
  });

  it("splits a season suffix off a series title", () => {
    expect(splitSeasonSuffix("squid game season 2")).toEqual({ base: "squid game", season: 2 });
    expect(splitSeasonSuffix("squid game s2")).toEqual({ base: "squid game", season: 2 });
    expect(splitSeasonSuffix("attack on titan 3rd season")).toEqual({ base: "attack on titan", season: 3 });
    expect(splitSeasonSuffix("oceans 11")).toEqual({ base: "oceans 11" });
  });
});

describe("pickTitleMatch: The Odyssey (2026)", () => {
  it("picks the 2026 film over the 1997 miniseries, the 1997 TV film and other same-named titles", () => {
    const hit = pickTitleMatch(ODYSSEYS, matchTargetFor(film2026), describeRow);
    expect(hit?.item.id).toBe("nolan-2026");
    expect(hit?.verified).toBe(true);
    // Whatever order the provider lists them in.
    expect(pickTitleMatch([...ODYSSEYS].reverse(), matchTargetFor(film2026), describeRow)?.item.id).toBe("nolan-2026");
  });

  it("finds nothing (rather than an older Odyssey) when the 2026 film isn't in the catalog", () => {
    const without = ODYSSEYS.filter((r) => r.id !== "nolan-2026");
    expect(pickTitleMatch(without, matchTargetFor(film2026), describeRow)).toBeNull();
  });

  it("accepts a year off by one (release-date edge) but not two", () => {
    const target = matchTargetFor(film2026);
    expect(pickTitleMatch([{ id: "a", title: "The Odyssey", year: 2025, kind: "movie" as const }], target, describeRow)?.item.id).toBe("a");
    expect(pickTitleMatch([{ id: "b", title: "The Odyssey", year: 2024, kind: "movie" as const }], target, describeRow)).toBeNull();
  });

  it("never takes a similar title: '2001: A Space Odyssey' and 'Odyssey 5' are other works", () => {
    const target = matchTargetFor(film2026);
    const rows = [
      { id: "space", title: "2001: A Space Odyssey", year: 2026, kind: "movie" as const },
      { id: "five", title: "Odyssey 5", year: 2026, kind: "movie" as const },
      { id: "the-odysseys", title: "The Odysseys", year: 2026, kind: "movie" as const },
    ];
    expect(pickTitleMatch(rows, target, describeRow)).toBeNull();
  });

  it("an id match decides on its own, either way", () => {
    const target = { ...matchTargetFor(film2026), imdbId: "tt33764258" };
    const rows = [
      { id: "same-name-other-id", title: "The Odyssey", year: 2026, imdb: "tt0118414" },
      { id: "renamed-same-id", title: "Odysseus Untitled", year: 2026, imdb: "tt33764258" },
    ];
    const hit = pickTitleMatch(rows, target, (r) => ({ titles: [r.title], year: r.year, imdbId: r.imdb }));
    expect(hit?.item.id).toBe("renamed-same-id");
    expect(hit?.byId).toBe(true);
  });
});

describe("pickTitleMatch: year-less requests and catalog rows", () => {
  const noYear: PlaybackRequest = { media: media({ year: undefined, key: "test:odyssey-noyear" }) };

  it("refuses to guess between same-named titles when the request has no year", () => {
    expect(pickTitleMatch(ODYSSEYS, matchTargetFor(noYear), describeRow)).toBeNull();
  });

  it("takes the only entry with that title when there is just one", () => {
    const rows = [
      { id: "only", title: "The Odyssey", year: 1997, kind: "movie" as const },
      { id: "other", title: "Ulysses", year: 1954, kind: "movie" as const },
    ];
    expect(pickTitleMatch(rows, matchTargetFor(noYear), describeRow)?.item.id).toBe("only");
  });

  it("takes a year-less catalog row only when nothing else of that name is there", () => {
    const target = matchTargetFor(film2026);
    const undated = { id: "undated", title: "The Odyssey", kind: "movie" as const };
    expect(pickTitleMatch([undated], target, (r) => ({ titles: [r.title], kind: r.kind }))?.item.id).toBe("undated");
    // Two undated rows of the same name: could be two different works.
    expect(pickTitleMatch([undated, { ...undated, id: "undated-2" }], target, (r) => ({ titles: [r.title], kind: r.kind }))).toBeNull();
    // A dated row that agrees wins over an undated one.
    const dated = { id: "dated", title: "The Odyssey", year: 2026, kind: "movie" as const };
    expect(pickTitleMatch([undated, dated], target, (r) => ({ titles: [r.title], year: (r as { year?: number }).year, kind: r.kind }))?.item.id).toBe("dated");
  });

  it("keeps movie and series apart", () => {
    const series: PlaybackRequest = { media: media({ key: "test:odyssey-series", kind: "tv", year: 1997 }), season: 1, episode: 1 };
    expect(pickTitleMatch(ODYSSEYS, matchTargetFor(series), describeRow)?.item.id).toBe("mini-1997");
  });
});

describe("extractor pickers use the strict matcher", () => {
  it("Castle: picks the 2026 row, and nothing when only the 1997 one exists", () => {
    const target = matchTargetFor(film2026);
    const rows = [
      { id: "c-1997", title: "The Odyssey", publishTime: "1997-05-18" },
      { id: "c-2026", title: "The Odyssey", publishTime: "2026-07-17" },
    ];
    expect(pickBestCastleHit(rows, target)?.item.id).toBe("c-2026");
    expect(pickBestCastleHit(rows, target)?.year).toBe(2026);
    // The fuzzy picker took this one: identical title, year only cost a few points.
    expect(pickBestCastleHit([rows[0]], target)).toBeNull();
  });

  it("OneTouchTV: a season-suffixed entry must name the wanted season", () => {
    const req: PlaybackRequest = { media: media({ key: "tmdb:tv:93405", kind: "tv", title: "Squid Game", originalTitle: "오징어 게임", year: 2021 }), season: 2, episode: 1 };
    const results = [
      { id: 1, title: "Squid Game", year: 2021, type: "drama" },
      { id: 2, title: "Squid Game Season 2", year: 2024, type: "drama" },
      { id: 3, title: "Squid Game: The Challenge", year: 2023, type: "variety" },
    ];
    expect(pickBestOttMatch(results, matchTargetFor(req), false)?.item.id).toBe(2);
    expect(pickBestOttMatch(results, matchTargetFor({ ...req, season: 3 }), false)?.item.id).toBe(1);
    // A film request never lands on a series entry.
    expect(pickBestOttMatch(results, matchTargetFor({ media: media({ title: "Squid Game", year: 2021 }) }), true)).toBeNull();
  });
});

describe("resolveTmdbId: TMDB lookups by title", () => {
  const tmdbResults = {
    results: [
      { id: 15516, media_type: "tv", name: "The Odyssey", first_air_date: "1997-05-18" },
      { id: 52010, media_type: "movie", title: "The Odyssey", release_date: "1997-05-18" },
      { id: 383498, media_type: "movie", title: "The Odyssey", release_date: "2016-10-12" },
      { id: 1368337, media_type: "movie", title: "The Odyssey", release_date: "2026-07-17" },
    ],
  };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(tmdbResults), { status: 200, headers: { "content-type": "application/json" } }));
  let prevKey = "";

  beforeEach(() => {
    prevKey = getSettings().tmdbKey;
    updateSettings({ tmdbKey: "test-tmdb-key" });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    updateSettings({ tmdbKey: prevKey });
    vi.unstubAllGlobals();
  });

  it("resolves The Odyssey (2026) to the 2026 film's id and remembers what it matched", async () => {
    const req: PlaybackRequest = { media: media({ key: "local:odyssey-2026" }) };
    expect(await resolveTmdbId(req)).toBe("1368337");
    expect(searchedTmdbMatch(req)).toEqual({ title: "The Odyssey", year: 2026 });
  });

  it("gives no id for a year-less request with several same-named films", async () => {
    expect(await resolveTmdbId({ media: media({ key: "local:odyssey-noyear", year: undefined }) })).toBeNull();
  });

  it("gives no id when the wanted year isn't among the results (no first-result fallback)", async () => {
    expect(await resolveTmdbId({ media: media({ key: "local:odyssey-2030", year: 2030 }) })).toBeNull();
  });

  it("pickBestTmdbMatch keeps series requests off films and vice versa", () => {
    const hits = tmdbResults.results.map((r) => ({
      key: `tmdb:${r.media_type}:${r.id}`,
      kind: r.media_type,
      title: (r as { title?: string }).title ?? (r as { name?: string }).name ?? "",
      year: Number(((r as { release_date?: string }).release_date ?? (r as { first_air_date?: string }).first_air_date ?? "").slice(0, 4)),
    }));
    const series: PlaybackRequest = { media: media({ key: "local:odyssey-mini", kind: "tv", year: 1997 }), season: 1, episode: 1 };
    expect(pickBestTmdbMatch(hits, series, false)?.key).toBe("tmdb:tv:15516");
    expect(pickBestTmdbMatch(hits, film2026, true)?.key).toBe("tmdb:movie:1368337");
  });
});

describe("Jellyfin only plays the library item that is this title", () => {
  afterEach(() => vi.unstubAllGlobals());
  const settings = () => ({ ...getSettings(), jellyfin: { enabled: true, url: "http://localhost:8096", apiKey: "k" } });
  const item = (Id: string, Name: string, ProductionYear: number, ProviderIds?: Record<string, string>) => ({
    Id,
    Name,
    ProductionYear,
    ProviderIds,
    MediaSources: [{ Id: `src-${Id}`, MediaStreams: [] }],
  });

  it("does not fall back to the library's 1997 Odyssey for the 2026 film", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Items: [item("old", "The Odyssey", 1997)] }), { status: 200 })));
    expect(await jellyfinProvider.find(film2026, settings(), new AbortController().signal)).toEqual([]);
  });

  it("matches by TMDB id when the library has one, and says what it found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ Items: [item("old", "The Odyssey", 1997, { Tmdb: "52010" }), item("new", "The Odyssey", 2026, { Tmdb: "1368337" })] }), { status: 200 }),
      ),
    );
    const req: PlaybackRequest = { media: media({ key: "tmdb:movie:1368337", tmdbId: 1368337 }) };
    const out = await jellyfinProvider.find(req, settings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain("/Videos/new/");
    expect(out[0].matched).toEqual({ title: "The Odyssey", year: 2026 });
  });
});
