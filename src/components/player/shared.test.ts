import { describe, expect, it } from "vitest";
import { convertCues, cueSignature } from "./shared";

function makeTrackCueList(items: Array<Partial<VTTCue> & { startTime: number; endTime: number; text: string }>): TextTrackCueList {
  return items as unknown as TextTrackCueList;
}

describe("player shared subtitle helpers", () => {
  it("converts snapToLines percentage cues without assigning pos to standard bottom lines", () => {
    const list = makeTrackCueList([
      {
        startTime: 1,
        endTime: 4,
        text: "Spoken bottom dialogue",
        snapToLines: false,
        line: 90,
        align: "center",
      },
      {
        startTime: 1,
        endTime: 4,
        text: "Guild Notice",
        snapToLines: false,
        line: 35,
        position: 25,
        align: "center",
      },
    ]);

    const cues = convertCues(list, "t0");
    expect(cues).toHaveLength(2);

    expect(cues[0].align).toBe(2);
    expect(cues[0].pos).toBeUndefined();
    expect(cues[0].kind).toBe("dialogue");

    expect(cues[1].pos).toEqual({ xPct: 25, yPct: 35 });
    expect(cues[1].kind).toBe("sign");
  });

  it("parses inline ASS alignment overrides and HTML entities inside TextTrack cues", () => {
    const list = makeTrackCueList([
      {
        startTime: 2,
        endTime: 5,
        text: "{\\an8}It&apos;s on the top board",
        align: "center",
      },
    ]);

    const cues = convertCues(list, "t1");
    expect(cues).toHaveLength(1);
    expect(cues[0].align).toBe(8);
    expect(cues[0].text).toBe("It's on the top board");
    expect(cues[0].kind).toBe("sign");
  });

  it("includes kind and pos in cueSignature so layout changes invalidate renders", () => {
    const listA = makeTrackCueList([
      { startTime: 0, endTime: 2, text: "Notice", align: "center" },
    ]);
    const cuesA = convertCues(listA, "k");
    const sigDialogue = cueSignature([{ ...cuesA[0], kind: "dialogue" }]);
    const sigSign = cueSignature([{ ...cuesA[0], kind: "sign" }]);
    const sigMoved = cueSignature([{ ...cuesA[0], kind: "sign", pos: { xPct: 20, yPct: 30 } }]);

    expect(sigDialogue).not.toBe(sigSign);
    expect(sigSign).not.toBe(sigMoved);
    expect(cueSignature([])).toBe("");
  });
});
