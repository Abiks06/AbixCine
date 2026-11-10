import type { SourceProvider, StreamCandidate } from "./types";

/**
 * Test-only providers for exercising the picker: one quick, one slow but sharper, one that
 * lists a dead link, one that never answers. They only exist in builds made with
 * VITE_MOCK_SOURCES=1 and point at a file you serve yourself (VITE_MOCK_MEDIA), so a normal
 * build ships none of this.
 */
const ON = import.meta.env.VITE_MOCK_SOURCES === "1";
const MEDIA = (import.meta.env.VITE_MOCK_MEDIA as string | undefined) ?? "http://127.0.0.1:8765/test.webm";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))));
  });

function mock(id: string, name: string, delay: number, quality: number, url: string, priority = 10): SourceProvider {
  return {
    id,
    name,
    category: "external",
    priority,
    isEnabled: () => ON && localStorage.getItem(`abx.mock.off.${id}`) !== "1",
    async find(req, _s, signal) {
      await wait(delay, signal);
      const ep = req.episode != null ? ` E${req.episode}` : "";
      const c: StreamCandidate = { providerId: id, providerName: name, label: `${req.media.title}${ep} · ${quality}p`, url: `${url}${url.includes("?") ? "&" : "?"}src=${id}`, kind: "file", quality };
      return [c];
    },
  };
}

export const mockProviders: SourceProvider[] = ON
  ? [
      mock("mock-edge", "Test Edge", 120, 1080, MEDIA),
      mock("mock-vault", "Test Vault", 1400, 2160, MEDIA),
      mock("mock-mirror", "Test Mirror", 300, 1080, MEDIA.replace(/[^/]+$/, "missing.webm")),
      mock("mock-stall", "Test Stall", 60_000, 720, MEDIA),
    ]
  : [];
