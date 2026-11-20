import { afterEach, describe, expect, it } from "vitest";
import { closeDossier, lookupMedia, openDossier, registerMedia } from "./dossier";
import type { Media } from "./types";

const sample = (key: string): Media => ({
  key,
  kind: "movie",
  title: `Film ${key}`,
  overview: "Test synopsis",
  genres: ["Drama"],
});

describe("dossier store & media lookup", () => {
  afterEach(() => {
    closeDossier();
  });

  it("registers and retrieves media by key", () => {
    const m = sample("tmdb:movie:999001");
    registerMedia(m);
    expect(lookupMedia("tmdb:movie:999001")?.title).toBe("Film tmdb:movie:999001");
  });

  it("opens and closes the active quick dossier without throwing", () => {
    const m = sample("tmdb:movie:999002");
    openDossier(m);
    expect(lookupMedia("tmdb:movie:999002")).toEqual(m);
    closeDossier();
    // Safe idempotent close when already null
    closeDossier();
  });

  it("bounds the ephemeral lookup cache to 300 entries", () => {
    for (let i = 0; i < 310; i++) {
      registerMedia(sample(`tmdb:movie:cap-${i}`));
    }
    expect(lookupMedia("tmdb:movie:cap-0")).toBeUndefined();
    expect(lookupMedia("tmdb:movie:cap-309")?.key).toBe("tmdb:movie:cap-309");
  });
});
