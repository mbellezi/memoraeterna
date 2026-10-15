import { describe, expect, it } from "vitest";

import {
  ItemKeySchema,
  compareContentKeys,
  itemKey,
  normalizeTopicTitle,
  parseItemKey,
  rowContentHash,
  rowItemKey,
  rowOfItemKey,
  sameTopicTitle
} from "./ids.js";

const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("item keys and content-key order", () => {
  it("formats and parses product item keys", () => {
    expect(itemKey("note", uuid.toUpperCase())).toBe(`note:${uuid}`);
    expect(parseItemKey(`source:${uuid}`)).toEqual({ kind: "source", id: uuid });
    expect(ItemKeySchema.safeParse(`note:${uuid}`).success).toBe(true);
    for (const bad of [`topic:${uuid}`, "note:abc", `note:${uuid.toUpperCase()}`, "row:3"]) {
      expect(ItemKeySchema.safeParse(bad).success).toBe(false);
      expect(parseItemKey(bad)).toBeNull();
    }
    expect(() => itemKey("note", "not-a-uuid")).toThrow();
  });

  it("maps batch rows to keys whose content order is the row order", () => {
    expect(rowItemKey(42)).toBe("row:42");
    expect(rowOfItemKey("row:42")).toBe(42);
    expect(rowOfItemKey("row:042")).toBeUndefined();
    expect(rowOfItemKey(`note:${uuid}`)).toBeUndefined();
    const rows = [9, 10, 100, 2];
    const sorted = rows
      .map((row) => ({ key: rowItemKey(row), contentHash: rowContentHash(row) }))
      .sort(compareContentKeys)
      .map((entry) => rowOfItemKey(entry.key));
    expect(sorted).toEqual([2, 9, 10, 100]);
  });

  it("orders by content hash, then key, by code unit", () => {
    const a = { key: "note:b", contentHash: "aa" };
    const b = { key: "note:a", contentHash: "ab" };
    const c = { key: "note:c", contentHash: "aa" };
    expect([b, c, a].sort(compareContentKeys)).toEqual([a, c, b]);
    expect(
      compareContentKeys({ key: "Z", contentHash: "x" }, { key: "a", contentHash: "x" })
    ).toBeLessThan(0);
  });
});

describe("I7 title normalization", () => {
  it("is case- and accent-insensitive", () => {
    expect(normalizeTopicTitle("Memória")).toBe("memoria");
    expect(sameTopicTitle("Memória", "memoria")).toBe(true);
    expect(sameTopicTitle("AÇÃO  Política ", "acao politica")).toBe(true);
    expect(sameTopicTitle("Straße", "strasse")).toBe(true);
    expect(sameTopicTitle("Ærø", "aero")).toBe(true);
    expect(sameTopicTitle("ﬁlosofia", "filosofia")).toBe(true);
  });

  it("keeps distinct titles distinct", () => {
    expect(sameTopicTitle("Memória", "Memórias")).toBe(false);
    expect(sameTopicTitle("Física", "Fisica quântica")).toBe(false);
  });
});
