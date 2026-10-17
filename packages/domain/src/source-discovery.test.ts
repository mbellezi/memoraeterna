import { describe, expect, it } from "vitest";

import { selectDiscoveryPairs, type DiscoveryCandidate } from "./source-discovery.js";

const candidate = (
  rootId: string,
  cosine: number,
  overrides: Partial<DiscoveryCandidate> = {}
): DiscoveryCandidate => ({
  rootId,
  title: `Title ${rootId}`,
  cosine,
  linked: false,
  nearestRootId: "Z",
  nearestCosine: 0.99,
  nearestRootCosine: 0.99,
  ...overrides
});

describe("discovery pairs of design E (D27)", () => {
  it("judges the nearest unlinked earlier root and stores it as the root's bar", () => {
    const selection = selectDiscoveryPairs({
      rootId: "R",
      candidates: [candidate("A", 0.6), candidate("B", 0.8), candidate("C", 0.9, { linked: true })],
      neighbours: 1
    });
    expect(selection.pairs).toEqual([{ rootId: "B", reason: "nearest", cosine: 0.8 }]);
    expect(selection.state).toEqual({ nearestRootId: "B", nearestCosine: 0.8 });
    expect(selection.reverse).toEqual([]);
  });

  it("adds every earlier root whose bar the new root beats, and updates its nearest", () => {
    const selection = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("A", 0.9),
        candidate("B", 0.7, { nearestRootId: "A", nearestCosine: 0.6, nearestRootCosine: 0.6 }),
        candidate("C", 0.5, { nearestCosine: 0.5 }),
        candidate("D", 0.4, { nearestRootId: null, nearestCosine: null, nearestRootCosine: null }),
        candidate("E", 0.95, { linked: true, nearestCosine: 0.1 })
      ],
      neighbours: 1
    });
    expect(selection.pairs).toEqual([
      { rootId: "A", reason: "nearest", cosine: 0.9 },
      { rootId: "B", reason: "reverse", cosine: 0.7 },
      { rootId: "D", reason: "reverse", cosine: 0.4 }
    ]);
    expect(selection.reverse).toEqual([
      { rootId: "B", nearestRootId: "R", nearestCosine: 0.7 },
      { rootId: "D", nearestRootId: "R", nearestCosine: 0.4 }
    ]);
  });

  it("judges mutual nearest roots once: the first root's empty bar is beaten by the second", () => {
    const selection = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("A", 0.8, { nearestRootId: null, nearestCosine: null, nearestRootCosine: null })
      ],
      neighbours: 1
    });
    expect(selection.pairs).toEqual([{ rootId: "A", reason: "nearest", cosine: 0.8 }]);
    expect(selection.reverse).toEqual([{ rootId: "A", nearestRootId: "R", nearestCosine: 0.8 }]);
  });

  it("selects nothing for the first root of a space", () => {
    expect(selectDiscoveryPairs({ rootId: "R", candidates: [], neighbours: 1 })).toEqual({
      pairs: [],
      state: { nearestRootId: null, nearestCosine: null },
      reverse: []
    });
  });

  it("never selects the root itself", () => {
    expect(
      selectDiscoveryPairs({ rootId: "R", candidates: [candidate("R", 1)], neighbours: 1 }).pairs
    ).toEqual([]);
  });

  it("with two neighbours judges the two nearest and keeps the second's cosine as the bar", () => {
    const selection = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("A", 0.9),
        candidate("B", 0.8),
        candidate("C", 0.75, { nearestRootId: "A", nearestCosine: 0.7, nearestRootCosine: 0.72 })
      ],
      neighbours: 2
    });
    expect(selection.pairs.map((pair) => [pair.rootId, pair.reason])).toEqual([
      ["A", "nearest"],
      ["B", "nearest"],
      ["C", "reverse"]
    ]);
    expect(selection.state).toEqual({ nearestRootId: "A", nearestCosine: 0.8 });
    // C's two nearest are now R (0.75) and A (0.72): R is nearest, the bar is A's cosine.
    expect(selection.reverse).toEqual([{ rootId: "C", nearestRootId: "R", nearestCosine: 0.72 }]);
    // One known neighbour: the second slot was empty, so R joins and the bar is the lower one.
    expect(
      selectDiscoveryPairs({
        rootId: "R",
        candidates: [
          candidate("A", 0.6, { nearestRootId: "B", nearestCosine: null, nearestRootCosine: 0.8 })
        ],
        neighbours: 2
      }).reverse
    ).toEqual([{ rootId: "A", nearestRootId: "B", nearestCosine: 0.6 }]);
  });

  it("plans a root again with the same pairs: the reverse neighbours it joined stay, states kept", () => {
    const first = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("N", 0.9, { nearestRootId: "X", nearestCosine: 0.5, nearestRootCosine: 0.5 }),
        candidate("X", 0.83, { nearestRootId: "N", nearestCosine: 0.5, nearestRootCosine: 0.5 })
      ],
      neighbours: 1
    });
    expect(first.pairs.map((pair) => [pair.rootId, pair.reason])).toEqual([
      ["N", "nearest"],
      ["X", "reverse"]
    ]);
    // The stored states after the first plan: both bars are now the cosine to R itself.
    const replanned = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("N", 0.9, { nearestRootId: "R", nearestCosine: 0.9, nearestRootCosine: 0.9 }),
        candidate("X", 0.83, { nearestRootId: "R", nearestCosine: 0.83, nearestRootCosine: 0.83 })
      ],
      neighbours: 1
    });
    expect(replanned.pairs).toEqual(first.pairs);
    expect(replanned.state).toEqual(first.state);
    expect(replanned.reverse).toEqual([]);
  });

  it("with two neighbours recognizes the root it joined as the second nearest by the bar", () => {
    // X's two nearest are A and R: its bar is R's own cosine, its nearest stays A.
    const replanned = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("B", 0.98),
        candidate("A", 0.95),
        candidate("X", 0.9, { nearestRootId: "A", nearestCosine: 0.9, nearestRootCosine: 0.95 })
      ],
      neighbours: 2
    });
    expect(replanned.pairs.map((pair) => [pair.rootId, pair.reason])).toEqual([
      ["B", "nearest"],
      ["A", "nearest"],
      ["X", "reverse"]
    ]);
    expect(replanned.reverse.map((update) => update.rootId)).not.toContain("X");
  });

  it("selects the owed roots an earlier plan left unjudged, keeping their state, unless linked", () => {
    const selection = selectDiscoveryPairs({
      rootId: "R",
      candidates: [
        candidate("N", 0.9),
        // A later root beat R at X: R is no longer X's nearest, but the pair was never judged.
        candidate("X", 0.83, { nearestRootId: "S", nearestCosine: 0.99 }),
        candidate("Y", 0.8, { linked: true, nearestRootId: "S", nearestCosine: 0.99 }),
        candidate("Z", 0.7)
      ],
      neighbours: 1,
      owed: ["X", "Y"]
    });
    expect(selection.pairs.map((pair) => [pair.rootId, pair.reason])).toEqual([
      ["N", "nearest"],
      ["X", "owed"]
    ]);
    expect(selection.reverse).toEqual([]);
  });

  it("breaks cosine ties on the title, never on the ID first", () => {
    const selection = selectDiscoveryPairs({
      rootId: "R",
      candidates: [candidate("a", 0.8, { title: "Zeta" }), candidate("z", 0.8, { title: "Alpha" })],
      neighbours: 1
    });
    expect(selection.pairs[0]!.rootId).toBe("z");
  });
});
