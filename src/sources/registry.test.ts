import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackRequest } from "../lib/types";
import { candLine, clearResolveCache, initialCandidateIndex, PROVIDERS, resolveSources, score } from "./registry";
import type { SourceProvider, StreamCandidate } from "./types";

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
});
