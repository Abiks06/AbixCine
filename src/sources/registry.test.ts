import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackRequest } from "../lib/types";
import { recordPlayback, resetHealth } from "./health";
import { candLine, clearResolveCache, initialCandidateIndex, PROVIDERS, resolveSources, score } from "./registry";
import type { Sniffed } from "./native";
import type { SourceProvider, StreamCandidate } from "./types";

const { mockSniff } = vi.hoisted(() => ({ mockSniff: vi.fn() }));
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  native: true,
  sniff: mockSniff,
}));

const request = (key: string): PlaybackRequest => ({
  media: { key, kind: "movie", title: "Test", overview: "", genres: [] },
});

const candidate = (providerId: string): StreamCandidate => ({
  providerId,
  providerName: providerId,
  label: providerId,
  url: `https://${providerId}.example/stream`,
  pageUrl: `https://${providerId}.example/stream`,
  kind: "embed",
  via: "embed",
});

beforeEach(() => {
  mockSniff.mockReset();
  mockSniff.mockResolvedValue({
    url: "https://media.example/master.m3u8",
    kind: "hls",
    headers: {},
    subtitles: [],
    verified: true,
    quality: 1080,
  });
});

afterEach(() => clearResolveCache());

describe("source ranking", () => {
  it("starts from the explicitly chosen source even when its preflight failed", () => {
    const candidates = [
      { ...candidate("checked"), probe: { ok: true, latencyMs: 10 } },
      { ...candidate("chosen"), probe: { ok: false, latencyMs: 20, error: "timeout" } },
    ];

    expect(initialCandidateIndex(candidates, candidates[1].url)).toBe(1);
    expect(initialCandidateIndex(candidates)).toBe(0);
  });

  it("shows a preflight failure reason instead of a generic won't-play label", () => {
    expect(candLine({ ...candidate("denied"), probe: { ok: false, latencyMs: 1, error: "HTTP 403" } })).toBe("HTTP 403");
    expect(candLine({ ...candidate("timeout"), probe: { ok: false, latencyMs: 1, error: "timeout" } })).toBe("timed out");
  });

  it("uses lookup time as well as probe time when ranking time-to-play", () => {
    const req = request("test:lookup-ranking");
    const fast = score({ ...candidate("fast"), lookupMs: 100, probe: { ok: true, latencyMs: 500 } }, 1080, 0, req);
    const slow = score({ ...candidate("slow"), lookupMs: 3000, probe: { ok: true, latencyMs: 500 } }, 1080, 0, req);

    expect(fast.score).toBeGreaterThan(slow.score!);
  });

  it("ranks a known French source lower for a non-French original", () => {
    const req = request("test:french-source");
    Object.assign(req.media, { originalLanguage: "en" });
    const probe = { ok: true, latencyMs: 200, quality: 1080 };
    const french = score({ ...candidate("french"), label: "Frembed · French", probe }, 1080, 15, req);
    const neutral = score({ ...candidate("neutral"), label: "VidFast", probe }, 1080, 15, req);

    expect(french.score).toBeLessThan(neutral.score!);
    expect(french.why).toContain("French source for non-French title");
  });

  it("checks more standby embeds when the requested verification budget increases", async () => {
    const original = [...PROVIDERS];
    const providers: SourceProvider[] = ["first", "second", "third", "fourth", "fifth"].map((id, i) => ({
      id,
      name: id,
      category: "embed",
      priority: 20 - i,
      isEnabled: () => true,
      find: async () => [candidate(id)],
    }));
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);

    try {
      const req = request("test:verification-budget");
      const initial = await resolveSources(req, undefined, { verifyBudget: 1, record: false });
      const initiallyVerified = initial.filter((c) => c.probe?.ok).length;
      expect(initiallyVerified).toBeGreaterThan(0);
      expect(initiallyVerified).toBeLessThan(providers.length);
      expect(initial.some((c) => !c.probe)).toBe(true);

      const expanded = await resolveSources(req, undefined, { verifyBudget: 4, record: false });
      expect(expanded.filter((c) => c.probe?.ok).length).toBeGreaterThan(initiallyVerified);
    } finally {
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("starts from the first verified source without waiting for slower lookups", async () => {
    const original = [...PROVIDERS];
    let releaseDirect!: (response: Response) => void;
    let releaseSlow!: (candidates: StreamCandidate[]) => void;
    const directProbe = new Promise<Response>((resolve) => {
      releaseDirect = resolve;
    });
    const slowLookup = new Promise<StreamCandidate[]>((resolve) => {
      releaseSlow = resolve;
    });
    const providers: SourceProvider[] = [
      {
        id: "fast",
        name: "Fast",
        category: "embed",
        priority: 20,
        isEnabled: () => true,
        find: async () => [
          { ...candidate("fast"), url: "https://fast.example/master.m3u8", kind: "hls", via: "direct", pageUrl: undefined },
          candidate("fast"),
        ],
      },
      {
        id: "slow",
        name: "Slow",
        category: "embed",
        priority: 10,
        isEnabled: () => true,
        find: () => slowLookup,
      },
    ];
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);
    vi.stubGlobal("fetch", () => directProbe);
    vi.useFakeTimers();

    try {
      const pending = resolveSources(request("test:fast-first-source"), undefined, { early: true, record: false });
      await vi.advanceTimersByTimeAsync(300);
      const selected = await pending;

      expect(selected.some((c) => c.providerId === "fast" && c.probe?.ok)).toBe(true);

      releaseSlow([candidate("slow")]);
      releaseDirect(new Response("#EXTM3U\n#EXTINF:6,\nsegment.ts", { status: 200 }));
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("keeps checking later embeds when earlier captures don't find a stream", async () => {
    const original = [...PROVIDERS];
    const ids = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"];
    const providers: SourceProvider[] = ids.map((id, i) => ({
      id,
      name: id,
      category: "embed",
      priority: 20 - i,
      isEnabled: () => true,
      find: async () => [candidate(id)],
    }));
    const last = candidate("seventh");
    mockSniff.mockImplementation(async (url: string) => url === last.url ? {
      url: "https://media.example/master.m3u8",
      kind: "hls",
      headers: {},
      subtitles: [],
      verified: true,
      quality: 1080,
    } : null);
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);

    try {
      const result = await resolveSources(request("test:later-embed"), undefined, { verifyBudget: 2, record: false });

      expect(result.find((c) => c.providerId === "seventh")?.probe?.ok).toBe(true);
    } finally {
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });

  it("tries the last working source first among queued embeds", async () => {
    const original = [...PROVIDERS];
    const req = request("test:last-picked-source");
    const active = new Set(["first", "second", "third"]);
    const pending: Record<string, (result: Sniffed | null) => void> = {};
    const stream: Sniffed = {
      url: "https://media.example/master.m3u8",
      kind: "hls",
      headers: {},
      subtitles: [],
      verified: true,
      quality: 1080,
    };
    const providers: SourceProvider[] = ["first", "second", "third", "fourth", "fifth"].map((id, i) => ({
      id,
      name: id,
      category: "embed",
      priority: 20 - i,
      isEnabled: () => true,
      find: async () => [candidate(id)],
    }));
    mockSniff.mockImplementation((url: string) => {
      const id = new URL(url).hostname.split(".")[0];
      if (active.has(id)) return new Promise<Sniffed | null>((resolve) => { pending[id] = resolve; });
      return Promise.resolve(id === "fifth" ? stream : null);
    });
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);
    resetHealth();
    recordPlayback(req, candidate("fifth"), true);

    try {
      const race = resolveSources(req, undefined, { verifyBudget: 1, record: false });
      await vi.waitFor(() => expect(mockSniff).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 0));
      pending.first(null);
      await vi.waitFor(() => expect(mockSniff).toHaveBeenCalledTimes(4));

      expect(new URL(mockSniff.mock.calls[3][0]).hostname).toBe("fifth.example");

      pending.second(null);
      pending.third(null);
      const result = await race;
      expect(result.find((c) => c.providerId === "fifth")?.probe?.ok).toBe(true);
    } finally {
      resetHealth();
      PROVIDERS.splice(0, PROVIDERS.length, ...original);
    }
  });
});
