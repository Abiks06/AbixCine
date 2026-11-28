import { beforeEach, describe, expect, it } from "vitest";
import {
  collectionsForKey,
  createCollection,
  deleteCollection,
  getCollections,
  renameCollection,
  resetCollectionsForTest,
  toggleInCollection,
} from "./collections";

describe("collections store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCollectionsForTest();
  });

  it("creates, deduplicates names, renames, and deletes collections", () => {
    expect(createCollection("   ")).toBeNull();

    const first = createCollection("  Sci-Fi   Classics ");
    expect(first).not.toBeNull();
    expect(first!.name).toBe("Sci-Fi Classics");
    expect(getCollections()).toHaveLength(1);

    // Case-insensitive duplicate returns existing collection instead of duplicating
    const dup = createCollection("sci-fi classics");
    expect(dup?.id).toBe(first!.id);
    expect(getCollections()).toHaveLength(1);

    // Truncates long names to 48 chars
    const longCol = createCollection("A".repeat(80));
    expect(longCol!.name).toHaveLength(48);

    // Rename
    expect(renameCollection(first!.id, "Modern Sci-Fi")).toBe(true);
    expect(renameCollection(first!.id, "   ")).toBe(false);
    expect(getCollections().find((c) => c.id === first!.id)?.name).toBe("Modern Sci-Fi");

    // Delete
    expect(deleteCollection(first!.id)).toBe(true);
    expect(deleteCollection(first!.id)).toBe(false);
    expect(getCollections().some((c) => c.id === first!.id)).toBe(false);
  });

  it("toggles media keys cleanly and reports membership", () => {
    const c1 = createCollection("Weekend Binge")!;
    const c2 = createCollection("Cozy Rewatch")!;

    expect(toggleInCollection(c1.id, "tmdb:tv:95396")).toBe(true);
    expect(toggleInCollection(c2.id, "tmdb:tv:95396")).toBe(true);
    expect(collectionsForKey("tmdb:tv:95396").map((c) => c.id)).toEqual([c2.id, c1.id]);

    expect(toggleInCollection(c1.id, "tmdb:tv:95396")).toBe(false);
    expect(collectionsForKey("tmdb:tv:95396").map((c) => c.id)).toEqual([c2.id]);
    expect(toggleInCollection("missing-id", "tmdb:tv:95396")).toBe(false);

    // Persisted in localStorage
    const persisted = JSON.parse(localStorage.getItem("abx.collections.v1") || "[]");
    expect(persisted).toHaveLength(2);
    expect(persisted[0].keys).toContain("tmdb:tv:95396");
  });
});
