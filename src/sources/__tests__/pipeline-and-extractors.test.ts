import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../../lib/settings";
import type { PlaybackRequest } from "../../lib/types";

const { mockHttpFetch } = vi.hoisted(() => ({
  mockHttpFetch: vi.fn(),
}));

vi.mock("../native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../native")>()),
  native: true,
  httpFetch: mockHttpFetch,
}));

import { anizoneProvider, parseAnizoneCards, parseAnizonePlayer } from "../extractors/anizone";
import {
  decodeHtmlEntities,
  NON_BROWSER_STREAM_UA,
  resolveExtractorStreamHeaders,
  unescapeJsString,
} from "../extractors/common";
import {
  badUrl,
  CIRCUIT_STREAK_THRESHOLD,
  getHealth,
  isCircuitOpen,
  recordPlayback,
  resetHealth,
} from "../health";
import { proxyUrl } from "../native";
import { candKey, clearDeadHosts, looksLikeMedia, playCheck, validateManifest } from "../registry";
import { invalidateSessions, SourceSession, type SessionDeps } from "../session";
import type { SourceProvider, StreamCandidate } from "../types";

const request = (key = "tmdb:movie:550", extraMedia: Record<string, unknown> = {}): PlaybackRequest => ({
  media: {
    key,
    kind: "movie",
    title: "Fight Club",
    overview: "",
    genres: [],
    ...extraMedia,
  } as PlaybackRequest["media"],
});

const directCand = (pid: string, url = `https://${pid}.example/master.m3u8`): StreamCandidate => ({
  providerId: pid,
  providerName: pid,
  label: pid,
  url,
  kind: "hls",
  via: "direct",
});

const embedCand = (pid: string): StreamCandidate => ({
  providerId: pid,
  providerName: pid,
  label: pid,
  url: `https://${pid}.example/embed/550`,
  pageUrl: `https://${pid}.example/embed/550`,
  kind: "embed",
  via: "embed",
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

beforeEach(() => {
  mockHttpFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  invalidateSessions();
  resetHealth();
  clearDeadHosts();
  localStorage.clear();
});

describe("validateManifest and playCheck regressions", () => {
  it("accepts VixSrc-style .html?token=... disguised HLS segments", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const manifest = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.0,",
      `https://cdn.vixcloud.co/seg/0000-0250.html?token=tok123&expires=${futureExp}`,
      "#EXTINF:5.5,",
      `0001-0250.html?token=tok456&expires=${futureExp}`,
      "#EXT-X-ENDLIST",
    ].join("\n");

    const res = validateManifest(manifest, "https://vixcloud.co/playlist/170060?type=video");
    expect(res.ok).toBe(true);
    expect(res.kind).toBe("hls");
    expect(res.segmentCount).toBe(2);
  });

  it("unwraps abxs proxy URLs (both http://abxs.localhost and abxs://localhost) during manifest validation", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const pastExp = Math.floor(Date.now() / 1000) - 120;

    const validSegProxy = proxyUrl(`https://cdn.example/seg/001.html?token=ok&expires=${futureExp}`, {
      referer: "https://vixsrc.to/",
    });
    const manifestWithProxiedSeg = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.0,",
      validSegProxy,
      "#EXT-X-ENDLIST",
    ].join("\n");

    const parentProxy = proxyUrl(`https://cdn.example/playlist.m3u8?expires=${futureExp}`, {
      referer: "https://vixsrc.to/",
    });
    expect(validateManifest(manifestWithProxiedSeg, parentProxy).ok).toBe(true);

    // Works for explicit abxs://localhost/p?... URLs as well
    const abxsSchemeSeg = validSegProxy.replace(/^http:\/\/abxs\.localhost/i, "abxs://localhost");
    const manifestWithAbxsScheme = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.0,",
      abxsSchemeSeg,
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(validateManifest(manifestWithAbxsScheme, "abxs://localhost/p?u=aHR0cHM6Ly9jZG4uZXhhbXBsZS9wbGF5bGlzdC5tM3U4").ok).toBe(true);

    // Expired token inside an abxs-wrapped base URL or segment line must still be rejected
    const expiredParentProxy = proxyUrl(`https://cdn.example/master.m3u8?expires=${pastExp}`, {
      referer: "https://vixsrc.to/",
    });
    expect(validateManifest(manifestWithProxiedSeg, expiredParentProxy)).toMatchObject({
      ok: false,
      error: "token expired",
    });

    const expiredSegProxy = proxyUrl(`https://cdn.example/seg/001.ts?expires=${pastExp}`, {
      referer: "https://vixsrc.to/",
    });
    expect(
      validateManifest(`#EXTM3U\n#EXTINF:6.0,\n${expiredSegProxy}\n`, "https://cdn.example/playlist.m3u8"),
    ).toMatchObject({ ok: false, error: "token expired" });

    // Error segment hidden behind abxs proxy must still be caught by BAD_SEGMENT_RX
    const badSegProxy = proxyUrl("https://cdn.example/hls/error.ts", { referer: "https://vixsrc.to/" });
    expect(
      validateManifest(`#EXTM3U\n#EXTINF:6.0,\n${badSegProxy}\n`, "https://cdn.example/playlist.m3u8"),
    ).toMatchObject({ ok: false, error: "error segment in playlist" });
  });

  it("rejects javascript:, data:text/html, and < HTML documents both at top level and inside playlists", () => {
    expect(validateManifest("<!doctype html><html><body>Denied</body></html>", "https://cdn.example/m.m3u8").ok).toBe(false);
    expect(validateManifest("<html><script>alert(1)</script></html>").ok).toBe(false);
    expect(validateManifest("#EXTM3U\n#EXTINF:6.0,\n<script>alert(1)</script>", "https://cdn.example/m.m3u8").ok).toBe(false);
    expect(validateManifest("#EXTM3U\n#EXTINF:6.0,\n<error>bad</error>", "https://cdn.example/m.m3u8")).toMatchObject({
      ok: false,
      error: "invalid URI in playlist",
    });
    expect(validateManifest("#EXTM3U\n#EXTINF:6.0,\njavascript:alert(1)", "https://cdn.example/m.m3u8")).toMatchObject({
      ok: false,
      error: "invalid URI in playlist",
    });
    expect(validateManifest("#EXTM3U\n#EXTINF:6.0,\ndata:text/html,<h1>Hi</h1>", "https://cdn.example/m.m3u8")).toMatchObject({
      ok: false,
      error: "invalid URI in playlist",
    });

    const proxiedJs = proxyUrl("javascript:alert(1)");
    expect(validateManifest(`#EXTM3U\n#EXTINF:6.0,\n${proxiedJs}`, "https://cdn.example/m.m3u8")).toMatchObject({
      ok: false,
      error: "invalid URI in playlist",
    });
  });

  it("recognizes WebM/MKV EBML magic bytes and retries playCheck without Range on HTTP 400/403", async () => {
    expect(looksLikeMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]))).toBe(true);

    const tsChunk = new Uint8Array(512);
    tsChunk[0] = 0x47;
    tsChunk[188] = 0x47;
    tsChunk[376] = 0x47;

    const seenHeaders: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const hdrs = init?.headers as Record<string, string> | undefined;
        seenHeaders.push(hdrs);
        if (url.endsWith("master.m3u8")) {
          return new Response("#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n", { status: 200 });
        }
        if (hdrs && "Range" in hdrs) {
          return new Response("Range forbidden", { status: 403 });
        }
        return new Response(tsChunk, { status: 200 });
      }),
    );

    const result = await playCheck(directCand("vixsrc", "https://cdn.example/master.m3u8"));
    expect(result).toEqual({ ok: true, quality: undefined });
    expect(seenHeaders.length).toBe(3);
    expect(seenHeaders[1]).toMatchObject({ Range: "bytes=0-65535" });
    expect(seenHeaders[2]).toBeUndefined();
  });
});

describe("health recordPlayback regressions", () => {
  it("increments failure streak by exactly 1 per recordPlayback(..., false) call", () => {
    const req = request();
    const cand: StreamCandidate = {
      ...directCand("zxcstreams"),
      url: "https://cdn.example/1.m3u8",
      pageUrl: "https://zxcstream.cc/player/movie/550",
    };

    recordPlayback(req, { ...cand, url: "https://cdn.example/a.m3u8" }, false);
    expect(getHealth("zxcstreams").streak).toBe(1);
    expect(isCircuitOpen("zxcstreams")).toBe(false);

    recordPlayback(req, { ...cand, url: "https://cdn.example/b.m3u8" }, false);
    expect(getHealth("zxcstreams").streak).toBe(2);
    expect(isCircuitOpen("zxcstreams")).toBe(false);

    recordPlayback(req, { ...cand, url: "https://cdn.example/c.m3u8" }, false);
    expect(getHealth("zxcstreams").streak).toBe(CIRCUIT_STREAK_THRESHOLD);
    expect(isCircuitOpen("zxcstreams")).toBe(true);
  });

  it("unwraps abxs proxy URLs in badUrls and never blacklists embed pageUrl", () => {
    const req = request();
    const rawStream = "https://cdn.example/dead-token.m3u8?exp=9999999999";
    const proxiedStream = proxyUrl(rawStream, { referer: "https://vidfast.vc/" });
    const pageUrl = "https://vidfast.vc/movie/550";

    const sniffedCand: StreamCandidate = {
      providerId: "vidfast",
      providerName: "VidFast",
      label: "VidFast",
      url: proxiedStream,
      pageUrl,
      kind: "hls",
      via: "sniffed",
    };

    recordPlayback(req, sniffedCand, false);

    expect(badUrl(rawStream)).toBe(true);
    expect(badUrl(proxiedStream)).toBe(true);
    expect(badUrl(proxiedStream.replace(/^http:\/\/abxs\.localhost/i, "abxs://localhost"))).toBe(true);
    expect(badUrl(pageUrl)).toBe(false);
  });
});

describe("session stopBackground, holdMs, confirm, and failover regressions", () => {
  const provider = (
    id: string,
    category: SourceProvider["category"],
    found: StreamCandidate[] | (() => Promise<StreamCandidate[]>),
    priority = category === "embed" ? 15 : 24,
  ): SourceProvider => ({
    id,
    name: id,
    category,
    priority,
    isEnabled: () => true,
    find: () => (typeof found === "function" ? found() : Promise.resolve(found)),
  });

  function makeSession(providers: SourceProvider[], opts: { probeMs?: number; req?: PlaybackRequest; confirm?: SessionDeps["confirm"] } = {}) {
    const calls: string[] = [];
    const probe = async (c: StreamCandidate, signal: AbortSignal): Promise<StreamCandidate> => {
      calls.push(c.providerId);
      try {
        await sleep(opts.probeMs ?? 1000, signal);
      } catch {
        return { ...c, probe: { ok: false, latencyMs: 0, error: "AbortError" } };
      }
      return {
        ...c,
        url: c.kind === "embed" ? `https://cdn.example/${c.providerId}.m3u8` : c.url,
        kind: c.kind === "embed" ? "hls" : c.kind,
        via: c.kind === "embed" ? "sniffed" : c.via,
        probe: { ok: true, latencyMs: opts.probeMs ?? 1000, quality: 1080 },
      };
    };
    const confirm = opts.confirm ?? vi.fn(async () => ({ ok: true }));
    const session = new SourceSession(opts.req ?? request(), {
      providers,
      settings: getSettings(),
      probe,
      capture: probe,
      confirm,
    });
    return { session, calls, confirm };
  }

  it("stopBackground halts background probing cleanly with zero ready candidates without looping", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const embeds = ["e1", "e2", "e3", "e4"].map((id) => provider(id, "embed", [embedCand(id)]));
    const { session, calls } = makeSession(embeds, { probeMs: 4000 });

    session.start(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.length).toBe(3);
    expect(session.getSnapshot().ready).toBe(0);

    session.stopBackground();
    await vi.advanceTimersByTimeAsync(10);
    const callsAfterStop = calls.length;
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().checking.size).toBe(0);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.length).toBe(callsAfterStop);
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().ready).toBe(0);

    // Explicit want/checkAll resumes probing cleanly afterwards
    session.want(1);
    await vi.advanceTimersByTimeAsync(4100);
    expect(session.getSnapshot().ready).toBeGreaterThanOrEqual(1);
  });

  it("holdMs is 0 when no applicable direct extractors exist or when applicable direct extractors finish empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });

    // Case 1: Only anime-only and Asian-drama-only direct providers on an English movie request -> holdMs = 0
    const nonApplicable = makeSession(
      [
        provider("anizone", "external", () => sleep(5000).then(() => [])),
        provider("animeheaven", "external", () => sleep(5000).then(() => [])),
        provider("onetouchtv", "external", () => sleep(5000).then(() => [])),
        provider("vidfast", "embed", [embedCand("vidfast")]),
      ],
      { probeMs: 20 },
    );
    nonApplicable.session.start(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(nonApplicable.calls).toEqual(["vidfast"]);

    // Case 2: Applicable direct provider answers empty quickly, and resume() sees holdMs === 0
    const applicableEmpty = makeSession(
      [
        provider("zxcstreams", "external", () => sleep(40).then(() => [])),
        provider("vidfast", "embed", [embedCand("vidfast")]),
      ],
      { probeMs: 20 },
    );
    applicableEmpty.session.start(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(applicableEmpty.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(applicableEmpty.calls).toEqual(["vidfast"]);

    // Also test resume() after stopBackground() once applicable direct extractors are already exhausted with 0 ready
    const resumeHoldZero = makeSession(
      [
        provider("zxcstreams", "external", []),
        provider("vidfast", "embed", [embedCand("vidfast")]),
      ],
      { probeMs: 1000 },
    );
    resumeHoldZero.session.start(1);
    await vi.advanceTimersByTimeAsync(5);
    resumeHoldZero.session.stopBackground();
    await vi.advanceTimersByTimeAsync(5);
    (resumeHoldZero.session as unknown as { captureOpen: boolean }).captureOpen = false;
    resumeHoldZero.session.want(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(resumeHoldZero.calls).toContain("vidfast");
  });

  it("skips confirm() for abxs-proxied sniffed streams and guards concurrent failover/commit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });

    // 1. Proxied sniffed candidate bypasses duplicate confirm()
    const proxiedSniffUrl = proxyUrl("https://cdn.example/sniffed.m3u8", { referer: "https://vidfast.vc/" });
    const confirmSpy = vi.fn(async () => ({ ok: true }));
    const sniffSession = new SourceSession(request(), {
      providers: [provider("vidfast", "embed", [embedCand("vidfast")])],
      settings: getSettings(),
      probe: async (c) => ({
        ...c,
        url: proxiedSniffUrl,
        kind: "hls",
        via: "sniffed",
        probe: { ok: true, latencyMs: 50, quality: 1080 },
      }),
      capture: async (c) => c,
      confirm: confirmSpy,
    });
    sniffSession.start(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(sniffSession.getSnapshot().pick?.url).toBe(proxiedSniffUrl);
    expect(confirmSpy).not.toHaveBeenCalled();

    // 2. Pending confirm() cancelled by report(false) + failover() never double-commits dead first stream
    let resolveConfirm!: (v: { ok: boolean }) => void;
    const pendingConfirm = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const raceSession = new SourceSession(request("tmdb:movie:551"), {
      providers: [
        provider("zxcstreams", "external", [directCand("zxcstreams")], 25),
        provider("vidrock", "external", [directCand("vidrock")], 20),
      ],
      settings: getSettings(),
      probe: async (c) => ({ ...c, probe: { ok: true, latencyMs: 20, quality: 1080 } }),
      capture: async (c) => c,
      confirm: pendingConfirm,
    });
    raceSession.start(2);
    await vi.advanceTimersByTimeAsync(400);
    const first = raceSession.find("zxcstreams")!;
    raceSession.report(candKey(first), false, { error: "segment dead" });
    const nextPromise = raceSession.failover(candKey(first));
    // Resolve stale confirm from zxcstreams while failover is running
    resolveConfirm({ ok: true });
    await vi.advanceTimersByTimeAsync(50);
    const next = await nextPromise;
    expect(next?.providerId).toBe("vidrock");
    expect(raceSession.getSnapshot().pick?.providerId).toBe("vidrock");
  });
});

describe("common.ts HTML-entity decoding, JSON unescaping, hakunaymatata headers, and anizone parsing", () => {
  it("decodes HTML entities in a single pass and keeps JSON string escapes intact", () => {
    expect(decodeHtmlEntities("Tom &amp;amp; Jerry &amp;quot;Movie&amp;quot; &#39;0&#x27;&nbsp;")).toBe(
      `Tom &amp; Jerry &quot;Movie&quot; '0'`,
    );
    expect(decodeHtmlEntities("&lt;div&gt;&apos;ok&apos;&lt;/div&gt;")).toBe("<div>'ok'</div>");

    const rawJs = `{"title":"Line1\\nLine2 \\"Quoted\\" It\\'s \\/ \\u0027ok\\u0027"}`;
    const unescaped = unescapeJsString(rawJs);
    expect(JSON.parse(unescaped)).toEqual({
      title: `Line1\nLine2 "Quoted" It's / 'ok'`,
    });
  });

  it("parses HTML-entity encoded Alpine x-data cards and vidstackPlayer JSON cleanly", () => {
    const itemsJson = JSON.stringify([
      {
        slug: "jjk-tv-1",
        main_title: `Jujutsu Kaisen "Special"\nArc & More`,
        title_list: { jp: "呪術廻戦" },
        type: "TV Series",
        start_year: 2020,
        episode_count: 24,
      },
    ])
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");

    const htmlEncodedAttr = itemsJson
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const searchHtml = `<div x-data="{ items: JSON.parse('${htmlEncodedAttr}') }"></div>`;
    const cards = parseAnizoneCards(searchHtml);
    expect(cards).toHaveLength(1);
    expect(cards[0].sid).toBe("jjk-tv-1");
    expect(cards[0].titles[0]).toBe(`Jujutsu Kaisen "Special"\nArc & More`);
    expect(cards[0].titles[1]).toBe("呪術廻戦");

    const playerJson = JSON.stringify({
      src: "https://seiryuu.vid-cdn.xyz/ep1/master.m3u8",
      subtitles: [
        {
          file: "https://seiryuu.vid-cdn.xyz/subs/en.ass",
          language: "eng",
          title: 'English "Full"',
          default: true,
        },
      ],
    })
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");

    const playerAttr = playerJson.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const epHtml = `<div x-data="vidstackPlayer(JSON.parse('${playerAttr}'))"></div>`;
    const parsedPlayer = parseAnizonePlayer(epHtml);
    expect(parsedPlayer.m3u8).toBe("https://seiryuu.vid-cdn.xyz/ep1/master.m3u8");
    expect(parsedPlayer.subs).toHaveLength(1);
    expect(parsedPlayer.subs[0]).toMatchObject({
      url: "https://seiryuu.vid-cdn.xyz/subs/en.ass",
      lang: "eng",
      label: 'English "Full"',
      isDefault: true,
    });
  });

  it("continues anizone search loop when pickBestAnizoneCard rejects the first query's cards", async () => {
    const wrongCardHtml = `<div x-data="{ items: JSON.parse('[{\\"slug\\":\\"unrelated-1\\",\\"main_title\\":\\"Completely Different Show\\",\\"type\\":\\"TV Series\\",\\"start_year\\":2015}]') }"></div>`;
    const rightCardHtml = `<div x-data="{ items: JSON.parse('[{\\"slug\\":\\"jjk-slug\\",\\"main_title\\":\\"Jujutsu Kaisen\\",\\"type\\":\\"TV Series\\",\\"start_year\\":2020}]') }"></div>`;
    const epHtml = `<div x-data="vidstackPlayer(JSON.parse('{&quot;src&quot;:&quot;https:\\/\\/seiryuu.vid-cdn.xyz\\/jjk\\/1.m3u8&quot;,&quot;subtitles&quot;:[]}'))"></div>`;

    const fetched: string[] = [];
    mockHttpFetch.mockImplementation(async (url: string) => {
      fetched.push(url);
      if (url.includes("search=WRONG_ORIG")) return { status: 200, url, body: wrongCardHtml };
      if (url.includes("search=Jujutsu")) return { status: 200, url, body: rightCardHtml };
      if (url === "https://anizone.to/anime/jjk-slug/1") return { status: 200, url, body: epHtml };
      if (url === "https://seiryuu.vid-cdn.xyz/jjk/1.m3u8") return { status: 200, url, body: "#EXTM3U\n#EXTINF:6,\nseg.ts\n" };
      return { status: 404, url, body: "" };
    });

    const out = await anizoneProvider.find(
      {
        media: {
          key: "anilist:113415",
          kind: "anime",
          title: "Jujutsu Kaisen",
          originalTitle: "WRONG_ORIG",
          year: 2020,
          overview: "",
          genres: [],
        },
        episode: 1,
        audio: "sub",
      },
      getSettings(),
      new AbortController().signal,
    );

    expect(fetched.some((u) => u.includes("WRONG_ORIG"))).toBe(true);
    expect(fetched.some((u) => u.includes("Jujutsu"))).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].pageUrl).toBe("https://anizone.to/anime/jjk-slug/1");
  });

  it("strips Referer/Origin and forces non-browser UA for hakunaymatata.com media hosts", () => {
    const haku = resolveExtractorStreamHeaders(
      "https://bcdn.hakunaymatata.com/video/550.mp4",
      "https://zxcstream.cc/",
      "https://zxcstream.cc",
    );
    expect(haku.headers).toEqual({ ua: NON_BROWSER_STREAM_UA });
    expect(haku.headers.referer).toBeUndefined();
    expect(haku.headers.origin).toBeUndefined();
    expect(haku.fallbackReferer).toBeUndefined();

    const normal = resolveExtractorStreamHeaders(
      "https://vidstuck.cc/hls/master.m3u8",
      "https://zxcstream.cc/",
      "https://zxcstream.cc",
    );
    expect(normal.headers.referer).toBe("https://zxcstream.cc/");
    expect(normal.headers.origin).toBe("https://zxcstream.cc");
  });
});
