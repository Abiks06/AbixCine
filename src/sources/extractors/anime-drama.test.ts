import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../../lib/types";

const { mockHttpFetch, mockSniff } = vi.hoisted(() => ({
  mockHttpFetch: vi.fn(),
  mockSniff: vi.fn(),
}));

vi.mock("../native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native")>();
  return {
    ...actual,
    native: true,
    httpFetch: mockHttpFetch,
    sniff: mockSniff,
  };
});

import { unwrapProxyUrl } from "../native";
import { animeDirectProvider } from "../anime-direct";
import { kisskhProvider } from "../kisskh";
import {
  animeheavenProvider,
  parseAnimeHeavenPage,
  parseAnimeHeavenSearch,
  parseAnimeHeavenVideoUrls,
} from "./animeheaven";
import {
  anikotoProvider,
  decryptAnikotoEnc,
  parseAnikotoEpisodes,
  parseAnikotoSearchCards,
  parseAnikotoServers,
} from "./anikoto";
import {
  anizoneProvider,
  hasEnglishAudioTrack,
  parseAnizoneCards,
  parseAnizonePlayer,
} from "./anizone";
import {
  ANIME_EXTRACTORS,
  ASIAN_DRAMA_EXTRACTORS,
  DIRECT_EXTRACTORS,
  MOVIE_TV_EXTRACTORS,
} from "./index";
import {
  decodeAstroProps,
  kickassanimeProvider,
  parseKaaPlayerHtml,
} from "./kickassanime";
import { extractMegaPlayContentId, megaplayProvider } from "./megaplay";
import { decryptOneTouchPayload, onetouchtvProvider } from "./onetouchtv";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    tmdbKey: "",
    libraryPaths: [],
    jellyfin: { url: "", apiKey: "", enabled: false },
    preferredQuality: 1080,
    autoplayNext: true,
    reduceMotion: false,
    animeAudio: "sub",
    audioByTitle: {},
    disabledSources: [],
    enabledExtras: [],
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaDetail> = {}): MediaDetail {
  return {
    key: "anilist:154587",
    kind: "anime",
    title: "Frieren: Beyond Journey's End",
    originalTitle: "Sousou no Frieren",
    overview: "An elf mage travels northward.",
    year: 2023,
    anilistId: 154587,
    malId: 52991,
    genres: ["Adventure", "Fantasy"],
    cast: [],
    crew: [],
    related: [],
    ...overrides,
  };
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function encryptAesCbc(keyBytes: Uint8Array, ivBytes: Uint8Array, plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBytes as BufferSource }, key, new TextEncoder().encode(plaintext)),
  );
  return bytesToB64(ct);
}

beforeEach(() => {
  mockHttpFetch.mockReset();
  mockSniff.mockReset();
});

describe("anizoneProvider", () => {
  it("parses search cards, escaped vidstack player JSON, and checks English audio tracks", () => {
    const searchHtml = `<div x-data="{ items: JSON.parse('[{\\"slug\\":\\"frieren-1\\",\\"main_title\\":\\"Frieren: Beyond Journey\\\\u0027s End\\",\\"title_list\\":{\\"jp\\":\\"Sousou no Frieren\\"},\\"type\\":\\"TV Series\\",\\"start_year\\":2023,\\"episode_count\\":28}]') }"></div>`;
    const cards = parseAnizoneCards(searchHtml);
    expect(cards).toHaveLength(1);
    expect(cards[0].sid).toBe("frieren-1");
    expect(cards[0].titles).toContain("Sousou no Frieren");

    const epHtml = `<script>vidstackPlayer(JSON.parse('{"src":"https:\\/\\/cdn.az.example\\/ep1\\/master.m3u8","subtitles":[{"file":"https:\\/\\/cdn.az.example\\/subs\\/en.ass","language":"eng","title":"English","default":true}]}'))</script>`;
    const player = parseAnizonePlayer(epHtml);
    expect(player.m3u8).toBe("https://cdn.az.example/ep1/master.m3u8");
    expect(player.subs).toHaveLength(1);
    expect(player.subs[0].lang).toBe("eng");

    expect(hasEnglishAudioTrack('#EXT-X-MEDIA:TYPE=AUDIO,NAME="English",LANGUAGE="eng"')).toBe(true);
    expect(hasEnglishAudioTrack('#EXT-X-MEDIA:TYPE=AUDIO,NAME="Japanese",LANGUAGE="jpn"')).toBe(false);
  });

  it("returns dual-audio sub/dub candidates and rejects dub when playlist lacks English audio", async () => {
    const searchHtml = `<div x-data="{ items: JSON.parse('[{\\"slug\\":\\"frieren-1\\",\\"main_title\\":\\"Frieren: Beyond Journey\\\\u0027s End\\",\\"type\\":\\"TV Series\\",\\"start_year\\":2023}]') }"></div>`;
    const epHtml = `<script>vidstackPlayer(JSON.parse('{"src":"https:\\/\\/cdn.az.example\\/ep1\\/master.m3u8","subtitles":[{"file":"https:\\/\\/cdn.az.example\\/en.vtt","language":"en","title":"English","default":true}]}'))</script>`;

    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://anizone.to/anime?search=")) return { status: 200, url, body: searchHtml };
      if (url === "https://anizone.to/anime/frieren-1/5") return { status: 200, url, body: epHtml };
      if (url === "https://cdn.az.example/ep1/master.m3u8") {
        return {
          status: 200,
          url,
          body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="Japanese",LANGUAGE="ja"\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="English",LANGUAGE="en"',
        };
      }
      return { status: 404, url, body: "" };
    });

    const req: PlaybackRequest = { media: makeMedia(), courEpisode: 5, audio: "dub" };
    const dubOut = await anizoneProvider.find(req, makeSettings(), new AbortController().signal);
    expect(dubOut).toHaveLength(1);
    expect(dubOut[0].audio).toBe("dub");
    expect(dubOut[0].subtitles).toHaveLength(1);
    expect(unwrapProxyUrl(dubOut[0].url).url).toBe("https://cdn.az.example/ep1/master.m3u8");

    // Now test sub-only playlist with dub requested -> rejected
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://anizone.to/anime?search=")) return { status: 200, url, body: searchHtml };
      if (url === "https://anizone.to/anime/frieren-1/5") return { status: 200, url, body: epHtml };
      if (url === "https://cdn.az.example/ep1/master.m3u8") {
        return { status: 200, url, body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="Japanese",LANGUAGE="ja"' };
      }
      return { status: 404, url, body: "" };
    });
    expect(await anizoneProvider.find(req, makeSettings(), new AbortController().signal)).toEqual([]);

    // Non-anime media returns [] immediately
    const movieReq: PlaybackRequest = { media: makeMedia({ kind: "movie", genres: ["Action"] }) };
    expect(await anizoneProvider.find(movieReq, makeSettings(), new AbortController().signal)).toEqual([]);
  });
});

describe("kickassanimeProvider", () => {
  it("decodes Astro island props tuples and parses player HTML", () => {
    const decoded = decodeAstroProps([
      0,
      {
        manifest: [0, "//cdn.kaa.example/hls/master.m3u8"],
        subtitles: [
          1,
          [
            [0, { src: [0, "/subs/en.vtt"], language: [0, "en"], name: [0, "English"] }],
          ],
        ],
      },
    ]);
    expect(decoded).toEqual({
      manifest: "//cdn.kaa.example/hls/master.m3u8",
      subtitles: [{ src: "/subs/en.vtt", language: "en", name: "English" }],
    });

    const propsJson = JSON.stringify({
      manifest: [0, "//cdn.kaa.example/hls/master.m3u8"],
      subtitles: [1, [[0, { src: [0, "https://cdn.kaa.example/en.vtt"], language: [0, "en"], name: [0, "English"] }]]],
    }).replace(/"/g, "&quot;");
    const html = `<astro-island props="${propsJson}"></astro-island>`;
    const parsed = parseKaaPlayerHtml(html);
    expect(parsed.m3u8).toBe("https://cdn.kaa.example/hls/master.m3u8");
    expect(parsed.subs).toHaveLength(1);
    expect(parsed.subs[0].lang).toBe("en");
  });

  it("resolves sub vs dub locales through kaa.lt API and cat-player", async () => {
    const seenUrls: string[] = [];
    const propsJson = JSON.stringify({
      manifest: [0, "https://stream.kaa.example/master.m3u8"],
      subtitles: [1, [[0, { src: [0, "https://stream.kaa.example/en.ass"], language: [0, "en"], name: [0, "English"] }]]],
    }).replace(/"/g, "&quot;");

    mockHttpFetch.mockImplementation(async (url: string) => {
      seenUrls.push(url);
      if (url === "https://kaa.lt/api/fsearch") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            result: [
              {
                slug: "frieren-slug",
                title: "Sousou no Frieren",
                title_en: "Frieren: Beyond Journey's End",
                type: "tv",
                year: 2023,
                episode_count: 28,
                locales: ["ja-JP", "en-US"],
              },
            ],
          }),
        };
      }
      if (url.startsWith("https://kaa.lt/api/show/frieren-slug/episodes?")) {
        return { status: 200, url, body: JSON.stringify({ result: [{ episode_number: 3, slug: "ep3slug" }] }) };
      }
      if (url === "https://kaa.lt/api/show/frieren-slug/episode/ep-3-ep3slug") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            servers: [
              { name: "VidStreaming", src: "https://krussdomi.com/cat-player/vast?id=123" },
            ],
          }),
        };
      }
      if (url === "https://krussdomi.com/cat-player/player?id=123") {
        return { status: 200, url, body: `<astro-island props="${propsJson}"></astro-island>` };
      }
      return { status: 404, url, body: "" };
    });

    const out = await kickassanimeProvider.find(
      { media: makeMedia(), episode: 3, audio: "dub" },
      makeSettings(),
      new AbortController().signal,
    );
    expect(seenUrls).toContain("https://kaa.lt/api/show/frieren-slug/episodes?ep=3&lang=en-US");
    expect(out).toHaveLength(1);
    expect(out[0].audio).toBe("dub");
    expect(out[0].subtitles).toHaveLength(1);
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://stream.kaa.example/master.m3u8");
  });
});

describe("anikotoProvider", () => {
  it("decrypts AES-256-CBC enc payloads and parses search/episodes/servers HTML", async () => {
    const keyBytes = new Uint8Array(32);
    keyBytes.set(new TextEncoder().encode("i?LMTAx0Q6,:}50U"), 0);
    const ivBytes = new TextEncoder().encode("W0;27ToaUpl_P%'c");
    const enc = await encryptAesCbc(keyBytes, ivBytes, JSON.stringify({ file: "https://cdn.ak.example/out.m3u8" }));

    expect(await decryptAnikotoEnc(enc)).toEqual({ file: "https://cdn.ak.example/out.m3u8" });
    expect(await decryptAnikotoEnc("not-valid-b64!")).toBeNull();

    const cards = parseAnikotoSearchCards(
      `<div class="item"><a class="name d-title" data-jp="Sousou no Frieren" href="/watch/frieren-123/ep-1">Frieren: Beyond Journey's End</a><span class="ep-status sub">SUB</span><span class="ep-status dub">DUB</span></div>`,
      "https://anikototv.to",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].href).toBe("https://anikototv.to/watch/frieren-123");
    expect(cards[0].hasDub).toBe(true);

    const eps = parseAnikotoEpisodes(`<a data-ids="s1,s2" data-num="2" data-sub="1" data-dub="1" data-slug="2">2</a>`);
    expect(eps).toEqual([{ dataIds: "s1,s2", num: 2, hasSub: true, hasDub: true, slug: "2" }]);

    const servers = parseAnikotoServers(
      `<div data-type="sub"><ul><li data-link-id="lid1">HD-1</li><li data-link-id="lid2">Vidstream-2</li></ul></div>`,
      ["sub"],
    );
    expect(servers.map((s) => s.name)).toEqual(["Vidstream-2", "HD-1"]);
  });

  it("leaves the id-keyed MegaPlay route to the megaplay extractor and scrapes mirrors", async () => {
    const keyBytes = new Uint8Array(32);
    keyBytes.set(new TextEncoder().encode("i?LMTAx0Q6,:}50U"), 0);
    const ivBytes = new TextEncoder().encode("W0;27ToaUpl_P%'c");
    const enc = await encryptAesCbc(keyBytes, ivBytes, JSON.stringify({ file: "https://cdn.mp.example/ep2.m3u8" }));

    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url === "https://megaplay.buzz/stream/ani/154587/2/sub") {
        return { status: 200, url, body: `<div id="megaplay-player" data-id="mp99"></div>` };
      }
      if (url === "https://megaplay.buzz/stream/getSourcesNew?id=mp99") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            enc,
            tracks: [{ file: "https://cdn.mp.example/subs/en.vtt", label: "English", kind: "captions", default: true }],
          }),
        };
      }
      return { status: 404, url, body: "" };
    });

    const fastOut = await megaplayProvider.find(
      { media: makeMedia(), episode: 2, audio: "sub" },
      makeSettings(),
      new AbortController().signal,
    );
    expect(fastOut).toHaveLength(1);
    expect(fastOut[0].providerId).toBe("megaplay");
    expect(unwrapProxyUrl(fastOut[0].url).url).toBe("https://cdn.mp.example/ep2.m3u8");
    expect(unwrapProxyUrl(fastOut[0].url).headers.referer).toBe("https://megaplay.buzz/");
    expect(fastOut[0].subtitles).toHaveLength(1);

    // Anikoto no longer duplicates the MegaPlay requests itself.
    mockHttpFetch.mockClear();
    await anikotoProvider.find({ media: makeMedia(), episode: 2, audio: "sub" }, makeSettings(), new AbortController().signal);
    expect(mockHttpFetch.mock.calls.some(([u]) => String(u).startsWith("https://megaplay.buzz/"))).toBe(false);

    // Mirror fallback when no AniList/MAL IDs exist
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://anikototv.to/filter?")) return { status: 500, url, body: "" };
      if (url.startsWith("https://anikoto.cz/filter?")) {
        return {
          status: 200,
          url,
          body: `<div class="item"><a class="name d-title" href="/watch/frieren-123/ep-1">Frieren: Beyond Journey's End</a><span class="ep-status sub">SUB</span></div>`,
        };
      }
      if (url === "https://anikoto.cz/watch/frieren-123") {
        return { status: 200, url, body: `<div id="watch-main" data-id="555"></div>` };
      }
      if (url === "https://anikoto.cz/ajax/episode/list/555") {
        return { status: 200, url, body: JSON.stringify({ result: `<a data-ids="grp1" data-num="1" data-sub="1" data-dub="0">1</a>` }) };
      }
      if (url === "https://anikoto.cz/ajax/server/list?servers=grp1") {
        return {
          status: 200,
          url,
          body: JSON.stringify({ result: `<div data-type="sub"><ul><li data-link-id="lnk1">HD-2</li></ul></div>` }),
        };
      }
      if (url === "https://anikoto.cz/ajax/server?get=lnk1") {
        return { status: 200, url, body: JSON.stringify({ result: { url: "https://embed.example/e/77/sub" } }) };
      }
      if (url === "https://embed.example/e/77/sub") {
        return { status: 200, url, body: `<div id="megaplay-player" data-id="e77"></div>` };
      }
      if (url === "https://embed.example/stream/getSourcesNew?id=e77") {
        return { status: 200, url, body: JSON.stringify({ sources: [{ file: "https://cdn.ak.example/mirror.m3u8" }] }) };
      }
      return { status: 404, url, body: "" };
    });

    const mirrorOut = await anikotoProvider.find(
      {
        media: makeMedia({ key: "tmdb:tv:209867", anilistId: undefined, malId: undefined }),
        episode: 1,
        audio: "sub",
      },
      makeSettings(),
      new AbortController().signal,
    );
    expect(mirrorOut).toHaveLength(1);
    expect(mirrorOut[0].label).toContain("HD-2");
    expect(unwrapProxyUrl(mirrorOut[0].url).url).toBe("https://cdn.ak.example/mirror.m3u8");

    // Rejects wrong season cards when requesting season 1
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://anikototv.bz/filter?")) {
        return {
          status: 200,
          url,
          body: `<div class="item"><a class="name d-title" href="/watch/frieren-s2/ep-1">Frieren: Beyond Journey's End Season 2</a><span class="ep-status sub">SUB</span></div>`,
        };
      }
      return { status: 404, url, body: "" };
    });
    const wrongSeasonOut = await anikotoProvider.find(
      {
        media: makeMedia({ key: "tmdb:tv:209867", anilistId: undefined, malId: undefined }),
        season: 1,
        episode: 1,
        audio: "sub",
      },
      makeSettings(),
      new AbortController().signal,
    );
    expect(wrongSeasonOut).toEqual([]);
  });
});

describe("megaplayProvider", () => {
  beforeEach(() => mockHttpFetch.mockReset());

  it("reads the content id from the player div or the page title", () => {
    expect(extractMegaPlayContentId(`<div data-id="9" id="megaplay-player"></div>`)).toBe("9");
    expect(extractMegaPlayContentId(`<title>File 12345 - MegaPlay</title>`)).toBe("12345");
    expect(extractMegaPlayContentId(`<title>Error - MegaPlay</title>`)).toBeNull();
  });

  it("prefers the MAL route, carries intro/outro, and skips non-anime requests", async () => {
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url === "https://megaplay.buzz/stream/mal/52991/3/dub") {
        return { status: 200, url, body: `<html><title>File 777 - MegaPlay</title></html>` };
      }
      if (url === "https://megaplay.buzz/stream/getSourcesNew?id=777") {
        return {
          status: 200,
          url,
          body: JSON.stringify({
            sources: { file: "https://cdn.mp.example/777.m3u8" },
            intro: { start: 10, end: 95 },
            outro: { start: 1300, end: 1390 },
          }),
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await megaplayProvider.find({ media: makeMedia(), episode: 3, audio: "dub" }, makeSettings(), new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(out[0].audio).toBe("dub");
    expect(out[0].skip).toEqual({ intro: [10, 95], outro: [1300, 1390] });
    expect(mockHttpFetch.mock.calls.some(([u]) => String(u).includes("/stream/ani/"))).toBe(false);

    mockHttpFetch.mockClear();
    const movie = await megaplayProvider.find(
      { media: makeMedia({ key: "tmdb:movie:550", kind: "movie", anilistId: undefined, malId: undefined }) },
      makeSettings(),
      new AbortController().signal,
    );
    expect(movie).toEqual([]);
    expect(mockHttpFetch).not.toHaveBeenCalled();
  });
});

describe("onetouchtvProvider", () => {
  const ottKey = new TextEncoder().encode("im72charPasswordofdInitVectorStm");
  const ottIv = new TextEncoder().encode("im72charPassword");

  async function encryptOtt(result: unknown): Promise<string> {
    const b64 = await encryptAesCbc(ottKey, ottIv, JSON.stringify({ result }));
    return b64.replace(/\//g, "-_.").replace(/\+/g, "@");
  }

  it("decrypts URL-safe OneTouchTV AES-256-CBC payloads", async () => {
    const encoded = await encryptOtt([{ id: 42, title: "Moving" }]);
    expect(await decryptOneTouchPayload(encoded)).toEqual([{ id: 42, title: "Moving" }]);
    expect(await decryptOneTouchPayload("not-valid")).toBeNull();
  });

  it("extracts K-drama TV episodes & subtitles and guards non-Asian or anime requests", async () => {
    const dramaMedia = makeMedia({
      key: "tmdb:tv:120089",
      kind: "tv",
      title: "Moving",
      originalTitle: "무빙",
      year: 2023,
      originalLanguage: "ko",
      genres: ["Action", "Drama"],
      anilistId: undefined,
      malId: undefined,
    });

    // Reject non-Asian languages and anime
    expect(
      await onetouchtvProvider.find(
        { media: makeMedia({ key: "tmdb:tv:1", kind: "tv", originalLanguage: "en", genres: ["Drama"], anilistId: undefined }) },
        makeSettings(),
        new AbortController().signal,
      ),
    ).toEqual([]);
    expect(
      await onetouchtvProvider.find(
        { media: makeMedia({ kind: "anime", originalLanguage: "ja" }) },
        makeSettings(),
        new AbortController().signal,
      ),
    ).toEqual([]);

    const searchPayload = await encryptOtt([{ id: 777, title: "Moving", year: 2023, type: "drama" }]);
    const detailPayload = await encryptOtt({
      id: 777,
      title: "Moving",
      episodes: [{ episode: 4, playId: 904 }],
    });
    const streamPayload = await encryptOtt({
      sources: [
        { url: "https://cdn.ott.example/720.m3u8", quality: "720p", type: "hls", name: "Server 1" },
        { url: "https://cdn.ott.example/1080.m3u8", quality: "1080p", type: "hls", name: "Server 2" },
      ],
      track: [{ file: "https://cdn.ott.example/en.vtt", name: "English", lang: "en", default: true }],
    });

    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api3.devcorp.me/vod/search?keyword=")) return { status: 200, url, body: searchPayload };
      if (url === "https://api3.devcorp.me/vod/777/detail") return { status: 200, url, body: detailPayload };
      if (url === "https://api3.devcorp.me/vod/777/episode/904") return { status: 200, url, body: streamPayload };
      return { status: 404, url, body: "" };
    });

    const out = await onetouchtvProvider.find(
      { media: dramaMedia, season: 1, episode: 4 },
      makeSettings(),
      new AbortController().signal,
    );
    expect(out).toHaveLength(2);
    expect(out[0].quality).toBe(1080);
    expect(out[0].subtitles).toHaveLength(1);
    expect(out[0].headers?.referer).toBe("https://api3.devcorp.me/");
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://cdn.ott.example/1080.m3u8");
  });
});

describe("animeheavenProvider", () => {
  it("parses search cards, .infotitlejp aliases, spaced episode attributes, and uncommented gate.php sources", async () => {
    const cards = parseAnimeHeavenSearch(`
      <div class='similarimg'><div class='p1'>
        <a href='anime.php?62reo'><img class='coverimg' src='image.php?a308n' alt='Sorcery Fight'></a>
        <div class='similarname c'><a href='anime.php?62reo' class='c'>Sorcery Fight</a></div>
      </div></div>
    `);
    expect(cards).toEqual([{ href: "https://animeheaven.me/anime.php?62reo", title: "Sorcery Fight" }]);

    const page = parseAnimeHeavenPage(`
      <div class='infotitle c'>Sorcery Fight</div>
      <div class='infotitlejp c'>Jujutsu Kaisen, jjk</div>
      <a class='c' id ="gate123"><div class='watch1 bc c'>Episode</div><div class= ' watch2 bc ' >1</div></a>
    `);
    expect(page.titles).toContain("Jujutsu Kaisen");
    expect(page.episodes).toEqual([{ num: 1, key: "gate123" }]);

    const srcs = parseAnimeHeavenVideoUrls(`
      <!-- <source src='https://stale.example/old.mp4' type='video/mp4'> -->
      <source src='https://cu.animeheaven.me/video.mp4?gate123' type='video/mp4'>
    `);
    expect(srcs).toEqual(["https://cu.animeheaven.me/video.mp4?gate123"]);

    let gateCookie = "";
    mockHttpFetch.mockImplementation(async (url: string, headers: Record<string, string> = {}) => {
      if (url.startsWith("https://animeheaven.me/search.php?s=")) {
        return {
          status: 200,
          url,
          body: `<div class='similarname c'><a href='anime.php?62reo' class='c'>Sorcery Fight</a></div>`,
        };
      }
      if (url === "https://animeheaven.me/anime.php?62reo") {
        return {
          status: 200,
          url,
          body: `<div class='infotitlejp c'>Jujutsu Kaisen</div><a id ="k1"><div class=' watch2 '>1</div></a>`,
        };
      }
      if (url === "https://animeheaven.me/gate.php") {
        gateCookie = headers.Cookie ?? "";
        return {
          status: 200,
          url,
          body: `<!-- <source src='https://old.example/1.mp4'> --><source src='https://cu.animeheaven.me/ep1.mp4'>`,
        };
      }
      return { status: 404, url, body: "" };
    });

    const out = await animeheavenProvider.find(
      { media: makeMedia({ title: "Jujutsu Kaisen", originalTitle: "Jujutsu Kaisen" }), episode: 1, audio: "sub" },
      makeSettings(),
      new AbortController().signal,
    );
    expect(gateCookie).toBe("key=k1");
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("file");
    expect(unwrapProxyUrl(out[0].url).url).toBe("https://cu.animeheaven.me/ep1.mp4");
  });
});

describe("animeDirectProvider & kisskhProvider updates", () => {
  it("allows anime movies and sends zokoanime.video Referer", async () => {
    const payload = JSON.stringify({ src: "https://cdn.zoko.example/jjk0/master.m3u8", subtitles: [] });
    const key = "otaku-embed-v1";
    const xored = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) {
      xored[i] = payload.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    }
    const enc = bytesToB64(xored);

    let streamPageRef = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { Page: { media: [{ idMal: 48561, format: "MOVIE", seasonYear: 2021 }] } },
      }),
    } as Response);
    mockHttpFetch.mockImplementation(async (url: string, headers: Record<string, string> = {}) => {
      if (url === "https://zokoanime.video/stream/mal/48561/1/sub") {
        streamPageRef = headers.Referer ?? "";
        return { status: 200, url, body: `<script>window.__P="${enc}";</script>` };
      }
      return { status: 404, url, body: "" };
    });

    try {
      const out = await animeDirectProvider.find(
        {
          media: makeMedia({
            key: "tmdb:movie:810693",
            kind: "movie",
            title: "Jujutsu Kaisen 0",
            originalTitle: "Jujutsu Kaisen 0",
            year: 2021,
            anilistId: undefined,
            malId: undefined,
          }),
          isAnimeMovie: true,
          audio: "sub",
        } as PlaybackRequest,
        makeSettings(),
        new AbortController().signal,
      );
      expect(streamPageRef).toBe("https://zokoanime.video/");
      expect(out).toHaveLength(1);
      expect(out[0].headers?.referer).toBe("https://zokoanime.video/");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses enc-kisskh direct video when available and falls back to sniff when unavailable", async () => {
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.includes("/Search?q=Test%20Kisskh%20Direct")) {
        return { status: 200, url, body: JSON.stringify([{ id: 8792, title: "Test Kisskh Direct", episodesCount: 16 }]) };
      }
      if (url.includes("/Drama/8792?")) {
        return { status: 200, url, body: JSON.stringify({ id: 8792, title: "Test Kisskh Direct", episodes: [{ id: 154879, number: 1 }] }) };
      }
      if (url === "https://enc-dec.app/api/enc-kisskh?text=154879&type=vid") {
        return { status: 200, url, body: JSON.stringify({ result: "vid-key" }) };
      }
      if (url === "https://enc-dec.app/api/enc-kisskh?text=154879&type=sub") {
        return { status: 200, url, body: JSON.stringify({ result: "sub-key" }) };
      }
      if (url.startsWith("https://kisskh.co/api/DramaList/Episode/154879.png?") && url.includes("kkey=vid-key")) {
        return { status: 200, url, body: JSON.stringify({ Video: "https://hls.kiss.example/ep1.m3u8" }) };
      }
      if (url.startsWith("https://kisskh.co/api/Sub/154879?kkey=sub-key")) {
        return { status: 200, url, body: JSON.stringify([]) };
      }
      return { status: 404, url, body: "" };
    });

    const directOut = await kisskhProvider.find(
      {
        media: makeMedia({ key: "tmdb:tv:90001", kind: "tv", title: "Test Kisskh Direct", originalTitle: "Test Kisskh Direct", originalLanguage: "ko" }),
        season: 1,
        episode: 1,
      },
      makeSettings(),
      new AbortController().signal,
    );
    expect(mockSniff).not.toHaveBeenCalled();
    expect(directOut).toHaveLength(1);
    expect(directOut[0].via).toBe("direct");
    expect(unwrapProxyUrl(directOut[0].url).url).toBe("https://hls.kiss.example/ep1.m3u8");

    // Fallback to sniff when enc-kisskh is unavailable
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.includes("/Search?q=Test%20Kisskh%20Fallback")) {
        return { status: 200, url, body: JSON.stringify([{ id: 8888, title: "Test Kisskh Fallback", episodesCount: 16 }]) };
      }
      if (url.includes("/Drama/8888?")) {
        return { status: 200, url, body: JSON.stringify({ id: 8888, title: "Test Kisskh Fallback", episodes: [{ id: 160000, number: 1 }] }) };
      }
      return { status: 500, url, body: "" };
    });
    mockSniff.mockResolvedValue({
      url: "https://sniffed.kiss.example/ep1.m3u8",
      kind: "hls",
      headers: {},
      subtitles: [],
      verified: true,
      quality: 1080,
    });
    const fallbackOut = await kisskhProvider.find(
      {
        media: makeMedia({ key: "tmdb:tv:90002", kind: "tv", title: "Test Kisskh Fallback", originalTitle: "Test Kisskh Fallback", originalLanguage: "ko" }),
        season: 1,
        episode: 1,
      },
      makeSettings(),
      new AbortController().signal,
    );
    expect(mockSniff).toHaveBeenCalledTimes(1);
    expect(fallbackOut[0].via).toBe("sniffed");
  });
});

describe("extractors barrel index", () => {
  it("exports all 15 extractors with unique IDs and functional isEnabled hooks", () => {
    expect(MOVIE_TV_EXTRACTORS).toHaveLength(9);
    expect(ANIME_EXTRACTORS).toHaveLength(5);
    expect(ASIAN_DRAMA_EXTRACTORS).toHaveLength(1);
    expect(DIRECT_EXTRACTORS).toHaveLength(15);

    const ids = DIRECT_EXTRACTORS.map((p) => p.id);
    for (const id of ["castle", "animeheaven", "flixnest", "hexa-direct", "cinejoy", "meowtv", "megaplay"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(15);

    const settings = makeSettings();
    for (const p of DIRECT_EXTRACTORS) {
      expect(p.isEnabled?.(settings)).toBe(true);
      expect(p.isEnabled?.(makeSettings({ disabledSources: [p.id] }))).toBe(false);
    }
  });
});
