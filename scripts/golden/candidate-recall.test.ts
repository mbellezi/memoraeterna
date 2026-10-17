import { describe, expect, it } from "vitest";

import {
  candidateRecall,
  preFreezeFeasibility,
  renderCandidateRecallMarkdown,
  renderFeasibility,
  sealCandidateRecall
} from "./candidate-recall.ts";
import type { ExportCandidate, PairScores } from "./relations-export.ts";
import {
  expectedHeldOut,
  forbiddenHeldOut,
  mapping,
  notesOfPair,
  strongRelation,
  worldExport
} from "./test-world.ts";

const candidate = (
  pair: string,
  finalRank: number,
  ranks: Partial<Pick<ExportCandidate, "vectorRank" | "textRank" | "graphRank">> = {}
): ExportCandidate => {
  const [source, target] = notesOfPair(pair);
  return {
    sourceNoteId: source,
    targetNoteId: target,
    finalRank,
    textRank: ranks.textRank ?? null,
    vectorRank: ranks.vectorRank ?? null,
    graphRank: ranks.graphRank ?? null,
    textScore: null,
    vectorScore: null,
    metadataScore: null,
    graphScore: null,
    fusionScore: null,
    rerankScore: null,
    finalScore: null,
    passedThreshold: null
  };
};

const tuningExpected = mapping.expectedRootPairs
  .filter((entry) => entry.partition === "tuning")
  .map((entry) => entry.pair.slice().sort().join("/"));

describe("candidate recall per expected root pair", () => {
  it("says whether a note pair reached the decider within k, at what rank and through which signals", () => {
    const data = worldExport();
    const [reachedPair, deepPair, unseenPair] = tuningExpected as [string, string, string];
    data.candidates = [
      candidate(reachedPair, 4, { vectorRank: 2, textRank: 9 }),
      candidate(deepPair, 25, { vectorRank: 25 }),
      candidate(tuningExpected[3]!, 2, { graphRank: 1 }),
      candidate(tuningExpected[3]!, 7, { vectorRank: 7 })
    ];
    const recall = candidateRecall(data, mapping);
    expect(recall.basis).toBe("candidates");
    expect(recall.k).toBe(20);
    const find = (pair: string) => recall.pairs.find((entry) => entry.pair === pair)!;
    expect(find(reachedPair)).toMatchObject({
      reached: true,
      reaching: 1,
      bestRank: 4,
      signals: ["vector", "text"],
      partition: "tuning",
      evaluable: true
    });
    // Rank 25 is beyond k = 20: not reached. A pair that no candidate list holds is not reached either.
    expect(find(deepPair)).toMatchObject({
      reached: false,
      reaching: 0,
      bestRank: null,
      signals: []
    });
    expect(find(unseenPair).reached).toBe(false);
    // The same unordered note pair listed from both sides counts once, at its best rank.
    expect(find(tuningExpected[3]!)).toMatchObject({
      reaching: 1,
      bestRank: 2,
      signals: ["graph"]
    });
    expect(
      candidateRecall(data, mapping, { k: 30 }).pairs.find((e) => e.pair === deepPair)!.reached
    ).toBe(true);
    expect(recall.summary.tuning).toMatchObject({ total: 26, evaluable: 26, reached: 2 });
    expect(recall.summary.holdout).toMatchObject({ total: 28, reached: 0 });
  });

  it("falls back to decisions and relations as a lower bound when the export has no candidate lists", () => {
    const data = worldExport();
    data.relations = [strongRelation(tuningExpected[0]!)];
    const [lo, hi] = notesOfPair(tuningExpected[1]!);
    data.decisions = [
      { loNoteId: lo, hiNoteId: hi, deciderKey: "k", loToHiScore: 0.2, hiToLoScore: null, loToHiType: "supports", hiToLoType: null, accepted: false }
    ]; // prettier-ignore
    const recall = candidateRecall(data, mapping);
    expect(recall.basis).toBe("decisions-and-relations");
    expect(recall.summary.tuning.reached).toBe(2);
    expect(recall.warnings.join(" ")).toContain("lower bound");
    expect(recall.pairs.find((entry) => entry.pair === tuningExpected[0])).toMatchObject({
      reached: true,
      bestRank: null,
      signals: ["vector", "text"]
    });
  });

  it("reports roots missing from the library as not evaluable", () => {
    const data = worldExport();
    data.sources = data.sources.filter((source) => !source.id.includes("-Q5"));
    const recall = candidateRecall(data, mapping);
    expect(recall.pairs.filter((entry) => !entry.evaluable).length).toBeGreaterThan(0);
    expect(recall.summary.holdout.evaluable).toBeLessThan(28);
  });

  it("prints tuning pairs only until the freeze record opens (decision D3)", () => {
    const data = worldExport();
    data.candidates = [candidate(expectedHeldOut()[0]!, 1, { vectorRank: 1 })];
    const recall = candidateRecall(data, mapping);
    const sealed = renderCandidateRecallMarkdown(recall, { open: false, reason: "no frozen.json" });
    for (const pair of expectedHeldOut()) expect(sealed).not.toContain(`| ${pair} |`);
    expect(sealed).toContain("held-out sealed until the freeze");
    expect(sealed).toContain("Expected tuning root pairs: 0 of 26 reached the decider");
    expect(sealed).not.toContain("held-out root pairs:");
    const opened = renderCandidateRecallMarkdown(recall, {
      open: true,
      frozen: {
        configHash: "sha256:0123456789abcdef",
        calibrationIdentity: "x",
        parity: {},
        inputHashes: {},
        frozenAt: "2026-10-30T12:00:00Z"
      }
    });
    expect(opened).toContain(`| ${expectedHeldOut()[0]} | yes | 1 | 1 | 1 | vector |`);
    expect(opened).toContain("Expected held-out root pairs: 1 of 28 reached the decider");
    const json = sealCandidateRecall(recall);
    expect(json.pairs.every((entry) => entry.partition === "tuning")).toBe(true);
    expect(json.heldOut).toBe("sealed");
    expect("holdout" in json.summary).toBe(false);
  });
});

describe("--pre-freeze-feasibility: two held-out aggregates and nothing else", () => {
  const scores = (): { data: ReturnType<typeof worldExport>; ranker: PairScores } => {
    const data = worldExport();
    const expected = expectedHeldOut();
    const forbidden = forbiddenHeldOut();
    // 27 of 28 expected pairs reach the decider (the last never does).
    data.candidates = [
      ...expected
        .slice(0, 27)
        .map((pair, index) => candidate(pair, (index % 20) + 1, { vectorRank: 1 })),
      candidate(forbidden[0]!, 3, { vectorRank: 3 }),
      candidate(forbidden[1]!, 5, { vectorRank: 5 })
    ];
    const rows = (pair: string, forward: number, backward: number) => {
      const [a, b] = notesOfPair(pair);
      return [
        { query: a, doc: b, logOdds: forward },
        { query: b, doc: a, logOdds: backward }
      ];
    };
    return {
      data,
      ranker: {
        format: "memora-relations-pair-scores",
        version: 1,
        decider: "test",
        scale: "log-odds",
        scores: [
          // 26 expected pairs score over the rule in at least one direction, the 27th does not.
          ...expected.slice(0, 26).flatMap((pair) => rows(pair, 4, -2)),
          ...rows(expected[26]!, 1, 0.5),
          // One forbidden pair is linked by the max of its directions; the other is not.
          ...rows(forbidden[0]!, -3, 5),
          ...rows(forbidden[1]!, 0, 0)
        ]
      }
    };
  };

  it("counts reachable expected pairs and the ranker's expected and forbidden links", () => {
    const { data, ranker } = scores();
    const feasibility = preFreezeFeasibility(data, mapping, ranker, {
      aggregation: "max",
      threshold: 3.3125
    });
    expect(feasibility.reachable).toEqual({ count: 27, total: 28 });
    expect(feasibility.ranker).toEqual({
      expected: 26,
      expectedTotal: 28,
      forbidden: 1,
      forbiddenTotal: 35
    });
    // The mean of both directions is a stricter rule on the same scores.
    const mean = preFreezeFeasibility(data, mapping, ranker, {
      aggregation: "mean",
      threshold: 3.3125
    });
    expect(mean.ranker.expected).toBe(0);
    expect(mean.ranker.forbidden).toBe(0);
  });

  it("ignores scored pairs the retrieval never offered", () => {
    const { data, ranker } = scores();
    data.candidates = data.candidates.slice(0, 5);
    const feasibility = preFreezeFeasibility(data, mapping, ranker, {
      aggregation: "max",
      threshold: 3.3125
    });
    expect(feasibility.reachable.count).toBe(5);
    expect(feasibility.ranker.expected).toBe(5);
    expect(feasibility.ranker.forbidden).toBe(0);
  });

  it("prints exactly two lines and no pair identifier", () => {
    const { data, ranker } = scores();
    const text = renderFeasibility(
      preFreezeFeasibility(data, mapping, ranker, { aggregation: "max", threshold: 3.3125 }),
      "MLX"
    );
    const lines = text.split("\n");
    expect(lines).toEqual([
      "held-out expected root pairs reachable at k=20: 27 of 28",
      "MLX at max of both directions >= 3.3125 log-odds: held-out expected 26 of 28, forbidden 1 of 35"
    ]);
    // No root pair ("Q1/Q5") and no root id of the fixture appears in the output.
    expect(text).not.toMatch(/[A-Za-z0-9]+\/[A-Za-z0-9]+/u);
    for (const root of mapping.roots) expect(text).not.toMatch(new RegExp(`\\b${root.id}\\b`, "u"));
  });
});
