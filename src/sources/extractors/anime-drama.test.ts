import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../../lib/types";

const { mockHttpFetch } = vi.hoisted(() => ({
  mockHttpFetch: vi.fn(),
}));

vi.mock("../native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native")>();
  return {
    ...actual,
    native: true,
    httpFetch: mockHttpFetch,
  };
});

import { unwrapProxyUrl } from "../native";
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

  it("uses MegaPlay fast-path when anilistId is present and falls back to mirror scraping", async () => {
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

    const fastOut = await anikotoProvider.find(
      { media: makeMedia(), episode: 2, audio: "sub" },
      makeSettings(),
      new AbortController().signal,
    );
    expect(fastOut).toHaveLength(1);
    expect(unwrapProxyUrl(fastOut[0].url).url).toBe("https://cdn.mp.example/ep2.m3u8");
    expect(fastOut[0].subtitles).toHaveLength(1);

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

describe("extractors barrel index", () => {
  it("exports all 10 extractors with unique IDs and functional isEnabled hooks", () => {
    expect(MOVIE_TV_EXTRACTORS).toHaveLength(6);
    expect(ANIME_EXTRACTORS).toHaveLength(3);
    expect(ASIAN_DRAMA_EXTRACTORS).toHaveLength(1);
    expect(DIRECT_EXTRACTORS).toHaveLength(10);

    const ids = DIRECT_EXTRACTORS.map((p) => p.id);
    expect(new Set(ids).size).toBe(10);

    const settings = makeSettings();
    for (const p of DIRECT_EXTRACTORS) {
      expect(p.isEnabled?.(settings)).toBe(true);
      expect(p.isEnabled?.(makeSettings({ disabledSources: [p.id] }))).toBe(false);
    }
  });
});
