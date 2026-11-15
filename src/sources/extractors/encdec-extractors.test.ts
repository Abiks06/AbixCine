import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../../lib/types";

const { mockHttpFetch, mockHttpFetchBytes } = vi.hoisted(() => ({
  mockHttpFetch: vi.fn(),
  mockHttpFetchBytes: vi.fn(),
}));

vi.mock("../native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native")>();
  return { ...actual, native: true, httpFetch: mockHttpFetch, httpFetchBytes: mockHttpFetchBytes };
});

import { unwrapProxyUrl } from "../native";
import { cinejoyProvider, clearCinejoyServerCache, orderCinejoyServers } from "./cinejoy";
import { encDec, resetEncDecCooldown } from "./encdec";
import { clearHexaTokenCache, hexaProvider } from "./hexa";
import { meowtvProvider, trimMeowSubtitles } from "./meowtv";
import { extractVidupToken, vidupProvider } from "./vidup";

const ok = (url: string, body: unknown) => ({ status: 200, url, body: typeof body === "string" ? body : JSON.stringify(body) });
const encOk = (url: string, result: unknown) => ok(url, { status: 200, result });
const notFound = (url: string) => ({ status: 404, url, body: "" });

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
    key: "tmdb:movie:550",
    kind: "movie",
    title: "Fight Club",
    originalTitle: "Fight Club",
    overview: "",
    year: 1999,
    releaseDate: "1999-10-15",
    imdbId: "tt0137523",
    genres: [],
    cast: [],
    crew: [],
    related: [],
    ...overrides,
  };
}

const movieReq = (): PlaybackRequest => ({ media: makeMedia(), audio: "sub" });
const tvReq = (): PlaybackRequest => ({
  media: makeMedia({ key: "tmdb:tv:1399", kind: "tv", title: "Game of Thrones", originalTitle: "Game of Thrones", year: 2011 }),
  season: 1,
  episode: 2,
});
const signal = () => new AbortController().signal;

beforeEach(() => {
  mockHttpFetch.mockReset();
  mockHttpFetchBytes.mockReset();
  resetEncDecCooldown();
  clearHexaTokenCache();
  clearCinejoyServerCache();
});

describe("encDec", () => {
  it("returns results, maps service-level failures to null, and cools down after an outage", async () => {
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.includes("/good")) return encOk(url, { a: 1 });
      if (url.includes("/bad")) return ok(url, { status: 400, error: "bad input" });
      return { status: 502, url, body: "" };
    });
    expect(await encDec("good", {}, signal())).toEqual({ a: 1 });
    expect(await encDec("bad", {}, signal())).toBeNull();

    // One or two failures don't take every dependent extractor down...
    const err = await encDec("down", {}, signal()).catch((e: unknown) => e);
    expect(String(err)).toMatch(/enc-dec\.app unavailable/);
    expect((err as { dependencyOutage?: boolean }).dependencyOutage).toBe(true);
    await expect(encDec("down", {}, signal())).rejects.toThrow(/unavailable/);
    expect(await encDec("good", {}, signal())).toEqual({ a: 1 }); // success resets the streak

    // ...three in a row do.
    for (let i = 0; i < 3; i++) await expect(encDec("down", {}, signal())).rejects.toThrow(/unavailable/);
    mockHttpFetch.mockClear();
    await expect(encDec("good", {}, signal())).rejects.toThrow(/cooling down/);
    expect(mockHttpFetch).not.toHaveBeenCalled();
  });

  it("retries a 429 once and never runs more than 3 calls at a time", async () => {
    let calls = 0;
    mockHttpFetch.mockImplementation(async (url: string) => {
      calls++;
      return calls === 1 ? { status: 429, url, body: "" } : encOk(url, "ok");
    });
    expect(await encDec("x", {}, signal())).toBe("ok");
    expect(calls).toBe(2);

    let active = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    mockHttpFetch.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          gates.push(() => {
            active--;
            resolve(encOk(url, "ok"));
          });
        }),
    );
    const all = Promise.all(Array.from({ length: 7 }, () => encDec("y", {}, signal())));
    for (let i = 0; i < 7; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
    }
    expect(await all).toHaveLength(7);
    expect(peak).toBe(3);
  });
});

describe("hexaProvider", () => {
  it("solves the cap challenge once, reuses the token, and decrypts sources", async () => {
    const seenKeys: string[] = [];
    mockHttpFetch.mockImplementation(async (url: string, headers: Record<string, string> = {}, init?: { body?: string }) => {
      if (url === "https://cap.hexa.su/15d2cf0395/challenge") return ok(url, { challenge: { c: 1 }, token: "jwt" });
      if (url === "https://enc-dec.app/api/enc-hexa") return encOk(url, { solutions: [1], token: "jwt" });
      if (url === "https://cap.hexa.su/15d2cf0395/redeem") return ok(url, { success: true, token: "cap-tok", expires: Date.now() + 3600_000 });
      if (url.startsWith("https://theemoviedb.hexa.su/api/tmdb/")) {
        expect(headers["X-Cap-Token"]).toBe("cap-tok");
        seenKeys.push(headers["X-Api-Key"]);
        return ok(url, "ciphertext");
      }
      if (url === "https://enc-dec.app/api/dec-hexa") {
        expect(JSON.parse(init!.body!).key).toBe(seenKeys[seenKeys.length - 1]);
        return encOk(url, {
          sources: [
            { server: "alpha", url: "https://cdn.hexa.example/a.m3u8" },
            { server: "delta", url: "https://proxy.hexa.example/proxy?data=xyz" },
            { server: "dup", url: "https://cdn.hexa.example/a.m3u8" },
          ],
        });
      }
      return notFound(url);
    });

    const out = await hexaProvider.find(movieReq(), makeSettings(), signal());
    expect(out.map((c) => c.label)).toEqual(["Hexa · Alpha · HLS", "Hexa · Delta · HLS"]);
    expect(unwrapProxyUrl(out[0].url).headers.referer).toBe("https://hexa.su/");
    expect(seenKeys[0]).toMatch(/^[0-9a-f]{64}$/);

    await hexaProvider.find(tvReq(), makeSettings(), signal());
    const challengeCalls = mockHttpFetch.mock.calls.filter(([u]) => String(u).endsWith("/challenge"));
    expect(challengeCalls).toHaveLength(1);
    expect(mockHttpFetch.mock.calls.some(([u]) => u === "https://theemoviedb.hexa.su/api/tmdb/tv/1399/season/1/episode/2/images")).toBe(true);
  });

  it("shares one token mint between concurrent lookups and retries a failed decrypt with a fresh token", async () => {
    let mints = 0;
    let decrypts = 0;
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/challenge")) return ok(url, { challenge: {} });
      if (url === "https://enc-dec.app/api/enc-hexa") return encOk(url, { solutions: [] });
      if (url.endsWith("/redeem")) return ok(url, { token: `tok${++mints}`, expires: Date.now() + 3600_000 });
      if (url.startsWith("https://theemoviedb.hexa.su/")) return ok(url, "cipher");
      if (url === "https://enc-dec.app/api/dec-hexa") {
        // First decrypt fails (stale token); every later one works.
        return ++decrypts === 1 ? ok(url, { status: 500, error: "bad key" }) : encOk(url, { sources: [{ server: "a", url: "https://x.example/a.m3u8" }] });
      }
      return notFound(url);
    });

    const [a, b] = await Promise.all([
      hexaProvider.find(movieReq(), makeSettings(), signal()),
      hexaProvider.find(tvReq(), makeSettings(), signal()),
    ]);
    expect(a.length + b.length).toBe(2);
    // One shared mint up front, plus one fresh mint for the retry after the failed decrypt.
    expect(mints).toBe(2);
  });

  it("treats a valid empty source list as 'not on Hexa' without a second proof-of-work", async () => {
    let mints = 0;
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/challenge")) return ok(url, { challenge: {} });
      if (url === "https://enc-dec.app/api/enc-hexa") return encOk(url, {});
      if (url.endsWith("/redeem")) return ok(url, { token: `tok${++mints}` });
      if (url.startsWith("https://theemoviedb.hexa.su/")) return ok(url, "cipher");
      if (url === "https://enc-dec.app/api/dec-hexa") return encOk(url, { sources: [] });
      return notFound(url);
    });
    expect(await hexaProvider.find(movieReq(), makeSettings(), signal())).toEqual([]);
    expect(mints).toBe(1);
  });

  it("is disabled along with the Hexa embed and skips anime dubs", async () => {
    expect(hexaProvider.isEnabled?.(makeSettings({ disabledSources: ["hexa"] }))).toBe(false);
    const out = await hexaProvider.find(
      { media: makeMedia({ key: "anilist:1", kind: "anime" }), audio: "dub" },
      makeSettings(),
      signal(),
    );
    expect(out).toEqual([]);
    expect(mockHttpFetch).not.toHaveBeenCalled();
  });
});

describe("vidupProvider", () => {
  it("extracts the escaped page token", () => {
    expect(extractVidupToken(String.raw`self.__next_f.push([1,"{\"en\":\"abc_DEF-123\"}"])`)).toBe("abc_DEF-123");
    expect(extractVidupToken("<html></html>")).toBeNull();
  });

  it("runs both stages, resolves servers in parallel, and keeps the vidup Referer", async () => {
    const STAGE = "https://vidup.to/likzi/coc/v/x";
    mockHttpFetch.mockImplementation(async (url: string, headers: Record<string, string> = {}, init?: { body?: string }) => {
      if (url === "https://vidup.to/movie/550/") return ok(url, String.raw`{\"en\":\"PAGE_TOKEN\"}`);
      if (url === "https://enc-dec.app/api/enc-vidup?text=PAGE_TOKEN&stage=1") return encOk(url, { stage1: `${STAGE}/s1`, token: "" });
      if (url === `${STAGE}/s1`) return ok(url, "STAGE1_TEXT");
      if (url === "https://enc-dec.app/api/enc-vidup?text=STAGE1_TEXT&stage=2") {
        return encOk(url, { servers: `${STAGE}/servers`, stream: `${STAGE}/stream`, token: "csrf2" });
      }
      if (url === `${STAGE}/servers`) {
        expect(headers["X-CSRF-Token"]).toBe("csrf2");
        return ok(url, "SERVERS_ENC");
      }
      if (url === `${STAGE}/stream/aaa`) return ok(url, "STREAM_A");
      if (url === `${STAGE}/stream/bbb`) return ok(url, "STREAM_B");
      if (url === "https://enc-dec.app/api/dec-vidup") {
        const text = JSON.parse(init!.body!).text;
        if (text === "SERVERS_ENC") return encOk(url, [{ name: "Euro", data: "aaa" }, { name: "Zenith", data: "bbb" }, { name: "Bad", data: "../x" }]);
        if (text === "STREAM_A") return encOk(url, { url: "https://moon.example/vd/master.m3u8", noReferrer: false, tracks: [] });
        if (text === "STREAM_B") return encOk(url, { url: "https://moon.example/vdb/master.m3u8", noReferrer: true });
      }
      return notFound(url);
    });

    const out = await vidupProvider.find(movieReq(), makeSettings(), signal());
    expect(out.map((c) => c.label)).toEqual(["Vidup · Euro · HLS", "Vidup · Zenith · HLS"]);
    expect(unwrapProxyUrl(out[0].url).headers.referer).toBe("https://vidup.to/");
    expect(unwrapProxyUrl(out[1].url).headers.referer).toBeUndefined();
  });

  it("refuses stage URLs that point away from vidup", async () => {
    mockHttpFetch.mockImplementation(async (url: string) => {
      if (url === "https://vidup.to/movie/550/") return ok(url, String.raw`{\"en\":\"T\"}`);
      if (url.startsWith("https://enc-dec.app/api/enc-vidup")) return encOk(url, { stage1: "https://evil.example/s1", token: "" });
      return notFound(url);
    });
    expect(await vidupProvider.find(movieReq(), makeSettings(), signal())).toEqual([]);
    expect(mockHttpFetch.mock.calls.some(([u]) => String(u).startsWith("https://evil.example"))).toBe(false);
  });
});

describe("cinejoyProvider", () => {
  it("orders HLS servers first and MKV fallbacks last", () => {
    expect(orderCinejoyServers(["Orion", "Light", "New", "Nebula", "Lisbon"])).toEqual(["Nebula", "Lisbon", "Light", "New", "Orion"]);
  });

  it("posts the binary envelope, decrypts streams, and only falls back to MKV when HLS fails", async () => {
    mockHttpFetch.mockImplementation(async (url: string, _h: unknown, init?: { body?: string }) => {
      if (url === "https://api.wing.st/servers") {
        return ok(url, { servers: ["Light", "Lisbon", "Nebula", "Orion"].map((name) => ({ name, status: "ok" })) });
      }
      if (url.startsWith("https://enc-dec.app/api/enc-cinejoy?url=")) {
        const target = new URL(decodeURIComponent(url.split("url=")[1]));
        expect(target.searchParams.get("tmdb")).toBe("550");
        expect(target.searchParams.get("type")).toBe("movie");
        const server = target.searchParams.get("server")!;
        return encOk(url, { data: btoa(`req-${server}`).replace(/=+$/, ""), state: { server } });
      }
      if (url === "https://enc-dec.app/api/dec-cinejoy") {
        const { state } = JSON.parse(init!.body!);
        if (state.server === "Nebula") {
          return encOk(url, {
            status: 200,
            data: { stream: [{ type: "hls", playlist: "https://nebula.example/master.m3u8", captions: [{ url: "https://nebula.example/en.vtt", language: "en" }] }] },
          });
        }
        return encOk(url, { status: 404, data: {} });
      }
      return notFound(url);
    });
    mockHttpFetchBytes.mockImplementation(async (url: string, _h: unknown, opts: { method?: string; bodyBytes?: Uint8Array }) => {
      expect(url).toBe("https://api.wing.st/g");
      expect(opts.method).toBe("POST");
      expect(new TextDecoder().decode(opts.bodyBytes)).toMatch(/^req-/);
      return { status: 200, url, bytes: new Uint8Array([1, 2, 3]).buffer };
    });

    const out = await cinejoyProvider.find(movieReq(), makeSettings(), signal());
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Cinejoy · Nebula · HLS");
    expect(out[0].subtitles).toHaveLength(1);
    expect(unwrapProxyUrl(out[0].url).headers.referer).toBe("https://cinejoy.pk/");
    const servers = mockHttpFetch.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes("enc-cinejoy"))
      .map((u) => new URL(decodeURIComponent(u.split("url=")[1])).searchParams.get("server"));
    expect(servers).not.toContain("Orion");
  });
});

describe("meowtvProvider", () => {
  it("caps duplicate subtitle tracks per language", () => {
    const subs = trimMeowSubtitles([
      { label: "English", file: "https://s/en1.vtt" },
      { label: "English", file: "https://s/en2.vtt" },
      { label: "English", file: "https://s/en3.vtt" },
      { label: "French", file: "https://s/fr.vtt" },
      { label: "Broken" },
    ]);
    expect(subs.map((s) => s.label)).toEqual(["English", "English 2", "French"]);
  });

  it("uses a fresh ticket per stream request and retries the next server", async () => {
    let tickets = 0;
    mockHttpFetch.mockImplementation(async (url: string, headers: Record<string, string> = {}, init?: { body?: string }) => {
      if (url === "https://api.meowtv.ru/streams/ticket") return ok(url, { ticket: `t${++tickets}` });
      if (url === "https://api.meowtv.ru/streams/tv/1399/1/2?s=english") {
        expect(headers["X-Stream-Ticket"]).toBe("t1");
        return { status: 502, url, body: "" };
      }
      if (url === "https://api.meowtv.ru/streams/tv/1399/1/2?s=acme") {
        expect(headers["X-Stream-Ticket"]).toBe("t2");
        return ok(url, { n: "nonce", d: "cipher" });
      }
      if (url === "https://enc-dec.app/api/dec-meowtv") {
        expect(JSON.parse(init!.body!).data).toEqual({ n: "nonce", d: "cipher" });
        return encOk(url, { language: "English", url: "https://img1.cdn.example/hls/720/index.m3u8", headers: {} });
      }
      if (url === "https://api.meowtv.ru/subs/tv/1399/1/2") return ok(url, [{ label: "English", file: "https://rezesubs.example/en.vtt" }]);
      return notFound(url);
    });

    const out = await meowtvProvider.find(tvReq(), makeSettings(), signal());
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("MeowTV · English · HLS");
    expect(out[0].subtitles).toHaveLength(1);
    expect(tickets).toBe(2);
  });
});
