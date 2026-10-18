import { describe, expect, it } from "vitest";

import {
  aggregateDirections,
  bandScore,
  bandThresholds,
  calibrate,
  fitIsotonic,
  reconcileBands,
  relationCalibrationIdentityKey,
  RelationCalibrationEntrySchema,
  selectBands,
  stratumWeights,
  weightedPrecision,
  wilsonLowerBound,
  type IsotonicPoint,
  type RelationCalibrationEntry,
  type RelationCalibrationIdentity
} from "./relation-calibration.js";

const hash = (digit: string) => digit.repeat(64);
const identity: RelationCalibrationIdentity = {
  contract: "relation-decide-v1",
  instructionSha256: hash("a"),
  template: "relation-pair-text-v1",
  bodyCharacters: 400,
  rule: "max",
  provider: "local",
  model: "mlx-qwen3-reranker-0.6b",
  runtimeKind: "mlx",
  repository: "Qwen/Qwen3-Reranker-0.6B",
  revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
  quantization: "bf16",
  artifactSha256: hash("b")
};
const isotonic = (
  blocks: Array<[number, number]>,
  applyFrom: number | null,
  suggestFrom: number | null
): RelationCalibrationEntry =>
  RelationCalibrationEntrySchema.parse({
    kind: "isotonic",
    identity,
    blocks: blocks.map(([fromScore, probability]) => ({ fromScore, probability })),
    applyFrom,
    suggestFrom,
    basis: "test",
    labelSetHash: hash("c"),
    freezeHash: hash("d"),
    fittedAt: "2026-10-20T10:00:00.000Z",
    parity: { referenceHash: hash("e"), scores: [1.5] }
  });

/** A seeded linear congruential generator, so every sample here is the same on every run. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("aggregation of both directions", () => {
  it("takes the max or the mean, and refuses a missing direction", () => {
    expect(aggregateDirections(1, 4, "max")).toBe(4);
    expect(aggregateDirections(1, 4, "mean")).toBe(2.5);
    expect(() => aggregateDirections(Number.NaN, 4, "max")).toThrow();
  });
});

describe("isotonic calibration", () => {
  it("is a step function, flat outside the observed range", () => {
    const blocks = [
      { fromScore: 0, probability: 0.1 },
      { fromScore: 2, probability: 0.5 },
      { fromScore: 4, probability: 0.9 }
    ];
    expect(calibrate(-10, blocks)).toBe(0.1);
    expect(calibrate(0, blocks)).toBe(0.1);
    expect(calibrate(1.99, blocks)).toBe(0.1);
    expect(calibrate(2, blocks)).toBe(0.5);
    expect(calibrate(3.5, blocks)).toBe(0.5);
    expect(calibrate(4, blocks)).toBe(0.9);
    expect(calibrate(99, blocks)).toBe(0.9);
    expect(() => calibrate(1, [])).toThrow();
  });

  it("fits a known answer: violators pool, small blocks merge, blocks are smoothed", () => {
    // Raw shares by score: 0 -> 0/2, 1 -> 2/2, 2 -> 0/2, 3 -> 2/2. PAV pools 1 and 2 (1 > 0).
    const points: IsotonicPoint[] = [
      { score: 0, positive: false },
      { score: 0, positive: false },
      { score: 1, positive: true },
      { score: 1, positive: true },
      { score: 2, positive: false },
      { score: 2, positive: false },
      { score: 3, positive: true },
      { score: 3, positive: true }
    ];
    expect(fitIsotonic(points, { minBlock: 2 })).toEqual([
      { fromScore: 0, probability: 1 / 4 },
      { fromScore: 1, probability: 3 / 6 },
      { fromScore: 3, probability: 3 / 4 }
    ]);
    // With blocks of at least four labels, [0] joins [1, 2] and the short tail [3] joins that block.
    expect(fitIsotonic(points, { minBlock: 4 })).toEqual([{ fromScore: 0, probability: 5 / 10 }]);
    // A weight counts as that many labels (weights are normalized to a mean of 1).
    expect(
      fitIsotonic(
        [
          { score: 0, positive: false, weight: 3 },
          { score: 1, positive: true, weight: 1 }
        ],
        { minBlock: 1 }
      )
    ).toEqual([
      { fromScore: 0, probability: (0 + 1) / (1.5 + 2) },
      { fromScore: 1, probability: (0.5 + 1) / (0.5 + 2) }
    ]);
  });

  it("groups tied scores into one block and never decreases", () => {
    const random = rng(20261018);
    const points: IsotonicPoint[] = Array.from({ length: 400 }, () => {
      const score = Math.round(random() * 40) / 4 - 3; // many ties, bf16-like steps
      return { score, positive: random() < 1 / (1 + Math.exp(-(score - 3))) };
    });
    const blocks = fitIsotonic(points);
    const starts = blocks.map((block) => block.fromScore);
    expect(new Set(starts).size).toBe(starts.length);
    for (let index = 1; index < blocks.length; index++) {
      expect(blocks[index]!.fromScore).toBeGreaterThan(blocks[index - 1]!.fromScore);
      expect(blocks[index]!.probability).toBeGreaterThanOrEqual(blocks[index - 1]!.probability);
    }
    // Every block holds at least 15 labels.
    const counts = blocks.map(
      (block, index) =>
        points.filter(
          (point) =>
            point.score >= block.fromScore &&
            (index + 1 === blocks.length || point.score < blocks[index + 1]!.fromScore)
        ).length
    );
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(15);
    // Smoothing keeps every probability strictly inside (0, 1).
    expect(blocks.every((block) => block.probability > 0 && block.probability < 1)).toBe(true);
  });

  it("recovers a known calibration from a stratified sample that an unweighted fit misses", () => {
    // Population: 900 pairs from a low stratum (10% related) and 100 from a high one (90% related),
    // stratified by another decider's score; the score being fitted says nothing about either, so
    // the true calibration is flat at the population's related share, 0.18.
    const population = { low: 900, high: 100 };
    const random = rng(7);
    const sample: Array<IsotonicPoint & { stratum: string }> = [];
    for (const [stratum, rate] of [
      ["low", 0.1],
      ["high", 0.9]
    ] as const)
      for (let index = 0; index < 50; index++)
        sample.push({ stratum, score: random() * 10, positive: index < rate * 50 });
    const weights = stratumWeights(
      population,
      sample.map((point) => point.stratum)
    );
    expect(weights).toEqual(
      new Map([
        ["low", 18],
        ["high", 2]
      ])
    );
    const weighted = fitIsotonic(
      sample.map((point) => ({ ...point, weight: weights.get(point.stratum)! })),
      { minBlock: 100 }
    );
    const unweighted = fitIsotonic(sample, { minBlock: 100 });
    expect(weighted).toHaveLength(1);
    expect(weighted[0]!.probability).toBeCloseTo((18 + 1) / (100 + 2), 6);
    expect(Math.abs(weighted[0]!.probability - 0.18)).toBeLessThan(0.01);
    expect(Math.abs(unweighted[0]!.probability - 0.18)).toBeGreaterThan(0.3);
  });
});

describe("bands", () => {
  const pass = 3.3125;
  it("only suggests for an uncalibrated decider, whatever its score", () => {
    expect(bandScore(9, null, pass)).toEqual({
      band: "suggest",
      probability: null,
      calibration: "uncalibrated"
    });
    expect(bandScore(3, null, pass).band).toBeNull();
  });

  it("applies a provisional threshold on the raw score with no probability", () => {
    const entry = RelationCalibrationEntrySchema.parse({
      kind: "threshold",
      identity,
      applyAt: 3.3125,
      suggestAt: null,
      basis: "Spike A"
    });
    expect(bandScore(3.3125, entry, pass)).toEqual({
      band: "apply",
      probability: null,
      calibration: "provisional"
    });
    expect(bandScore(3.31, entry, pass).band).toBeNull();
    expect(bandThresholds(entry)).toEqual({ apply: 3.3125, suggest: null });
  });

  it("bands a frozen calibration by its score edges and reports the map's probability", () => {
    const entry = isotonic(
      [
        [0, 0.05],
        [2, 0.6],
        [3, 0.85],
        [4, 0.97]
      ],
      4,
      3
    );
    expect(bandScore(4.2, entry, pass)).toEqual({
      band: "apply",
      probability: 0.97,
      calibration: "frozen"
    });
    expect(bandScore(3.1, entry, pass).band).toBe("suggest");
    expect(bandScore(2.5, entry, pass).band).toBeNull();
    expect(bandThresholds(entry)).toEqual({ apply: 4, suggest: 3 });
    // Plan decision 29: no apply band, a suggest edge inside a block (chosen on the tuning partition).
    const suggestOnly = isotonic(
      [
        [0, 0.05],
        [2, 0.6],
        [4, 0.97]
      ],
      null,
      2.5
    );
    expect(bandScore(2.4, suggestOnly, pass)).toEqual({
      band: null,
      probability: 0.6,
      calibration: "frozen"
    });
    expect(bandScore(2.5, suggestOnly, pass).band).toBe("suggest");
    expect(bandScore(9, suggestOnly, pass)).toEqual({
      band: "suggest",
      probability: 0.97,
      calibration: "frozen"
    });
    expect(bandThresholds(suggestOnly)).toEqual({ apply: null, suggest: 2.5 });
  });

  it("refuses blocks that decrease and a suggest band above apply", () => {
    expect(() =>
      isotonic(
        [
          [0, 0.5],
          [1, 0.4]
        ],
        null,
        1
      )
    ).toThrow();
    expect(() => isotonic([[0, 0.5]], 1, 2)).toThrow();
  });
});

describe("weighted precision", () => {
  it("matches a synthetic population with known truth", () => {
    // Two strata of a population: 1,000 pairs at 98% precision and 4,000 at 70%: 75.6% overall.
    const random = rng(11);
    const labels: Array<{ positive: boolean; stratum: string }> = [];
    for (let index = 0; index < 200; index++)
      labels.push({ stratum: "a", positive: random() < 0.98 });
    for (let index = 0; index < 200; index++)
      labels.push({ stratum: "b", positive: random() < 0.7 });
    const weights = stratumWeights(
      { a: 1_000, b: 4_000 },
      labels.map((label) => label.stratum)
    );
    const result = weightedPrecision(
      labels.map((label) => ({ positive: label.positive, weight: weights.get(label.stratum)! }))
    )!;
    expect(Math.abs(result.precision - 0.756)).toBeLessThan(0.04);
    // Unequal weights shrink the effective sample below the 400 labels.
    expect(result.effectiveCount).toBeLessThan(400);
    expect(result.wilsonLower).toBeLessThan(result.precision);
    expect(weightedPrecision([])).toBeNull();
  });

  it("has the textbook Wilson bound", () => {
    expect(wilsonLowerBound(0.5, 100)).toBeCloseTo(0.4038, 3);
    expect(wilsonLowerBound(1, 20)).toBeCloseTo(0.8389, 3);
    expect(wilsonLowerBound(0.9, 0)).toBe(0);
  });
});

describe("the pre-registered band selection", () => {
  const points = (
    rows: Array<[probability: number, positives: number, negatives: number]>
  ): Array<{ probability: number; positive: boolean }> =>
    rows.flatMap(([probability, positives, negatives]) => [
      ...Array.from({ length: positives }, () => ({ probability, positive: true })),
      ...Array.from({ length: negatives }, () => ({ probability, positive: false }))
    ]);

  it("takes the smallest probabilities that meet the precision bars", () => {
    const labels = points([
      [0.2, 2, 18],
      [0.6, 14, 6],
      [0.85, 18, 2],
      [0.97, 60, 0]
    ]);
    // At 0.85: 78/80 = 0.975 with a Wilson bound of 0.91; at 0.6: 92/100 = 0.92.
    expect(selectBands({ points: labels, forbidden: [] })).toEqual({ pApply: 0.85, pSuggest: 0.6 });
  });

  it("never leaves a forbidden tuning root pair inside a band", () => {
    const labels = points([
      [0.6, 14, 6],
      [0.85, 18, 2],
      [0.97, 60, 0]
    ]);
    expect(selectBands({ points: labels, forbidden: [0.86] })).toEqual({
      pApply: 0.97,
      pSuggest: null
    });
  });

  it("drops a suggest band that would not start below apply", () => {
    expect(selectBands({ points: points([[0.97, 60, 0]]), forbidden: [] })).toEqual({
      pApply: 0.97,
      pSuggest: null
    });
  });
});

describe("reconcile", () => {
  const entry = isotonic(
    [
      [0, 0.05],
      [3, 0.85],
      [4, 0.97]
    ],
    4,
    3
  );
  it("keeps an applied relation inside the hysteresis and moves it beyond", () => {
    const transitions = reconcileBands({
      rows: [
        { id: "kept", score: 3.6, band: "apply" },
        { id: "demoted", score: 3.4, band: "apply" },
        { id: "promoted", score: 4.1, band: "suggest" },
        { id: "withdrawn", score: 1, band: "suggest" },
        { id: "dropped", score: 1, band: "apply" },
        { id: "same", score: 3.2, band: "suggest" }
      ],
      entry,
      uncalibratedPass: 3.3125,
      hysteresis: 0.5
    });
    expect(transitions).toEqual([
      { id: "demoted", from: "apply", to: "suggest", probability: 0.85 },
      { id: "promoted", from: "suggest", to: "apply", probability: 0.97 },
      { id: "withdrawn", from: "suggest", to: null, probability: 0.05 },
      { id: "dropped", from: "apply", to: null, probability: 0.05 }
    ]);
  });

  it("demotes every applied relation of a decider that becomes uncalibrated", () => {
    expect(
      reconcileBands({
        rows: [{ id: "a", score: 9, band: "apply" }],
        entry: null,
        uncalibratedPass: 3.3125,
        hysteresis: 0.5
      })
    ).toEqual([{ id: "a", from: "apply", to: "suggest", probability: null }]);
  });
});

describe("calibration identity", () => {
  it("keys equal identities equally, whatever their key order, and tells fields apart", () => {
    const reordered = Object.fromEntries(
      Object.entries(identity).reverse()
    ) as RelationCalibrationIdentity;
    expect(relationCalibrationIdentityKey(reordered)).toBe(
      relationCalibrationIdentityKey(identity)
    );
    expect(relationCalibrationIdentityKey({ ...identity, rule: "mean" })).not.toBe(
      relationCalibrationIdentityKey(identity)
    );
  });

  // Plan decision 30: a remote decider is named by its model and its request design, with no build.
  const remote: RelationCalibrationIdentity = {
    contract: "relation-decide-decisions-v1",
    instructionSha256: hash("a"),
    template: "relation-pair-text-v1",
    bodyCharacters: 600,
    rule: "mean",
    provider: "openai",
    model: "gpt-6-luna",
    runtimeKind: "remote",
    requestDesignSha256: hash("f")
  };
  const remoteEntry = (parity: unknown) =>
    RelationCalibrationEntrySchema.safeParse({
      kind: "isotonic",
      identity: remote,
      blocks: [{ fromScore: 0, probability: 0.5 }],
      applyFrom: 2,
      suggestFrom: 1,
      basis: "test",
      labelSetHash: hash("c"),
      freezeHash: hash("d"),
      fittedAt: "2026-10-20T10:00:00.000Z",
      parity
    });

  it("keys a remote decider by its request design and holds its parity to that fingerprint", () => {
    expect(relationCalibrationIdentityKey(remote)).not.toBe(
      relationCalibrationIdentityKey({ ...remote, requestDesignSha256: hash("e") })
    );
    expect(relationCalibrationIdentityKey(remote)).not.toBe(
      relationCalibrationIdentityKey(identity)
    );
    expect(remoteEntry({ requestDesignSha256: hash("f") }).success).toBe(true);
    // Another fingerprint, or a local ranker's reference scores, is not a remote decider's parity.
    expect(remoteEntry({ requestDesignSha256: hash("e") }).success).toBe(false);
    expect(remoteEntry({ referenceHash: hash("e"), scores: [1] }).success).toBe(false);
    // A local ranker keeps its reference scores; a remote decider has no threshold rule.
    expect(
      RelationCalibrationEntrySchema.safeParse({
        ...isotonic([[0, 0.5]], 2, 1),
        parity: { requestDesignSha256: hash("f") }
      }).success
    ).toBe(false);
    expect(
      RelationCalibrationEntrySchema.safeParse({
        kind: "threshold",
        identity: remote,
        applyAt: 2,
        suggestAt: null,
        basis: "test"
      }).success
    ).toBe(false);
    // A remote identity with a local ranker's fields is refused (each shape is strict).
    expect(
      RelationCalibrationEntrySchema.safeParse({
        ...remoteEntry({ requestDesignSha256: hash("f") }).data,
        identity: { ...remote, artifactSha256: hash("b") }
      }).success
    ).toBe(false);
  });
});
