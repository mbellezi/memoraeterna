import { describe, expect, it } from "vitest";

import {
  pairKey,
  renderReplayMarkdown,
  replayInputSchema,
  replayOrder,
  replayOutcomes,
  replaySourceOrders,
  runSourceOrderReplay,
  shuffledOrder,
  type ReplayInput,
  type SelectedPairContext
} from "./source-order-replay.ts";

/** Unit vectors at a given cosine from axis 0 (each in its own plane). */
const at = (cosine: number, axis: number) =>
  Array.from({ length: 8 }, (_, i) =>
    i === 0 ? cosine : i === axis ? Math.sqrt(1 - cosine * cosine) : 0
  );

const input = (overrides: Partial<ReplayInput> = {}): ReplayInput =>
  replayInputSchema.parse({
    format: "memora-source-order-replay-input",
    version: 1,
    roots: [
      { id: "A", title: "Alpha", vector: at(1, 1), hasNotes: true },
      { id: "B", title: "Beta", vector: at(0.9, 1), hasNotes: true },
      { id: "C", title: "Gamma", vector: at(0.2, 2), hasNotes: true },
      { id: "D", title: "Delta", vector: at(0.1, 3), hasNotes: true }
    ],
    promoted: [["C", "D"]],
    verdicts: [
      { pair: ["A", "B"], accepted: true },
      { pair: ["A", "C"], accepted: false },
      { pair: ["B", "C"], accepted: false }
    ],
    expected: [
      ["A", "B"],
      ["C", "D"]
    ],
    forbidden: [["B", "C"]],
    ...overrides
  });

describe("source-order replay (S1)", () => {
  it("links promoted pairs with no call and judged pairs the recordings accept", () => {
    const outcome = replayOrder(input(), ["A", "B", "C", "D"], { neighbours: 1 });
    expect(outcome).toMatchObject({ expected: 2, forbidden: 0 });
    // B judges A (nearest); C judges A (nearest; B's bar 0.9 is not beaten); D is linked to C by
    // promotion and judges its nearest unlinked root.
    expect(outcome.calls).toBe(3);
  });

  it("names the pairs an order reaches that no recording judged", () => {
    const outcome = replayOrder(input(), ["A", "B", "C", "D"], { neighbours: 1 });
    expect(outcome.unjudged.length).toBe(1);
    expect(outcome.unjudged[0]).toMatch(/\|D$|^D\|/u);
  });

  it("counts a forbidden pair an accepted verdict links", () => {
    const outcome = replayOrder(
      input({
        verdicts: [
          { pair: ["A", "B"], accepted: true },
          { pair: ["A", "C"], accepted: true },
          { pair: ["B", "C"], accepted: true }
        ],
        forbidden: [["A", "C"]]
      }),
      ["A", "B", "C", "D"],
      { neighbours: 1 }
    );
    expect(outcome.forbidden).toBe(1);
  });

  it("is deterministic per seed and reports the S1 bar over many orders", () => {
    expect(shuffledOrder(["A", "B", "C", "D"], 7)).toEqual(shuffledOrder(["A", "B", "C", "D"], 7));
    expect(
      new Set([1, 2, 3, 4, 5].map((seed) => shuffledOrder(["A", "B", "C", "D"], seed).join())).size
    ).toBeGreaterThan(1);
    const report = replaySourceOrders(input(), { orders: 50, neighbours: 1, minExpected: 2 });
    expect(report).toMatchObject({ orders: 50, roots: 4, expectedTotal: 2, forbiddenTotal: 1 });
    expect(report.forbidden.max).toBe(0);
    expect(report.pass).toBe(report.expected.share >= 0.95);
    expect(renderReplayMarkdown(report)).toContain("S1 order replay:");
    expect(replaySourceOrders(input(), { orders: 50, neighbours: 1, minExpected: 2 })).toEqual(
      report
    );
  });

  it("judges more pairs with two neighbours", () => {
    const one = replaySourceOrders(input(), { orders: 20, neighbours: 1, minExpected: 2 });
    const two = replaySourceOrders(input(), { orders: 20, neighbours: 2, minExpected: 2 });
    expect(two.callsPerSource.mean).toBeGreaterThanOrEqual(one.callsPerSource.mean);
  });

  it("never judges a root without notes as a candidate", () => {
    const outcome = replayOrder(
      input({
        roots: [
          { id: "A", title: "Alpha", vector: at(1, 1), hasNotes: false },
          { id: "B", title: "Beta", vector: at(0.9, 1), hasNotes: true }
        ],
        promoted: [],
        expected: [],
        forbidden: []
      }),
      ["A", "B"],
      { neighbours: 1 }
    );
    expect(outcome.calls).toBe(0);
    expect(pairKey("B", "A")).toBe("A|B");
  });

  it("refuses an input that is not a replay input", async () => {
    expect(replayInputSchema.safeParse({ format: "other" }).success).toBe(false);
    expect(await runSourceOrderReplay(["--help"])).toContain("--input");
    await expect(runSourceOrderReplay([])).rejects.toThrow("--input is required.");
  });

  it("counts the arrivals that had a pair to judge, the calls of a judge that takes a root in one call", () => {
    const one = replayOrder(input(), ["A", "B", "C", "D"], { neighbours: 1 });
    expect(one.batches).toBe(one.calls);
    const two = replayOrder(input(), ["A", "B", "C", "D"], { neighbours: 2 });
    expect(two.calls).toBeGreaterThan(two.batches);
    expect(two.batches).toBe(3);
  });

  it("shares one cosine memo across orders without changing a single outcome", () => {
    const ids = ["A", "B", "C", "D"];
    const outcomes = replayOutcomes(input(), { orders: 12, neighbours: 2 });
    expect(outcomes).toHaveLength(12);
    outcomes.forEach((outcome, index) =>
      expect(outcome).toEqual(
        replayOrder(input(), shuffledOrder(ids, index + 1), { neighbours: 2, seed: index + 1 })
      )
    );
  });

  describe("a pair gate in front of the judge", () => {
    const order = ["A", "B", "C", "D"];

    it("keeps everything when it allows every pair, and says what it saw", () => {
      const seen: Array<[string, string, number | null]> = [];
      const gated = replayOrder(input(), order, {
        neighbours: 2,
        pairGate: (context) => {
          seen.push([context.rootId, context.candidateId, context.nearestRank]);
          return true;
        }
      });
      expect(gated).toEqual(replayOrder(input(), order, { neighbours: 2 }));
      expect(gated.skipped).toEqual([]);
      // C is nearest to A (0.2) and then B (0.18): ranks 1 and 2.
      expect(seen).toContainEqual(["C", "A", 1]);
      expect(seen).toContainEqual(["C", "B", 2]);
    });

    it("spends no call on a pair it refuses, and never links it", () => {
      const ungated = replayOrder(input(), order, { neighbours: 2 });
      const gated = replayOrder(input(), order, {
        neighbours: 2,
        pairGate: (context) => context.nearestRank !== 2
      });
      expect(gated.skipped).toEqual(["B|C", "B|D"]);
      expect(gated.calls).toBe(ungated.calls - gated.skipped.length);
      expect(gated.unjudged.every((key) => !gated.skipped.includes(key))).toBe(true);
    });

    it("hands the gate both sides of a pair: the arriving root's nearest and the candidate's", () => {
      const contexts: SelectedPairContext[] = [];
      replayOrder(input(), order, {
        neighbours: 2,
        pairGate: (context) => {
          contexts.push(context);
          return true;
        }
      });
      const second = contexts.find((item) => item.rootId === "C" && item.candidateId === "B")!;
      expect(second).toMatchObject({ reason: "nearest", nearestRank: 2 });
      expect(second.nearestCosine).toBeCloseTo(0.2, 9);
      expect(second.cosine).toBeCloseTo(0.18, 9);
      // B's stored nearest is A, at cosine 0.9.
      expect(second.candidateNearestCosine).toBeCloseTo(0.9, 9);
    });
  });
});
