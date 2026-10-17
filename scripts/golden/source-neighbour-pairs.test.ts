import { describe, expect, it } from "vitest";

import { neighbourPairs } from "./source-neighbour-pairs.ts";

const item = (pairId: string, library: string, basis: string, lo: string, hi: string) => ({
  pairId,
  kind: "source",
  library,
  loRoot: lo,
  hiRoot: hi,
  sets: [{ set: "source-neighbours", basis }]
});
const labels = {
  items: [
    item("source:golden:b", "golden", "second-nearest", "r1", "r3"),
    item("source:golden:a", "golden", "second-nearest", "r2", "r1"),
    item("source:golden:c", "golden", "nearest", "r1", "r2"),
    item("source:corpus:a", "corpus", "second-nearest", "r1", "r2"),
    { ...item("note:golden:x", "golden", "second-nearest", "r1", "r2"), kind: "note" }
  ]
};
const context = {
  roots: [
    { id: "r1", title: "Memory and forgetting" },
    { id: "r2", title: "Social memory" },
    { id: "r3", title: "Archives" }
  ]
};

describe("S1's second-library pair lists (R13)", () => {
  it("lists one library's labelled pairs of one basis by root title, in pair ID order", () => {
    expect(neighbourPairs(labels, context, "golden", "second-nearest")).toEqual([
      { left: "Social memory", right: "Memory and forgetting", label: "source:golden:a" },
      { left: "Memory and forgetting", right: "Archives", label: "source:golden:b" }
    ]);
    expect(neighbourPairs(labels, context, "golden", "nearest")).toHaveLength(1);
  });

  it("refuses a root missing from the context or a title that names several roots", () => {
    expect(() =>
      neighbourPairs(labels, { roots: context.roots.slice(0, 2) }, "golden", "second-nearest")
    ).toThrow("root r3 is not in the context export");
    expect(() =>
      neighbourPairs(
        labels,
        { roots: [...context.roots, { id: "r4", title: "Archives" }] },
        "golden",
        "second-nearest"
      )
    ).toThrow("names several roots");
  });
});
