import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";

const { mockHttpFetch } = vi.hoisted(() => ({
  mockHttpFetch: vi.fn(),
}));

vi.mock("./native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native")>();
  return {
    ...actual,
    native: true,
    httpFetch: mockHttpFetch,
  };
});

import { unwrapProxyUrl } from "./native";
import {
  clearPlugins,
  clearPluginScriptCache,
  createPluginProviders,
  getPlugin,
  installPlugin,
  listPlugins,
  MAX_PLUGIN_HTTP_CALLS,
  MAX_PLUGIN_SCRIPT_BYTES,
  normalizePluginCandidates,
  PLUGINS_STORAGE_KEY,
  pluginProvidersSource,
  removePlugin,
  runPlugin,
  togglePlugin,
  validatePluginFetchUrl,
  validatePluginManifest,
  type ProviderPluginManifest,
} from "./pluginRunner";

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

const movieReq: PlaybackRequest = {
  media: {
    key: "tmdb:movie:603",
    kind: "movie",
    title: "The Matrix",
    overview: "",
    genres: [],
    year: 1999,
    tmdbId: 603,
    originalLanguage: "en",
  },
};

const tvReq: PlaybackRequest = {
  media: {
    key: "tmdb:tv:1399",
    kind: "tv",
    title: "Game of Thrones",
    overview: "",
    genres: [],
    year: 2011,
    tmdbId: 1399,
  },
  season: 1,
  episode: 2,
};

function makeManifest(overrides: Partial<ProviderPluginManifest> = {}): ProviderPluginManifest {
  return {
    id: "sample-provider",
    name: "Sample Provider",
    version: "1.0.0",
    mediaTypes: ["movie", "tv"],
    allowedHosts: ["api.sample.test"],
    script: `module.exports = { async find(req, host) { return []; } };`,
    enabled: true,
    priority: 20,
    ...overrides,
  };
}

interface InstalledWorkerEnv {
  workers: MockVmWorker[];
  revokedUrls: string[];
  ambientFetchSpy: ReturnType<typeof vi.fn>;
  ambientImportScriptsSpy: ReturnType<typeof vi.fn>;
}

class MockVmWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  terminated = false;
  postedMessages: unknown[] = [];

  private listeners: Array<(ev: { data: unknown }) => void> = [];
  private ambientFetchSpy: ReturnType<typeof vi.fn>;
  private ambientImportScriptsSpy: ReturnType<typeof vi.fn>;

  constructor(
    scriptText: string,
    ambientFetchSpy: ReturnType<typeof vi.fn>,
    ambientImportScriptsSpy: ReturnType<typeof vi.fn>,
  ) {
    this.ambientFetchSpy = ambientFetchSpy;
    this.ambientImportScriptsSpy = ambientImportScriptsSpy;

    const sandbox: Record<string, unknown> = {
      Map,
      Set,
      Promise,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Error,
      TypeError,
      RegExp,
      JSON,
      Math,
      Date,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      atob,
      btoa,
      setTimeout,
      clearTimeout,
      navigator: { sendBeacon: vi.fn() },
      // Seed unsafe WebWorker globals so we verify the sandbox bootstrap strips/shadows them.
      fetch: this.ambientFetchSpy,
      XMLHttpRequest: function MockXHR() {},
      WebSocket: function MockWS() {},
      EventSource: function MockES() {},
      importScripts: this.ambientImportScriptsSpy,
      BroadcastChannel: function MockBC() {},
      Worker: function MockNestedWorker() {},
      SharedWorker: function MockSharedWorker() {},
      caches: {},
      indexedDB: {},
      postMessage: (data: unknown) => {
        if (this.terminated) return;
        queueMicrotask(() => {
          if (!this.terminated) {
            this.onmessage?.({ data } as MessageEvent);
          }
        });
      },
      addEventListener: (type: string, fn: (ev: { data: unknown }) => void) => {
        if (type === "message") this.listeners.push(fn);
      },
      removeEventListener: () => {},
      dispatchEvent: () => true,
      close: () => {
        this.terminated = true;
      },
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    const keys = Object.keys(sandbox);
    const values = keys.map((k) => sandbox[k]);
    const runner = new Function(...keys, `"use strict";\n${scriptText}`);
    runner(...values);
  }

  postMessage(data: unknown): void {
    if (this.terminated) return;
    this.postedMessages.push(data);
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const fn of this.listeners) {
        fn({ data });
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function installVmWorkerEnv(): InstalledWorkerEnv {
  const blobContents = new Map<string, string>();
  const workers: MockVmWorker[] = [];
  const revokedUrls: string[] = [];
  const ambientFetchSpy = vi.fn();
  const ambientImportScriptsSpy = vi.fn();
  let blobSeq = 0;

  class HarnessBlob {
    readonly textContent: string;
    readonly type: string;
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      this.textContent = parts.map((p) => String(p)).join("");
      this.type = options?.type ?? "";
    }
  }

  vi.stubGlobal("Blob", HarnessBlob);
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: (blob: unknown) => {
      const url = `blob:abx-test-${++blobSeq}`;
      const content = blob instanceof HarnessBlob ? blob.textContent : "";
      blobContents.set(url, content);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
      blobContents.delete(url);
    },
  }));

  vi.stubGlobal("Worker", function WorkerCtor(blobUrl: string) {
    const script = blobContents.get(blobUrl) ?? "";
    const w = new MockVmWorker(script, ambientFetchSpy, ambientImportScriptsSpy);
    workers.push(w);
    return w;
  });

  return { workers, revokedUrls, ambientFetchSpy, ambientImportScriptsSpy };
}

beforeEach(() => {
  clearPlugins();
  clearPluginScriptCache();
  mockHttpFetch.mockReset();
});

afterEach(() => {
  clearPlugins();
  clearPluginScriptCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("manifest validation & localStorage persistence", () => {
  it("validates and normalizes a valid inline manifest", () => {
    const valid = validatePluginManifest({
      id: "  my.plugin-1 ",
      name: " My Plugin ",
      version: "1.2.0",
      mediaTypes: ["movie", "tv", "movie"],
      allowedHosts: [" API.Example.COM. ", "*.CDN.Example.com"],
      script: "module.exports = async () => [];",
      enabled: true,
      priority: 15,
      timeoutMs: 5000,
    });

    expect(valid).toEqual({
      id: "my.plugin-1",
      name: "My Plugin",
      version: "1.2.0",
      mediaTypes: ["movie", "tv"],
      allowedHosts: ["api.example.com", "*.cdn.example.com"],
      script: "module.exports = async () => [];",
      enabled: true,
      priority: 15,
      timeoutMs: 5000,
    });
  });

  it("rejects malformed manifests, missing scripts, and SSRF allowedHosts/scriptUrl", () => {
    expect(() => validatePluginManifest(null)).toThrow();
    expect(() => validatePluginManifest(makeManifest({ id: "../bad" }))).toThrow(/id/i);
    expect(() => validatePluginManifest(makeManifest({ name: "   " }))).toThrow(/name/i);
    expect(() => validatePluginManifest(makeManifest({ version: "1.0 beta" }))).toThrow(/version/i);
    expect(() => validatePluginManifest(makeManifest({ mediaTypes: [] }))).toThrow(/mediaType/i);
    expect(() => validatePluginManifest(makeManifest({ mediaTypes: ["podcast" as "movie"] }))).toThrow(/mediaType/i);
    expect(() => validatePluginManifest(makeManifest({ allowedHosts: ["localhost"] }))).toThrow();
    expect(() => validatePluginManifest(makeManifest({ allowedHosts: ["127.0.0.1"] }))).toThrow();
    expect(() => validatePluginManifest(makeManifest({ allowedHosts: ["abxs.localhost"] }))).toThrow();
    expect(() => validatePluginManifest(makeManifest({ allowedHosts: ["https://api.example.com"] }))).toThrow();
    expect(() => validatePluginManifest(makeManifest({ script: "   ", scriptUrl: undefined }))).toThrow(/script/i);
    expect(() => validatePluginManifest(makeManifest({ script: undefined, scriptUrl: "http://127.0.0.1/p.js" }))).toThrow(/SSRF/i);
    expect(() => validatePluginManifest(makeManifest({ script: "x".repeat(MAX_PLUGIN_SCRIPT_BYTES + 1) }))).toThrow(/limit/i);
    expect(() => validatePluginManifest(makeManifest({ enabled: "yes" as unknown as boolean }))).toThrow(/enabled/i);
    expect(() => validatePluginManifest(makeManifest({ priority: Number.NaN }))).toThrow(/priority/i);
  });

  it("persists CRUD operations in abx.plugins.v1 and ignores corrupt entries", () => {
    const p1 = installPlugin(makeManifest({ id: "alpha", name: "Alpha", priority: 10 }));
    const p2 = installPlugin(makeManifest({ id: "beta", name: "Beta", priority: 30, enabled: false }));

    expect(p1.id).toBe("alpha");
    expect(p2.id).toBe("beta");
    expect(localStorage.getItem(PLUGINS_STORAGE_KEY)).toBeTruthy();

    // Sorted by priority descending
    expect(listPlugins().map((p) => p.id)).toEqual(["beta", "alpha"]);
    expect(getPlugin("alpha")?.enabled).toBe(true);

    // Toggle flips or sets explicit boolean
    expect(togglePlugin("beta")?.enabled).toBe(true);
    expect(togglePlugin("beta", false)?.enabled).toBe(false);
    expect(togglePlugin("non-existent")).toBeNull();

    // Re-installing existing ID updates in place
    installPlugin(makeManifest({ id: "alpha", name: "Alpha v2", version: "2.0.0", priority: 40 }));
    expect(listPlugins().map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(getPlugin("alpha")?.version).toBe("2.0.0");

    // Inject corrupt record alongside valid entries in localStorage
    const raw = JSON.parse(localStorage.getItem(PLUGINS_STORAGE_KEY)!) as unknown[];
    raw.push({ id: "broken", enabled: "nope" });
    localStorage.setItem(PLUGINS_STORAGE_KEY, JSON.stringify(raw));
    expect(listPlugins().map((p) => p.id)).toEqual(["alpha", "beta"]);

    // Remove
    expect(removePlugin("alpha")).toBe(true);
    expect(removePlugin("alpha")).toBe(false);
    expect(listPlugins().map((p) => p.id)).toEqual(["beta"]);
  });
});

describe("SSRF & host-allowlist validation", () => {
  it("allows safe public http/https URLs and enforces allowedHosts when non-empty", () => {
    expect(validatePluginFetchUrl("https://api.sample.test/v1/search?q=matrix")).toBe(
      "https://api.sample.test/v1/search?q=matrix",
    );
    expect(validatePluginFetchUrl("https://api.sample.test/v1", ["api.sample.test"])).toBe(
      "https://api.sample.test/v1",
    );
    expect(validatePluginFetchUrl("https://edge1.cdn.sample.test/hls/master.m3u8", ["*.cdn.sample.test"])).toBe(
      "https://edge1.cdn.sample.test/hls/master.m3u8",
    );

    expect(() => validatePluginFetchUrl("https://evil.test/steal", ["api.sample.test"])).toThrow(/allowedHosts/);
    expect(() => validatePluginFetchUrl("https://cdn.sample.test/master.m3u8", ["*.cdn.sample.test"])).toThrow(/allowedHosts/);
    expect(() => validatePluginFetchUrl("https://cdn.sample.test.evil.com/x", ["*.cdn.sample.test"])).toThrow(/allowedHosts/);
  });

  it("blocks non-http(s) schemes, credentials, localhost, abxs.localhost, and private/reserved IPs", () => {
    const blockedUrls = [
      "file:///etc/passwd",
      "data:text/javascript,alert(1)",
      "javascript:alert(1)",
      "abxs://localhost/p?u=abc",
      "ftp://example.com/file",
      "https://user:pass@api.example.com/data",
      "http://localhost:1420/secret",
      "http://abxs.localhost/p?u=123",
      "http://sub.localhost/api",
      "http://service.internal/token",
      "http://printer.local/status",
      "http://127.0.0.1:8080/",
      "http://127.0.1.1/",
      "http://0.0.0.0/",
      "http://10.0.0.5/api",
      "http://172.16.0.1/api",
      "http://172.31.255.254/api",
      "http://192.168.1.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://224.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ];

    for (const u of blockedUrls) {
      expect(() => validatePluginFetchUrl(u), `Expected ${u} to be blocked`).toThrow();
    }

    // Public IPv4 outside RFC 1918 / reserved ranges should be allowed
    expect(validatePluginFetchUrl("https://172.15.255.255/ok")).toBe("https://172.15.255.255/ok");
    expect(validatePluginFetchUrl("https://172.32.0.1/ok")).toBe("https://172.32.0.1/ok");
    expect(validatePluginFetchUrl("https://1.1.1.1/dns-query")).toBe("https://1.1.1.1/dns-query");
  });
});

describe("WebWorker sandbox execution & RPC bridge", () => {
  it("strips unsafe worker globals and routes network calls exclusively through host.httpFetch", async () => {
    const env = installVmWorkerEnv();

    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "https://api.sample.test/streams/603",
      body: JSON.stringify({
        stream: "https://cdn.stream.test/matrix/master.m3u8",
        sub: "https://cdn.stream.test/matrix/en.vtt",
      }),
    });

    const manifest = makeManifest({
      id: "matrix-plugin",
      name: "Matrix Plugin",
      allowedHosts: ["api.sample.test"],
      script: `
        module.exports = {
          async find(req, host) {
            if (typeof fetch !== "undefined" || typeof globalThis.fetch !== "undefined") {
              throw new Error("fetch was not stripped");
            }
            if (typeof XMLHttpRequest !== "undefined" || typeof WebSocket !== "undefined" || typeof EventSource !== "undefined") {
              throw new Error("network constructor was not stripped");
            }
            if (typeof importScripts !== "undefined" || typeof postMessage !== "undefined") {
              throw new Error("importScripts/postMessage was not stripped");
            }
            const res = await host.httpFetch("https://api.sample.test/streams/" + req.media.tmdbId, {
              headers: { "X-Client": "abixcine" },
            });
            const data = JSON.parse(res.body);
            return [{
              url: data.stream,
              quality: "1080p",
              headers: { referer: "https://api.sample.test/" },
              subtitles: [{ url: data.sub, lang: "en", label: "English", default: true }],
              skip: { intro: [5, 90] },
            }];
          }
        };
      `,
    });

    const candidates = await runPlugin(manifest, movieReq);

    expect(env.ambientFetchSpy).not.toHaveBeenCalled();
    expect(env.ambientImportScriptsSpy).not.toHaveBeenCalled();
    expect(mockHttpFetch).toHaveBeenCalledTimes(1);
    expect(mockHttpFetch).toHaveBeenCalledWith(
      "https://api.sample.test/streams/603",
      { "X-Client": "abixcine" },
      undefined,
    );

    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.providerId).toBe("plugin:matrix-plugin");
    expect(c.providerName).toBe("Matrix Plugin");
    expect(c.kind).toBe("hls");
    expect(c.via).toBe("direct");
    expect(c.quality).toBe(1080);
    expect(c.skip).toEqual({ intro: [5, 90] });
    expect(unwrapProxyUrl(c.url)).toEqual({
      url: "https://cdn.stream.test/matrix/master.m3u8",
      headers: expect.objectContaining({
        referer: "https://api.sample.test/",
        origin: "https://api.sample.test",
      }),
      proxied: true,
    });
    expect(c.subtitles?.[0].lang).toBe("en");
    expect(unwrapProxyUrl(c.subtitles![0].url).url).toBe("https://cdn.stream.test/matrix/en.vtt");

    // Worker and Blob URL were cleaned up after completion
    expect(env.workers).toHaveLength(1);
    expect(env.workers[0].terminated).toBe(true);
    expect(env.revokedUrls).toHaveLength(1);
  });

  it("blocks SSRF and disallowed hosts inside host.httpFetch calls and redirect responses", async () => {
    installVmWorkerEnv();

    // First call is allowed URL that simulates an HTTP redirect to 127.0.0.1!
    mockHttpFetch.mockResolvedValueOnce({
      status: 200,
      url: "http://127.0.0.1/admin",
      body: "secret",
    });

    const manifest = makeManifest({
      allowedHosts: ["api.sample.test"],
      script: `
        async function find(req, host) {
          const errors = [];
          try { await host.httpFetch("http://abxs.localhost/p?u=1"); } catch (e) { errors.push(e.message); }
          try { await host.httpFetch("https://evil.example.org/steal"); } catch (e) { errors.push(e.message); }
          try { await host.httpFetch("https://api.sample.test/redirect"); } catch (e) { errors.push(e.message); }
          if (errors.length !== 3) throw new Error("Expected 3 blocked fetches, got " + errors.length);
          return [];
        }
      `,
    });

    const res = await runPlugin(manifest, movieReq);
    expect(res).toEqual([]);
    // Only the allowedHosts request reached mockHttpFetch (and its redirect response was rejected)
    expect(mockHttpFetch).toHaveBeenCalledTimes(1);
  });

  it("enforces MAX_PLUGIN_HTTP_CALLS cap per plugin execution", async () => {
    installVmWorkerEnv();
    mockHttpFetch.mockResolvedValue({
      status: 200,
      url: "https://api.sample.test/ok",
      body: "{}",
    });

    const manifest = makeManifest({
      allowedHosts: ["api.sample.test"],
      script: `
        module.exports = async (req, host) => {
          for (let i = 0; i < ${MAX_PLUGIN_HTTP_CALLS + 3}; i++) {
            await host.httpFetch("https://api.sample.test/step/" + i);
          }
          return [];
        };
      `,
    });

    await expect(runPlugin(manifest, movieReq)).rejects.toThrow(/Exceeded max HTTP calls/i);
    expect(mockHttpFetch).toHaveBeenCalledTimes(MAX_PLUGIN_HTTP_CALLS);
  });

  it("fetches and caches remote scriptUrl plugins safely", async () => {
    installVmWorkerEnv();

    mockHttpFetch
      .mockResolvedValueOnce({
        status: 200,
        url: "https://plugins.cdn.test/ext.js",
        body: `exports.getStreams = async (req, host) => {
          const api = await host.httpFetch("https://api.sample.test/tv/" + req.season + "/" + req.episode);
          return [{ url: JSON.parse(api.body).url, kind: "embed" }];
        };`,
      })
      .mockResolvedValue({
        status: 200,
        url: "https://api.sample.test/tv/1/2",
        body: JSON.stringify({ url: "https://embed.sample.test/e/12" }),
      });

    const manifest = makeManifest({
      id: "remote-ext",
      script: undefined,
      scriptUrl: "https://plugins.cdn.test/ext.js",
      allowedHosts: ["api.sample.test"],
    });

    const first = await runPlugin(manifest, tvReq);
    const second = await runPlugin(manifest, tvReq);

    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("embed");
    expect(first[0].via).toBe("embed");
    expect(first[0].url).toBe("https://embed.sample.test/e/12");
    expect(second).toHaveLength(1);
    // Script fetched once (cached), API fetched twice
    expect(mockHttpFetch).toHaveBeenCalledTimes(3);
  });
});

describe("timeout, AbortSignal, and worker termination", () => {
  it("terminates worker cleanly when overall plugin timeout expires", async () => {
    const env = installVmWorkerEnv();

    // Never resolves httpFetch
    mockHttpFetch.mockImplementation(() => new Promise(() => {}));

    const manifest = makeManifest({
      timeoutMs: 80,
      script: `
        module.exports = {
          async find(req, host) {
            await host.httpFetch("https://api.sample.test/hang");
            return [];
          }
        };
      `,
    });

    await expect(runPlugin(manifest, movieReq)).rejects.toThrow(/timed out/i);
    expect(env.workers).toHaveLength(1);
    expect(env.workers[0].terminated).toBe(true);
    expect(env.revokedUrls).toHaveLength(1);
  });

  it("terminates worker immediately on AbortSignal and skips spawn if already aborted", async () => {
    const env = installVmWorkerEnv();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(runPlugin(makeManifest(), movieReq, preAborted.signal)).rejects.toThrow(/abort/i);
    expect(env.workers).toHaveLength(0);

    mockHttpFetch.mockImplementation(() => new Promise(() => {}));
    const ctl = new AbortController();
    const manifest = makeManifest({
      timeoutMs: 10_000,
      script: `
        module.exports = {
          async find(req, host) {
            await host.httpFetch("https://api.sample.test/slow");
            return [];
          }
        };
      `,
    });

    const promise = runPlugin(manifest, movieReq, ctl.signal);
    setTimeout(() => ctl.abort(), 30);

    await expect(promise).rejects.toThrow(/abort/i);
    expect(env.workers).toHaveLength(1);
    expect(env.workers[0].terminated).toBe(true);
    expect(env.revokedUrls).toHaveLength(1);
  });

  it("terminates worker on plugin runtime error or worker crash", async () => {
    const env = installVmWorkerEnv();
    const manifest = makeManifest({
      script: `module.exports = { async find() { throw new Error("boom from plugin"); } };`,
    });

    await expect(runPlugin(manifest, movieReq)).rejects.toThrow("boom from plugin");
    expect(env.workers[0].terminated).toBe(true);
    expect(env.revokedUrls).toHaveLength(1);
  });
});

describe("SourceProvider adapters & candidate normalization", () => {
  it("normalizes stream candidates, filters bad URLs, and deduplicates", () => {
    const manifest = makeManifest({ id: "norm", name: "Norm" });
    const cands = normalizePluginCandidates(manifest, [
      { url: "javascript:alert(1)" },
      { url: "http://127.0.0.1/local.m3u8" },
      {
        url: "https://cdn.example.com/1080/playlist.m3u8",
        quality: "1080p",
        audio: "dual",
        subtitles: [
          { url: "https://cdn.example.com/sprites.vtt", kind: "thumbnails" },
          { url: "https://cdn.example.com/en.srt", lang: "en", label: "English" },
        ],
      },
      // Duplicate URL
      { url: "https://cdn.example.com/1080/playlist.m3u8" },
      { url: "https://cdn.example.com/movie.mp4", kind: "mp4", quality: 720 },
    ]);

    expect(cands).toHaveLength(2);
    expect(cands[0].kind).toBe("hls");
    expect(cands[0].audio).toBe("dual");
    expect(cands[0].subtitles).toHaveLength(1);
    expect(cands[0].subtitles![0].format).toBe("srt");
    expect(cands[1].kind).toBe("file");
    expect(cands[1].quality).toBe(720);
  });

  it("exposes pluginProvidersSource and createPluginProviders() respecting mediaTypes and settings", async () => {
    installVmWorkerEnv();

    installPlugin(
      makeManifest({
        id: "broken-p",
        name: "Broken",
        mediaTypes: ["movie"],
        priority: 30,
        script: `module.exports = { async find() { throw new Error("plugin failed"); } };`,
      }),
    );
    installPlugin(
      makeManifest({
        id: "working-p",
        name: "Working",
        mediaTypes: ["movie"],
        priority: 25,
        script: `module.exports = { async find() { return [{ url: "https://cdn.example.com/v.m3u8", quality: 1080 }]; } };`,
      }),
    );
    installPlugin(
      makeManifest({
        id: "anime-only",
        name: "Anime Only",
        mediaTypes: ["anime"],
        priority: 20,
        script: `module.exports = { async find() { return [{ url: "https://cdn.example.com/a.m3u8" }]; } };`,
      }),
    );

    const settings = makeSettings();
    expect(pluginProvidersSource.isEnabled(settings)).toBe(true);
    expect(pluginProvidersSource.isEnabled(makeSettings({ disabledSources: ["plugins"] }))).toBe(false);

    const aggregated = await pluginProvidersSource.find(movieReq, settings, new AbortController().signal);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].providerId).toBe("plugin:working-p");

    // Disabled individual plugin is skipped
    const disabledIndividual = await pluginProvidersSource.find(
      movieReq,
      makeSettings({ disabledSources: ["plugin:working-p"] }),
      new AbortController().signal,
    );
    expect(disabledIndividual).toEqual([]);

    // createPluginProviders exposes per-plugin SourceProvider adapters
    const adapters = createPluginProviders();
    expect(adapters.map((a) => a.id)).toEqual(["plugin:broken-p", "plugin:working-p", "plugin:anime-only"]);
    expect(adapters[1].isEnabled(settings)).toBe(true);
    expect(adapters[1].isEnabled(makeSettings({ disabledSources: ["plugin:working-p"] }))).toBe(false);
    const workingOnly = await adapters[1].find(movieReq, settings, new AbortController().signal);
    expect(workingOnly).toHaveLength(1);
    expect(workingOnly[0].providerId).toBe("plugin:working-p");
  });
});
