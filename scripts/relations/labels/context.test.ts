import { describe, expect, it } from "vitest";

import { collapsedOffset, nearestRoots, pickExcerptChunks, rootsOf } from "./context.ts";

const unit = (...values: number[]) => {
  const norm = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / norm));
};

describe("the library context", () => {
  it("rolls every source up to its top-level root", () => {
    const roots = rootsOf([
      { id: "book", parentId: null },
      { id: "chapter", parentId: "book" },
      { id: "section", parentId: "chapter" },
      { id: "orphan", parentId: "gone" }
    ]);
    expect([...roots.entries()]).toEqual([
      ["book", "book"],
      ["chapter", "book"],
      ["section", "book"],
      ["orphan", "orphan"]
    ]);
  });

  it("lists each root's nearest roots by cosine, most similar first", () => {
    const neighbours = nearestRoots(
      new Map([
        ["a", unit(1, 0)],
        ["b", unit(1, 0.1)],
        ["c", unit(0, 1)],
        ["d", unit(1, 1)]
      ]),
      2
    );
    expect(neighbours.get("a")!.map((item) => item.id)).toEqual(["b", "d"]);
    expect(neighbours.get("c")!.map((item) => item.id)).toEqual(["d", "b"]);
  });

  it("takes each side's excerpts from the closest cross-root note pairs, distinct chunks, skipping overviews", () => {
    const lo = [
      { id: "l1", chunkId: "lc1", vector: unit(1, 0) },
      { id: "l2", chunkId: "lc1", vector: unit(0.9, 0.1) },
      { id: "l3", chunkId: "lc2", vector: unit(0, 1) },
      { id: "l4", chunkId: "lc3", vector: unit(0.7, 0.7) }
    ];
    const hi = [
      { id: "h1", chunkId: "hc1", vector: unit(1, 0.05) },
      { id: "h2", chunkId: "hc2", vector: unit(0.2, 1) }
    ];
    const chosen = pickExcerptChunks(lo, hi);
    expect(chosen.lo.map((item) => item.chunkId)).toEqual(["lc1", "lc2"]);
    expect(chosen.hi.map((item) => item.chunkId)).toEqual(["hc1", "hc2"]);
    expect(pickExcerptChunks(lo, hi, 2, new Set(["lc1"])).lo.map((item) => item.chunkId)).toEqual([
      "lc2",
      "lc3"
    ]);
  });

  it("maps a raw offset into the whitespace-collapsed text", () => {
    const raw = "  one\n\n two   three";
    expect(collapsedOffset(raw, raw.indexOf("three"))).toBe("one two ".length);
  });
});
