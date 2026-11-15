import { describe, expect, it } from "vitest";
import { TrickplayEngine } from "./trickplay";

describe("TrickplayEngine", () => {
  it("answers superseded requests with null instead of queueing seeks", async () => {
    // jsdom never loads the media, so the engine stays busy waiting: exactly the "seek in flight" case.
    const eng = new TrickplayEngine("file", "https://cdn.example/film.mp4");
    void eng.frameAt(10); // taken up at once: the engine is now busy
    const second = eng.frameAt(40);
    const third = eng.frameAt(80);
    await expect(second).resolves.toBeNull();
    eng.dispose();
    await expect(third).resolves.toBeNull();
  });
});
