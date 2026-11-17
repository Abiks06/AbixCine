import { describe, expect, it } from "vitest";
import { isYouTubeId, isYouTubeOrigin, parseTrailerMessage, trailerEmbedUrl, trailerWatchUrl } from "./trailer";

describe("trailer embed", () => {
  it("builds a privacy-enhanced autoplay embed with the app origin", () => {
    const u = new URL(trailerEmbedUrl("dQw4w9WgXcQ", "http://tauri.localhost"));
    expect(u.origin).toBe("https://www.youtube-nocookie.com");
    expect(u.pathname).toBe("/embed/dQw4w9WgXcQ");
    expect(u.searchParams.get("autoplay")).toBe("1");
    expect(u.searchParams.get("rel")).toBe("0");
    expect(u.searchParams.get("modestbranding")).toBe("1");
    expect(u.searchParams.get("playsinline")).toBe("1");
    expect(u.searchParams.get("enablejsapi")).toBe("1");
    expect(u.searchParams.get("origin")).toBe("http://tauri.localhost");
  });

  it("drops an origin that isn't a plain http(s) origin", () => {
    expect(new URL(trailerEmbedUrl("dQw4w9WgXcQ", "tauri://localhost")).searchParams.has("origin")).toBe(false);
    expect(new URL(trailerEmbedUrl("dQw4w9WgXcQ", "null")).searchParams.has("origin")).toBe(false);
    expect(new URL(trailerEmbedUrl("dQw4w9WgXcQ")).searchParams.has("origin")).toBe(false);
  });

  it("validates ids and builds the watch link", () => {
    expect(isYouTubeId("dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeId("a_b-c1234XY")).toBe(true);
    expect(isYouTubeId("short")).toBe(false);
    expect(isYouTubeId("dQw4w9WgXcQ/../x")).toBe(false);
    expect(isYouTubeId(undefined)).toBe(false);
    expect(trailerWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("reads player state and fatal errors from the iframe API", () => {
    expect(parseTrailerMessage('{"event":"onReady","info":null}')).toEqual({ kind: "ready" });
    expect(parseTrailerMessage('{"event":"onError","info":153}')).toEqual({ kind: "error", code: 153 });
    expect(parseTrailerMessage({ event: "onError", info: 150 })).toEqual({ kind: "error", code: 150 });
    expect(parseTrailerMessage('{"event":"infoDelivery","info":{"playerState":1}}')).toEqual({ kind: "ready" });
    expect(parseTrailerMessage('{"event":"infoDelivery","info":{"currentTime":3}}')).toBeNull();
    expect(parseTrailerMessage("not json")).toBeNull();
    expect(parseTrailerMessage(42)).toBeNull();
  });

  it("only trusts YouTube origins", () => {
    expect(isYouTubeOrigin("https://www.youtube-nocookie.com")).toBe(true);
    expect(isYouTubeOrigin("https://www.youtube.com")).toBe(true);
    expect(isYouTubeOrigin("https://youtube.com.evil.example")).toBe(false);
    expect(isYouTubeOrigin("http://www.youtube.com")).toBe(false);
  });
});
