import { describe, expect, it } from "vitest";
import { decodeSubtitle, preferredAudioTrackIndex, toVtt } from "./subtitles";

describe("preferredAudioTrackIndex", () => {
  const tracks = [{ lang: "fra" }, { lang: "en-US" }, { lang: "jpn" }];

  it("uses the requested anime audio when available", () => {
    expect(preferredAudioTrackIndex(tracks, "dub")).toBe(1);
    expect(preferredAudioTrackIndex(tracks, "sub")).toBe(2);
  });

  it("uses the title's original language for regular movies and series", () => {
    expect(preferredAudioTrackIndex(tracks, undefined, "fr")).toBe(0);
    expect(preferredAudioTrackIndex(tracks, undefined, "en")).toBe(1);
  });

  it("leaves the source default when there is no matching language", () => {
    expect(preferredAudioTrackIndex(tracks, undefined, "de")).toBe(-1);
  });
});

describe("toVtt", () => {
  it("converts SRT timestamps into WebVTT", () => {
    expect(toVtt("1\r\n00:00:01,250 --> 00:00:02,500\r\nHello")).toBe("WEBVTT\n\n1\n00:00:01.250 --> 00:00:02.500\nHello\n");
  });
});

describe("decodeSubtitle", () => {
  it("supports legacy Windows-1252 subtitle files", () => {
    expect(decodeSubtitle(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]).buffer)).toBe("café");
  });
});
