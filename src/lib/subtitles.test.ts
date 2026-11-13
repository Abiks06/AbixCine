import { beforeEach, describe, expect, it } from "vitest";
import {
  COMMON_SUB_LANGS,
  DEFAULT_SUB_PREF,
  SUB_PREF_EVENT,
  activeCuesAt,
  cuesToVtt,
  decodeSubtitle,
  detectSubtitleFormat,
  langBase,
  langLabel,
  loadSubPref,
  loadSubTrackMemory,
  normalizeSubLang,
  parseSubtitles,
  pickBestSubtitleIndex,
  preferredAudioTrackIndex,
  saveSubPref,
  saveSubTrackMemory,
  shouldAutoEnableSubtitles,
  toVtt,
  type SubtitleCue,
} from "./subtitles";

beforeEach(() => {
  localStorage.clear();
});

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

describe("language helpers", () => {
  it("normalizes base languages while preserving regional subtitle tags", () => {
    expect(langBase("eng")).toBe("en");
    expect(langBase("en-US")).toBe("en");
    expect(langBase("English")).toBe("en");
    expect(langBase("pob")).toBe("pt");
    expect(langBase("")).toBe("und");

    expect(normalizeSubLang("pob")).toBe("pt-br");
    expect(normalizeSubLang("pt_BR")).toBe("pt-br");
    expect(normalizeSubLang("zh-Hant")).toBe("zh-tw");
    expect(normalizeSubLang("fre")).toBe("fr");
    expect(normalizeSubLang("deu")).toBe("de");
  });

  it("produces readable language labels and exposes common languages", () => {
    expect(langLabel("eng")).toBe("English");
    expect(langLabel("pt-br")).toBe("Portuguese (Brazil)");
    expect(langLabel("jpn")).toBe("Japanese");
    expect(langLabel("und")).toBe("Unknown");
    expect(COMMON_SUB_LANGS.some((l) => l.code === "en" && l.label === "English")).toBe(true);
    expect(COMMON_SUB_LANGS.some((l) => l.code === "pt-br")).toBe(true);
  });
});

describe("SubPref persistence & backwards compatibility", () => {
  it("migrates legacy abx.subs.v1 entries cleanly", () => {
    localStorage.setItem("abx.subs.v1", JSON.stringify({ size: "l", on: true, lang: "eng" }));
    const pref = loadSubPref();
    expect(pref.size).toBe("l");
    expect(pref.on).toBe(true);
    expect(pref.mode).toBe("on");
    expect(pref.lang).toBe("en");
    expect(pref.font).toBe(DEFAULT_SUB_PREF.font);
    expect(pref.bg).toBe(DEFAULT_SUB_PREF.bg);

    localStorage.setItem("abx.subs.v1", JSON.stringify({ size: "s", on: false }));
    const prefOff = loadSubPref();
    expect(prefOff.mode).toBe("off");
    expect(prefOff.on).toBe(false);
  });

  it("clamps numeric prefs, sanitizes color, syncs mode/on, and emits abx:subpref", () => {
    const events: unknown[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener(SUB_PREF_EVENT, listener);

    const saved1 = saveSubPref({
      mode: "on",
      size: "xl",
      font: "rounded",
      color: "javascript:alert(1)",
      bgOpacity: 5,
      bottomPct: -10,
      lineHeight: 99,
      preferHearingImpaired: "avoid",
      autoFetchOnline: true,
    });

    expect(saved1.mode).toBe("on");
    expect(saved1.on).toBe(true);
    expect(saved1.size).toBe("xl");
    expect(saved1.font).toBe("rounded");
    expect(saved1.color).toBe("#ffffff");
    expect(saved1.bgOpacity).toBe(1);
    expect(saved1.bottomPct).toBe(2);
    expect(saved1.lineHeight).toBe(2.2);
    expect(saved1.preferHearingImpaired).toBe("avoid");
    expect(saved1.autoFetchOnline).toBe(true);
    expect(events).toHaveLength(1);

    // Spreading previous SubPref (which had on: true) and flipping mode to "auto" clears `on`.
    const saved2 = saveSubPref({ ...saved1, mode: "auto", color: "#FFE88A" });
    expect(saved2.mode).toBe("auto");
    expect(saved2.on).toBeUndefined();
    expect(saved2.color).toBe("#ffe88a");
    expect(events).toHaveLength(2);

    window.removeEventListener(SUB_PREF_EVENT, listener);
  });
});

describe("decodeSubtitle", () => {
  it("supports legacy Windows-1252 subtitle files", () => {
    expect(decodeSubtitle(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]).buffer)).toBe("café");
  });

  it("handles UTF-8 BOM, UTF-16LE BOM, UTF-16BE BOM, and multibyte UTF-8", () => {
    const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x48, 0x69, 0x20, 0xe3, 0x81, 0x82]).buffer;
    expect(decodeSubtitle(utf8Bom)).toBe("Hi あ");

    // UTF-16LE BOM + "Hi"
    const utf16Le = Uint8Array.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]).buffer;
    expect(decodeSubtitle(utf16Le)).toBe("Hi");

    // UTF-16BE BOM + "Hi"
    const utf16Be = Uint8Array.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]).buffer;
    expect(decodeSubtitle(utf16Be)).toBe("Hi");

    expect(decodeSubtitle(new ArrayBuffer(0))).toBe("");
  });
});

describe("toVtt & detectSubtitleFormat", () => {
  it("converts SRT timestamps into WebVTT", () => {
    expect(toVtt("1\r\n00:00:01,250 --> 00:00:02,500\r\nHello")).toBe("WEBVTT\n\n1\n00:00:01.250 --> 00:00:02.500\nHello\n");
  });

  it("detects vtt, srt, and ass accurately", () => {
    expect(detectSubtitleFormat("WEBVTT\n\n00:01.000 --> 00:02.000\nHi")).toBe("vtt");
    expect(detectSubtitleFormat("1\n00:00:01,000 --> 00:00:02,000\nHi")).toBe("srt");
    expect(detectSubtitleFormat("[Script Info]\nTitle: Anime\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi")).toBe("ass");
    expect(detectSubtitleFormat("", "track.ssa")).toBe("ass");
  });

  it("converts ASS subtitles into valid WebVTT", () => {
    const ass = `[Script Info]
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, PrimaryColour, Bold, Italic, Underline, StrikeOut, Alignment
Style: Default,&H00FFFFFF,0,0,0,0,2

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:01.25,0:00:03.50,Default,{\\i1}Hello\\NWorld`;
    const vtt = toVtt(ass);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.250 --> 00:00:03.500");
    expect(vtt).toContain("<i>Hello\nWorld</i>");
  });
});

describe("parseSubtitles — ASS / SSA", () => {
  it("parses dynamic Format columns, styles, overrides, colors, alignment, pos, and strips vector drawings", () => {
    const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, PrimaryColour, Bold, Italic, Underline, StrikeOut, Alignment
Style: Default,&H00FFFFFF,0,0,0,0,2
Style: Sign,&H0000FFFF,-1,0,0,-1,8

[Events]
Format: Style, Layer, End, Start, Text
Comment: 0,0,0:00:05.00,0:00:01.00,Should be ignored
Dialogue: Default,0,0:00:04.00,0:00:01.00,{\\b1\\i1\\c&H0000FF&}Red{\\b0\\r} Normal, with comma\\NSecond\\hline
Dialogue: Sign,2,0:00:06.00,0:00:02.00,{\\pos(960,270)\\u1\\blur5\\shad2\\t(0,500,\\c&H00FF00&)}Top\\hSign{\\u0\\s0}
Dialogue: Default,0,0:00:07.00,0:00:03.00,{\\p1}m 0 0 l 100 0 100 100{\\p0}After drawing
Dialogue: Default,0,0:00:08.00,0:00:04.00,{\\p1}m 0 0 l 50 50 0 50
Dialogue: Default,0,0:00:09.00,0:00:05.00,{\\a6\\1c&HFF0000&}Legacy top`;

    const parsed = parseSubtitles(ass);
    expect(parsed.format).toBe("ass");
    // Pure vector drawing dialogue is dropped cleanly
    expect(parsed.cues).toHaveLength(4);

    const c0 = parsed.cues[0];
    expect(c0.start).toBe(1);
    expect(c0.end).toBe(4);
    expect(c0.align).toBe(2);
    expect(c0.text).toBe("Red Normal, with comma\nSecond\u00A0line");
    expect(c0.spans).toEqual([
      { text: "Red", bold: true, italic: true, color: "#ff0000" },
      { text: " Normal, with comma\nSecond\u00A0line" },
    ]);

    const c1 = parsed.cues[1];
    expect(c1.layer).toBe(2);
    expect(c1.align).toBe(8);
    expect(c1.pos).toEqual({ xPct: 50, yPct: 25 });
    // \blur5 and \shad2 must NOT trigger \b or \s, and \t(...) must NOT apply end color statically
    expect(c1.spans).toEqual([
      { text: "Top\u00A0Sign", bold: true, underline: true, strike: true, color: "#ffff00" },
    ]);

    const c2 = parsed.cues[2];
    expect(c2.text).toBe("After drawing");

    const c3 = parsed.cues[3];
    expect(c3.align).toBe(8); // \a6 -> top-center (8)
    expect(c3.spans[0].color).toBe("#0000ff");
  });

  it("defaults PlayRes to 384x288 and maps V4 Styles legacy alignment", () => {
    const ssa = `[Script Info]
Title: Legacy

[V4 Styles]
Format: Name, Alignment, PrimaryColour, Bold
Style: TopLeft,5,16777215,1

[Events]
Format: Marked, Start, End, Style, Text
Dialogue: Marked=0,0:00:00.50,0:00:02.00,TopLeft,{\\pos(192,144)}Centered pos`;

    const parsed = parseSubtitles(ssa, "ssa");
    expect(parsed.format).toBe("ass");
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0].align).toBe(7);
    expect(parsed.cues[0].pos).toEqual({ xPct: 50, yPct: 50 });
    expect(parsed.cues[0].spans[0].bold).toBe(true);
  });
});

describe("parseSubtitles — VTT & SRT", () => {
  it("skips NOTE/STYLE/REGION blocks, parses settings and spans safely", () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

NOTE
Comment block
still a comment

STYLE
::cue { color: yellow; }

REGION
id:top

cue-1
00:01.500 --> 00:03.250 align:start position:10% line:15%
<c.cyan>Hello</c> <b>world &amp; friends</b>

cue-2
00:04.000 --> 00:06.000
<script>alert(1)</script><img src=x onerror=alert(1)><font color="#ffcc00">Safe <i>text</i></font>`;

    const parsed = parseSubtitles(vtt);
    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toHaveLength(2);

    expect(parsed.cues[0].id).toBe("cue-1");
    expect(parsed.cues[0].align).toBe(7);
    expect(parsed.cues[0].pos).toEqual({ xPct: 10, yPct: 15 });
    expect(parsed.cues[0].spans).toEqual([
      { text: "Hello", color: "cyan" },
      { text: " " },
      { text: "world & friends", bold: true },
    ]);

    expect(parsed.cues[1].text).toBe("Safe text");
    expect(parsed.cues[1].spans).toEqual([
      { text: "Safe ", color: "#ffcc00" },
      { text: "text", color: "#ffcc00", italic: true },
    ]);
  });

  it("handles SRT with ASS positioning tags, unsafe font colors, and missing blank lines", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,500
{\\an8}<font color="expression(alert(1))">Top</font>
2
00:00:03,000 --> 00:00:04,000
<u>Line</u>`;

    const parsed = parseSubtitles(srt);
    expect(parsed.format).toBe("srt");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0].align).toBe(8);
    expect(parsed.cues[0].spans).toEqual([{ text: "Top" }]);
    expect(parsed.cues[1].spans).toEqual([{ text: "Line", underline: true }]);
  });

  it("round-trips special characters safely via cuesToVtt", () => {
    const cues: SubtitleCue[] = [
      { id: "1", start: 1, end: 2.5, text: "A < B & C > D", spans: [{ text: "A < B & C > D", bold: true }], align: 2 },
    ];
    const vtt = cuesToVtt(cues);
    const reparsed = parseSubtitles(vtt, "vtt");
    expect(reparsed.cues[0].text).toBe("A < B & C > D");
    expect(reparsed.cues[0].spans[0].bold).toBe(true);
  });
});

describe("activeCuesAt", () => {
  it("uses binary search, supports long overlapping cues, and applies offsetSec correctly", () => {
    const cues: SubtitleCue[] = [
      { id: "sign", start: 0, end: 60, text: "Long Sign", spans: [{ text: "Long Sign" }], align: 8 },
    ];
    for (let i = 0; i < 150; i++) {
      const start = i * 2 + 1;
      cues.push({
        id: `d-${i}`,
        start,
        end: start + 1.5,
        text: `Line ${i}`,
        spans: [{ text: `Line ${i}` }],
        align: 2,
      });
    }

    // At t=101.2: d-50 (101..102.5) and long sign (0..60 is ended, so only d-50)
    expect(activeCuesAt(cues, 101.2).map((c) => c.id)).toEqual(["d-50"]);
    // At t=21.2: both sign and d-10 (21..22.5) are active
    expect(activeCuesAt(cues, 21.2).map((c) => c.id)).toEqual(["sign", "d-10"]);

    // Offset +0.5s shifts displayed interval [start + 0.5, end + 0.5)
    // d-10 is [21.5, 23.0): not active at 21.2, active at 21.5, not active at 23.0
    expect(activeCuesAt(cues, 21.2, 0.5).map((c) => c.id)).toEqual(["sign"]);
    expect(activeCuesAt(cues, 21.5, 0.5).map((c) => c.id)).toEqual(["sign", "d-10"]);
    expect(activeCuesAt(cues, 22.9, 0.5).map((c) => c.id)).toEqual(["sign", "d-10"]);
    expect(activeCuesAt(cues, 23.0, 0.5).map((c) => c.id)).toEqual(["sign"]);
  });
});

describe("track matching & per-media memory", () => {
  it("evaluates auto-enable modes accurately", () => {
    expect(shouldAutoEnableSubtitles({ mode: "on", lang: "en" }, "dub", "en")).toBe(true);
    expect(shouldAutoEnableSubtitles({ mode: "off", lang: "en" }, "sub", "ja")).toBe(false);
    expect(shouldAutoEnableSubtitles({ mode: "auto", lang: "en" }, "sub", "ja")).toBe(true);
    expect(shouldAutoEnableSubtitles({ mode: "auto", lang: "en" }, undefined, "ko")).toBe(true);
    expect(shouldAutoEnableSubtitles({ mode: "auto", lang: "en" }, undefined, "en")).toBe(false);
  });

  it("picks best track considering locale, forced, HI preference, format, and excludeIndex", () => {
    const tracks = [
      { lang: "en", label: "English (Forced)", isForced: true, format: "srt" },
      { lang: "en", label: "English SDH", isHearingImpaired: true, format: "srt" },
      { lang: "en", label: "English", format: "ass" },
      { lang: "pt-pt", label: "Portuguese", format: "srt" },
      { lang: "pt-br", label: "Portuguese (Brazil)", format: "vtt" },
    ];

    expect(pickBestSubtitleIndex(tracks, { lang: "en", preferHearingImpaired: "avoid" })).toBe(2);
    expect(pickBestSubtitleIndex(tracks, { lang: "en", preferHearingImpaired: "prefer" })).toBe(1);
    expect(pickBestSubtitleIndex(tracks, { lang: "pt-br" })).toBe(4);
    expect(pickBestSubtitleIndex(tracks, { lang: "pt-br" }, undefined, 4)).toBe(3);
    expect(pickBestSubtitleIndex(tracks, { lang: "ja" }, undefined, 2)).toBe(-1);
  });

  it("persists and evicts per-media subtitle memory as bounded LRU", () => {
    saveSubTrackMemory("tmdb:tv:1:s1e1", { selectedLang: "en", offsetSec: 0.5, enabled: true });
    saveSubTrackMemory("tmdb:tv:1:s1e1", { secondaryLang: "ja" });
    expect(loadSubTrackMemory("tmdb:tv:1:s1e1")).toMatchObject({
      selectedLang: "en",
      secondaryLang: "ja",
      offsetSec: 0.5,
      enabled: true,
    });

    for (let i = 0; i < 130; i++) {
      saveSubTrackMemory(`item:${i}`, { selectedLang: "en" });
    }
    expect(loadSubTrackMemory("tmdb:tv:1:s1e1")).toBeNull();
    expect(loadSubTrackMemory("item:129")).not.toBeNull();
  });
});
