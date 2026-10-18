import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  calibrate,
  fitIsotonic,
  relationCalibrationIdentityKey,
  RelationCalibrationEntrySchema
} from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frozenFileEnvironmentVariable, readHeldOutAccess } from "../golden/freeze-guard.ts";
import { notePairKey } from "../golden/relations-export.ts";
import { seededRandom } from "../spikes/reranker/metrics.ts";
import {
  acceptedPairs,
  areaUnderCurve,
  assignFolds,
  bandBars,
  brierScore,
  buildFreezeRecord,
  buildWeighting,
  cellWeights,
  canonicalJson,
  chooseBands,
  crossValidatedProbabilities,
  decideThreshold,
  evaluateEscalation,
  expectedAtZeroForbidden,
  expectedCalibrationError,
  frozenCalibration,
  logLoss,
  parityVerdict,
  poolLabels,
  reverseOnlyLossR6,
  reverseOnlyLossR9,
  renderGateF,
  rootLevel,
  runBakeoffCli,
  runGateF,
  runSelect,
  scoreAtLevel,
  selectConfiguration,
  sha256Hex,
  topupBandOf,
  typerCheckPairs,
  typerReportSchema,
  weightedPoolLabels,
  weightedRecall,
  writeFreeze,
  type Calibration,
  type DirectedScores,
  type LabelItem,
  type ParityFile,
  type Proposal,
  type RetrievalExport,
  type SelectInputs,
  type Weighting
} from "./bakeoff.ts";

const scoresOf = (rows: Array<[string, string, number]>): DirectedScores =>
  new Map(rows.map(([query, doc, value]) => [`${query}>${doc}`, value]));

describe("the evaluation arithmetic", () => {
  it("computes the AUC with ties at one half, and the weighted AUC as duplicated labels", () => {
    const points = [
      { score: 1, positive: false },
      { score: 2, positive: true },
      { score: 2, positive: false },
      { score: 3, positive: true }
    ];
    // Positive 2 beats 1 and ties 2 (1.5 of 2); positive 3 beats both (2 of 2): 3.5 of 4.
    expect(areaUnderCurve(points)).toBeCloseTo(3.5 / 4, 12);
    const weighted = [...points.slice(0, 3), { score: 3, positive: true, weight: 2 }];
    const duplicated = [...points, { score: 3, positive: true }];
    expect(areaUnderCurve(weighted, true)).toBeCloseTo(areaUnderCurve(duplicated)!, 12);
    expect(areaUnderCurve([{ score: 1, positive: true }])).toBeNull();
  });

  it("computes log-loss, Brier, recall and the weighted ECE on known values", () => {
    const points = [
      { probability: 0.8, positive: true, weight: 1 },
      { probability: 0.8, positive: false, weight: 3 },
      { probability: 0.1, positive: false, weight: 1 }
    ];
    expect(logLoss(points, false)).toBeCloseTo(
      -(Math.log(0.8) + Math.log(0.2) + Math.log(0.9)) / 3,
      12
    );
    expect(logLoss(points, true)).toBeCloseTo(
      -(Math.log(0.8) + 3 * Math.log(0.2) + Math.log(0.9)) / 5,
      12
    );
    expect(brierScore(points)).toBeCloseTo((0.04 + 3 * 0.64 + 0.01) / 5, 12);
    expect(weightedRecall(points, 0.5)).toBe(1);
    expect(weightedRecall(points, 0.9)).toBe(0);
    const { ece, bins } = expectedCalibrationError(points);
    // Bin [0.8, 0.9): weight 4, mean P 0.8, positive share 0.25; bin [0.1, 0.2): weight 1, 0.1 and 0.
    expect(ece).toBeCloseTo((4 / 5) * 0.55 + (1 / 5) * 0.1, 12);
    expect(bins[8]).toMatchObject({ labels: 2, weight: 4, positiveShare: 0.25 });
    expect(bins.filter((bin) => bin.labels > 0)).toHaveLength(2);
  });

  it("assigns whole groups to folds, deterministically and balanced over the cells", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      group: `g${index % 60}`,
      cell: `${["A", "B", "C"][index % 3]}:${index % 5}`
    }));
    const folds = assignFolds(items);
    expect(assignFolds(items)).toEqual(folds);
    expect(new Set(folds.values())).toEqual(new Set([0, 1, 2, 3, 4]));
    const sizes = [0, 0, 0, 0, 0];
    for (const item of items) sizes[folds.get(item.group)!]!++;
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(8);
    expect(assignFolds(items, { seed: 1 })).not.toEqual(folds);
  });

  it("calibrates every point with a fit that never saw its fold", () => {
    // Fold 0 holds positives at low scores that the other folds contradict.
    const points = [
      ...Array.from({ length: 20 }, () => ({ score: 1, positive: true, fold: 0 })),
      ...Array.from({ length: 40 }, (_, index) => ({
        score: 1,
        positive: false,
        fold: 1 + (index % 4)
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        score: 9,
        positive: true,
        fold: 1 + (index % 4)
      }))
    ];
    const oof = crossValidatedProbabilities(points);
    // Fold 0's points get the other folds' low block: 0 positives of 40, smoothed to 1/42.
    expect(oof[0]).toBeCloseTo(1 / 42, 12);
    expect(oof[25]).toBeLessThan(0.5);
    expect(oof[80]).toBeGreaterThan(0.5);
  });
});

describe("weighted PAV on a stratified sample (R18)", () => {
  it("recovers a known calibration that the unweighted fit misses", () => {
    // Population: s is the score being calibrated, with P(related | s) = 0.05, 0.3, 0.8 on three
    // ranges. The sample is stratified by another decider's score that favours related pairs, so
    // related pairs are over-sampled at every s; the population weights undo it.
    const random = seededRandom(20261022);
    const truth = (score: number) => (score < 4 ? 0.05 : score < 7 ? 0.3 : 0.8);
    const population = Array.from({ length: 20_000 }, () => {
      const score = random() * 10;
      const positive = random() < truth(score);
      const stratum = random() < (positive ? 0.3 : 0.005) ? 4 : 0;
      return { score, positive, stratum };
    });
    const byStratum = [0, 4].map((stratum) => population.filter((row) => row.stratum === stratum));
    const sampled = byStratum.flatMap((rows) => rows.slice(0, 200));
    const counts = { 0: byStratum[0]!.length, 4: byStratum[1]!.length };
    const fixture = {
      items: sampled.map((row, index): LabelItem => ({
        pairId: `p${index}`,
        kind: "note",
        library: "fixture",
        lo: `a${index}`,
        hi: `b${index}`,
        group: `g${index}`,
        sets: ["pool-A"],
        pool: "A",
        stratum: row.stratum,
        split: "fit",
        related: row.positive
      }))
    };
    const weight = (stratum: 0 | 4) => counts[stratum] / 200;
    const weights = {
      pools: {
        A: { weight: [weight(0), 1, 1, 1, weight(4)] },
        B: { weight: [1, 1, 1, 1, 1] },
        C: { weight: [1, 1, 1, 1, 1] }
      }
    };
    const labels = poolLabels(fixture, weights, "fit");
    expect(labels).toHaveLength(400);
    const points = labels.map((label, index) => ({ ...label, score: sampled[index]!.score }));
    const weighted = fitIsotonic(points);
    const unweighted = fitIsotonic(
      points.map((point) => ({ score: point.score, positive: point.positive }))
    );
    const error = (blocks: ReturnType<typeof fitIsotonic>) =>
      [2, 5.5, 8.5].reduce(
        (total, score) => total + Math.abs(calibrate(score, blocks) - truth(score)),
        0
      ) / 3;
    expect(error(weighted)).toBeLessThan(0.06);
    expect(error(unweighted)).toBeGreaterThan(0.1);
    expect(error(unweighted)).toBeGreaterThan(3 * error(weighted));
  });
});

// --- A small world for the rule ------------------------------------------------------------------

/** Fit labels in pools A-C whose relatedness the `good` instruction separates and `bad` does not. */
function labelWorld() {
  const items: LabelItem[] = [];
  const random = seededRandom(5);
  let n = 0;
  for (const pool of ["A", "B", "C"])
    for (let index = 0; index < 60; index++) {
      const positive = index % 2 === 0;
      const stratum = index % 5;
      items.push({
        pairId: `note:${pool}:${n}`,
        kind: "note",
        library: "fixture",
        lo: `lo${n}`,
        hi: `hi${n}`,
        group: `${pool}:g${Math.floor(index / 3)}`,
        sets: [`pool-${pool}`],
        pool,
        stratum,
        split: index % 10 < 6 ? "fit" : "eval",
        related: positive
      });
      n++;
    }
  const scores = (separation: number, body: number) => {
    const rows: Array<[string, string, number]> = [];
    items.forEach((item, index) => {
      const base =
        (item.related ? separation : -separation) +
        (random() - 0.5) * 12 +
        (body === 600 ? 0.2 : 0);
      rows.push(
        [item.lo, item.hi, base + (index % 3) - 1],
        [item.hi, item.lo, base - (index % 3) + 1]
      );
    });
    return scoresOf(rows);
  };
  return { items, scores };
}

describe("the selection rule", () => {
  const world = labelWorld();
  const weights = {
    pools: {
      A: { weight: [2, 2, 2, 2, 2] },
      B: { weight: [5, 5, 5, 5, 5] },
      C: { weight: [9, 9, 9, 9, 9] }
    }
  };
  const labels = poolLabels({ items: world.items }, weights, "fit");
  const folds = assignFolds(
    labels.map((label) => ({ group: label.group, cell: `${label.pool}:${label.stratum}` }))
  );
  const table = new Map<string, DirectedScores>([
    ["good:400", world.scores(3, 400)],
    ["good:600", world.scores(4, 600)],
    ["bad:400", world.scores(0.3, 400)],
    ["bad:600", world.scores(0.3, 600)]
  ]);

  it("weights each label by its pool and stratum and reads one split", () => {
    expect(labels.every((label) => label.weight === { A: 2, B: 5, C: 9 }[label.pool])).toBe(true);
    expect(
      poolLabels({ items: world.items }, weights, "eval").some((label) => labels.includes(label))
    ).toBe(false);
  });

  it("picks the instruction, then the template, then the rule, step by step", () => {
    const selection = selectConfiguration({
      labels,
      scores: (instructionId, body) => table.get(`${instructionId}:${body}`)!,
      instructionIds: ["bad", "good"],
      bodies: [400, 600],
      folds
    });
    expect(selection.instruction.chosen).toBe("good");
    expect(selection.instruction.at).toEqual({ bodyCharacters: 400, rule: "max" });
    expect(selection.template.chosen).toBe(600);
    expect(selection.rule.rows.map((row) => row.rule)).toEqual(["max", "mean"]);
    const [max, mean] = selection.rule.rows;
    expect(selection.rule.chosen).toBe(mean!.cvLogLoss < max!.cvLogLoss ? "mean" : "max");
    expect(selection.readings.stepwiseUnweighted).toEqual({
      instructionId: "good",
      bodyCharacters: 600,
      rule: selection.rule.chosen
    });
  });

  it("breaks an AUC tie by the caller's tie-break and refuses to guess without one", () => {
    const tied = (instructionId: string, body: number) =>
      table.get(`good:${body}`)! ?? table.get(`${instructionId}:${body}`)!;
    const input = { labels, scores: tied, instructionIds: ["one", "two"], bodies: [400], folds };
    expect(() => selectConfiguration(input)).toThrow("The instruction AUC ties (one, two)");
    expect(selectConfiguration(input, (candidates) => candidates[1]!).instruction.chosen).toBe(
      "two"
    );
  });
});

describe("the bands of D18", () => {
  const blocks = [
    { fromScore: -5, probability: 0.05 },
    { fromScore: 1, probability: 0.5 },
    { fromScore: 3, probability: 0.85 },
    { fromScore: 5, probability: 0.97 }
  ];
  const oof = [
    ...Array.from({ length: 40 }, (_, index) => ({
      probability: 0.97,
      positive: index < 39,
      weight: 1
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      probability: 0.85,
      positive: index < 34,
      weight: 1
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      probability: 0.5,
      positive: index < 20,
      weight: 1
    })),
    ...Array.from({ length: 40 }, () => ({ probability: 0.05, positive: false, weight: 1 }))
  ];

  it("finds p_apply and p_suggest on the cross-validated levels and maps them to scores", () => {
    const bands = chooseBands({ oof, blocks, forbiddenBestScores: [-1] });
    expect(bands.pApply).toBe(0.97);
    expect(bands.pSuggest).toBe(0.85);
    expect(bands.acceptLevel).toBe(0.85);
    expect(scoreAtLevel(blocks, bands.pApply)).toBe(5);
    expect(scoreAtLevel(blocks, bands.pSuggest)).toBe(3);
    expect(bands.suggest).toMatchObject({ precision: 73 / 80, recall: 73 / 93, labels: 80 });
    expect(bands.apply!.wilsonLower).toBeGreaterThanOrEqual(bandBars.applyWilsonLower);
  });

  it("moves a band above every forbidden tuning root pair", () => {
    const bands = chooseBands({ oof, blocks, forbiddenBestScores: [3.5] });
    expect(bands.forbiddenProbabilities).toEqual([0.85]);
    expect(bands.pSuggest).toBeNull();
    expect(bands.pApply).toBe(0.97);
  });

  it("has no apply band when no level meets both apply bars", () => {
    // 34 of the top 40 related: 0.85 at the top level, under the 0.95 bar.
    const weak = oof.map((point, index) =>
      point.probability === 0.97 ? { ...point, positive: index < 34 } : point
    );
    const bands = chooseBands({ oof: weak, blocks, forbiddenBestScores: [] });
    expect(bands.pApply).toBeNull();
    expect(bands.pSuggest).toBe(0.85);
    expect(scoreAtLevel(blocks, null)).toBeNull();
  });
});

describe("the fixture partition at a calibration", () => {
  // Roots R1, R2, R3, R4 with one note each, plus a second R1 note.
  const data: Pick<RetrievalExport, "notes" | "candidates" | "typings" | "decisions"> = {
    notes: [
      { id: "n1", root: "R1" },
      { id: "n1b", root: "R1" },
      { id: "n2", root: "R2" },
      { id: "n3", root: "R3" },
      { id: "n4", root: "R4" }
    ],
    candidates: [
      { noteId: "n2", candidateId: "n1", contentOrder: 1 },
      { noteId: "n2", candidateId: "n1b", contentOrder: 2 },
      { noteId: "n3", candidateId: "n1", contentOrder: 1 },
      { noteId: "n4", candidateId: "n2", contentOrder: 1 },
      { noteId: "n1b", candidateId: "n1", contentOrder: 1 }
    ],
    decisions: [
      { lo: "n1", hi: "n2", loToHi: 6, hiToLo: 2 },
      { lo: "n1b", hi: "n2", loToHi: 1, hiToLo: 1 },
      { lo: "n1", hi: "n3", loToHi: 4, hiToLo: 4 },
      { lo: "n2", hi: "n4", loToHi: 5, hiToLo: 5 },
      { lo: "n1", hi: "n1b", loToHi: 9, hiToLo: 9 }
    ],
    typings: [
      { pairKey: "n2:n4", relationType: "none" },
      { pairKey: "n1:n2", relationType: "supports" }
    ]
  };
  const scores = scoresOf(
    data.decisions.flatMap((row): Array<[string, string, number]> => [
      [row.lo, row.hi, row.loToHi!],
      [row.hi, row.lo, row.hiToLo!]
    ])
  );
  const calibration: Calibration = {
    blocks: [
      { fromScore: 0, probability: 0.1 },
      { fromScore: 3, probability: 0.82 },
      { fromScore: 5, probability: 0.9 }
    ],
    applyFrom: 5,
    suggestFrom: 3,
    rule: "mean"
  };
  const lists = {
    expected: [
      ["R1", "R2"],
      ["R1", "R3"]
    ] as Array<[string, string]>,
    forbidden: [
      ["R2", "R4"],
      ["R3", "R4"]
    ] as Array<[string, string]>
  };

  it("accepts note pairs in the band, ranked and capped per decided note", () => {
    const pairs = acceptedPairs({ data, scores, calibration });
    expect(pairs.map((pair) => `${pair.lo}:${pair.hi}:${pair.band}:${pair.typing}`).sort()).toEqual(
      ["n1:n1b:apply:untyped", "n1:n2:suggest:typed", "n1:n3:suggest:untyped", "n2:n4:apply:none"]
    );
    expect(acceptedPairs({ data, scores, calibration, maxShownPerNote: 0 })).toEqual([]);
  });

  it("counts root pairs with both typing bounds, applied-only and the typer's vetoes", () => {
    const level = rootLevel({ data, scores, calibration, lists });
    expect(level).toMatchObject({
      expected: 2,
      expectedOf: 2,
      expectedPessimistic: 1,
      expectedApplied: 0,
      forbidden: 0,
      forbiddenOf: 2,
      forbiddenBeforeTyping: 1,
      forbiddenLinkedBeforeTyping: ["R2/R4"]
    });
    expect(level.forbiddenBest).toEqual([
      { pair: "R2/R4", bestScore: 5 },
      { pair: "R3/R4", bestScore: null }
    ]);
    // The rule's tie-break: expected root pairs above every forbidden one's best score (5, R2/R4).
    expect(expectedAtZeroForbidden({ data, scores, lists, rule: "mean" })).toBe(0);
    expect(expectedAtZeroForbidden({ data, scores, lists, rule: "max" })).toBe(1);
    const strict = rootLevel({
      data,
      scores,
      calibration: { ...calibration, suggestFrom: null },
      lists
    });
    expect(strict.expected).toBe(0);
    expect(strict.missed.map((row) => row.pair)).toEqual(["R1/R2", "R1/R3"]);
    expect(strict.missed[0]).toMatchObject({ bestScore: 4, reached: true });
  });
});

describe("the escalation clause", () => {
  // The full map: below 0, [0, 2) and the accept band from 2.
  const blocks = [
    { fromScore: -9, probability: 0.1 },
    { fromScore: 0, probability: 0.4 },
    { fromScore: 2, probability: 0.85 }
  ];
  const points = [
    ...Array.from({ length: 20 }, (_, index) => ({
      score: 3,
      probability: 0.85,
      positive: index < 17,
      weight: 1,
      verdict: 0.9
    })),
    // The uncertain band: the generative verdict accepts the related ones.
    ...Array.from({ length: 20 }, (_, index) => ({
      score: 1,
      probability: 0.4,
      positive: index < 10,
      weight: 1,
      verdict: index < 10 ? 0.9 : 0.2
    })),
    ...Array.from({ length: 20 }, () => ({
      score: -3,
      probability: 0.1,
      positive: false,
      weight: 1,
      verdict: 0.8
    }))
  ];
  const base = { points, acceptLevel: 0.85, precisionBar: 0.8, blocks, pass: 0.65 };

  it("is adopted when the cascade raises recall at the precision bar with no forbidden pair added", () => {
    const result = evaluateEscalation({
      ...base,
      tuning: [
        {
          rootPair: "X/Y",
          kind: "expected",
          score: 1.5,
          probability: 0.4,
          verdict: 0.7,
          found: false
        },
        {
          rootPair: "F/G",
          kind: "forbidden",
          score: 1,
          probability: 0.4,
          verdict: 0.3,
          found: false
        },
        // Below every edge the rule takes: never escalated.
        {
          rootPair: "F/H",
          kind: "forbidden",
          score: -5,
          probability: 0.1,
          verdict: null,
          found: false
        }
      ]
    });
    // Edges looked at, narrowest first: 0, then -Infinity (the lowest block).
    expect(result.candidates.map((candidate) => candidate.lowerScore)).toEqual([
      0,
      Number.NEGATIVE_INFINITY
    ]);
    expect(result.candidates[1]!.forbiddenAdded).toEqual(["F/H"]);
    expect(result.adopted).toBe(true);
    expect(result.lowerScore).toBe(0);
    expect(result.lowerLevel).toBe(0.4);
    expect(result.baseline.recall).toBeCloseTo(17 / 27, 12);
    expect(result.cascade!.recall).toBeCloseTo(27 / 27, 12);
    expect(result.cascade!.precision).toBeCloseTo(27 / 30, 12);
    expect(result.expectedAdded).toEqual(["X/Y"]);
  });

  it("is not adopted when it would add a forbidden tuning root pair or a pair has no verdict", () => {
    const forbidden = evaluateEscalation({
      ...base,
      tuning: [
        {
          rootPair: "F/G",
          kind: "forbidden",
          score: 1,
          probability: 0.4,
          verdict: 0.7,
          found: false
        }
      ]
    });
    expect(forbidden.adopted).toBe(false);
    expect(forbidden.reason).toContain("no uncertain band");
    const unknown = evaluateEscalation({
      ...base,
      tuning: [
        {
          rootPair: "F/G",
          kind: "forbidden",
          score: 1,
          probability: 0.4,
          verdict: null,
          found: false
        }
      ]
    });
    expect(unknown.adopted).toBe(false);
    expect(unknown.candidates[0]!.forbiddenWithoutVerdict).toEqual(["F/G"]);
    expect(evaluateEscalation({ ...base, acceptLevel: null, tuning: [] }).reason).toBe(
      "no accept band to escalate below"
    );
  });

  it("is not adopted when the generative verdicts add no related pair", () => {
    const flat = points.map((point) =>
      point.probability === 0.4 ? { ...point, verdict: 0.1 } : point
    );
    const result = evaluateEscalation({ ...base, points: flat, tuning: [] });
    expect(result.adopted).toBe(false);
    expect(result.reason).toContain("does not raise");
  });
});

describe("the reverse-only losses (X2)", () => {
  const calibration: Calibration = {
    blocks: [
      { fromScore: 0, probability: 0.1 },
      { fromScore: 3, probability: 0.9 }
    ],
    applyFrom: null,
    suggestFrom: 3,
    rule: "max"
  };

  it("loses an R_v6 pair below the accept band and counts the loss over the related ones", () => {
    const item = (n: number, related: boolean | null, sameRoot: boolean): LabelItem => ({
      pairId: `r${n}`,
      kind: "note",
      library: "spike-a",
      lo: `a${n}`,
      hi: `b${n}`,
      group: sameRoot ? "spike-a:L1|L1" : "spike-a:L1|L2",
      sets: ["rv6"],
      pool: null,
      stratum: null,
      split: null,
      related
    });
    const items = [
      item(1, true, true),
      item(2, true, false),
      item(3, false, false),
      item(4, true, false)
    ];
    const scores = scoresOf([
      ["a1", "b1", 5],
      ["b1", "a1", 0],
      ["a2", "b2", 1],
      ["b2", "a2", 1],
      ["a3", "b3", 1],
      ["b3", "a3", 0],
      ["a4", "b4", 4],
      ["b4", "a4", 4]
    ]);
    const loss = reverseOnlyLossR6({ items, scores, calibration });
    expect(loss).toMatchObject({
      pairs: 4,
      lost: 2,
      related: 3,
      lostRelated: 1,
      sameRoot: { pairs: 1, lost: 0 }
    });
    expect(loss.loss).toBeCloseTo(1 / 3, 12);
    expect(loss.literalLoss).toBe(0.5);
  });

  it("estimates R_v9's denominator from the sample with a Wilson interval, exact numerator", () => {
    const pairs = Array.from({ length: 10 }, (_, index) => ({
      lo: `x${index}`,
      hi: `y${index}`,
      sameRoot: index === 0
    }));
    const accepted = new Set(pairs.slice(2).map((pair) => `${pair.lo}:${pair.hi}`));
    const sample = Array.from({ length: 4 }, (_, index) => ({
      lo: `s${index}`,
      hi: `t${index}`,
      related: index < 3
    }));
    const pending = reverseOnlyLossR9({ pairs, accepted, sample, labels: new Map() });
    expect(pending).toMatchObject({
      lost: 2,
      loss: null,
      unlabelledLost: 2,
      sameRoot: { pairs: 1, lost: 1 }
    });
    const lostLabels = new Map([
      ["x0:y0", true],
      ["x1:y1", false]
    ]);
    const labelled = reverseOnlyLossR9({ pairs, accepted, sample, labels: lostLabels });
    // 1 lost related over 1 + 8 kept x 0.75.
    expect(labelled.loss).toBeCloseTo(1 / 7, 12);
    expect(labelled.related).toBeCloseTo(7, 12);
    expect(labelled.interval![0]).toBeLessThan(labelled.loss!);
    expect(labelled.interval![1]).toBeGreaterThan(labelled.loss!);
    expect(labelled.lostPairs).toEqual([
      ["x0", "y0"],
      ["x1", "y1"]
    ]);
    expect(labelled.keptUnlabelledPairs).toHaveLength(8);
  });

  it("gates on the exact R_v9 figure once every kept pair is labelled too", () => {
    const pairs = Array.from({ length: 4 }, (_, index) => ({
      lo: `x${index}`,
      hi: `y${index}`,
      sameRoot: false
    }));
    const accepted = new Set(["x2:y2", "x3:y3"]);
    const labels = new Map([
      ["x0:y0", true],
      ["x1:y1", true],
      ["x2:y2", true],
      ["x3:y3", false]
    ]);
    const exact = reverseOnlyLossR9({ pairs, accepted, sample: [], labels });
    expect(exact).toMatchObject({
      lostRelated: 2,
      related: 3,
      interval: null,
      keptUnlabelledPairs: []
    });
    expect(exact.loss).toBeCloseTo(2 / 3, 12);
  });
});

describe("the typer check pairs (G25)", () => {
  it("draws panel-positive directed pairs and names the subject by the panel's direction", () => {
    const item = (
      n: number,
      type: string | null,
      direction: string | null,
      related = true
    ): LabelItem => ({
      pairId: `note:p${n}`,
      kind: "note",
      library: "fixture",
      lo: `a${n}`,
      hi: `b${n}`,
      group: `g${n}`,
      sets: ["pool-A"],
      pool: "A",
      stratum: 2,
      split: "fit",
      related,
      type,
      direction
    });
    const items = [
      item(1, "supports", "lo_to_hi"),
      item(2, "extends", "hi_to_lo"),
      item(3, "same_as", "symmetric"),
      item(4, "supports", "lo_to_hi", false),
      item(5, "clarifies", null)
    ];
    const pairs = typerCheckPairs({ items, text: (id) => `text ${id}`, count: 60 });
    expect(pairs.map((pair) => [pair.a, pair.subject]).sort()).toEqual([
      ["text a1", "a"],
      ["text a2", "b"]
    ]);
    // R_v9 pairs are evaluation-only (spec 5.2): the check never draws one.
    const withoutRv9 = typerCheckPairs({
      items,
      text: (id) => `text ${id}`,
      count: 60,
      excluded: new Set([notePairKey("a2", "b2")])
    });
    expect(withoutRv9.map((pair) => pair.a)).toEqual(["text a1"]);
  });
});

// --- The freeze and its guard --------------------------------------------------------------------

describe("the parity verdict (R1)", () => {
  const entry = {
    runtimeBuild: "build-new",
    reference: { referenceHash: "a".repeat(64), maxAbsDelta: 0.0625 },
    m1Pairs: { pairs: 500, maxAbsDelta: 0.125 },
    source: "t61"
  };
  it("passes within 0.125 log-odds on the reference and 500 stored M1 pairs", () => {
    expect(parityVerdict(entry, "build-old").ok).toBe(true);
    expect(
      parityVerdict({ ...entry, m1Pairs: { pairs: 500, maxAbsDelta: 0.1875 } }, "build-old").ok
    ).toBe(false);
    expect(
      parityVerdict({ ...entry, m1Pairs: { pairs: 499, maxAbsDelta: 0 } }, "build-old").ok
    ).toBe(false);
    expect(
      parityVerdict({ ...entry, reference: { ...entry.reference, maxAbsDelta: 0.25 } }, "build-old")
        .ok
    ).toBe(false);
    expect(parityVerdict(undefined, "build-old").ok).toBe(false);
  });
  it("needs no parity when the scores come from the checked build itself", () => {
    expect(
      parityVerdict(
        { ...entry, m1Pairs: null, reference: { ...entry.reference, maxAbsDelta: 9 } },
        "build-new"
      ).ok
    ).toBe(true);
  });
});

/** A weighting with one weight per pool and stratum (T57's shape) and nothing kept out. */
function testWeighting(
  items: readonly LabelItem[],
  weights: Record<string, { weight: number[] }>,
  excluded: ReadonlySet<string> = new Set()
): Weighting {
  const weightOf = new Map<string, number>();
  for (const item of items)
    if (item.pool && item.stratum !== null)
      weightOf.set(item.pairId, weights[item.pool]!.weight[item.stratum]!);
  return {
    scheme: { A: "stratum", B: "stratum", C: "stratum" },
    weightOf,
    excluded,
    excludedLabels: 0,
    excludedPopulation: 0,
    cells: [],
    unrepresented: [],
    hashes: { weighting: "test" }
  };
}

/** A selection world on disk-free inputs: labels, weights, scores, an M1-like export, the mapping. */
function selectInputs(options: { withTuningScores: boolean }): SelectInputs {
  const world = labelWorld();
  const weights = {
    strata: ["<0", "a", "b", "c", ">=5"],
    pools: {
      A: { weight: [3, 1, 1, 1, 1] },
      B: { weight: [3, 2, 2, 2, 2] },
      C: { weight: [3, 3, 3, 3, 3] }
    }
  };
  const tuning: RetrievalExport = {
    format: "memora-f3-retrieval-export",
    label: "m1",
    notes: [
      { id: "t1", root: "P01" },
      { id: "t2", root: "P02" },
      { id: "t3", root: "P03" }
    ],
    candidates: [
      { noteId: "t2", candidateId: "t1", contentOrder: 1 },
      { noteId: "t3", candidateId: "t1", contentOrder: 1 },
      { noteId: "t3", candidateId: "t2", contentOrder: 2 }
    ],
    decisions: [
      { lo: "t1", hi: "t2", loToHi: 6, hiToLo: 6 },
      { lo: "t1", hi: "t3", loToHi: -6, hiToLo: -6 },
      { lo: "t2", hi: "t3", loToHi: -1, hiToLo: -1 }
    ],
    typings: []
  };
  const mapping = {
    expectedRootPairs: [
      { pair: ["P01", "P02"] as [string, string], partition: "tuning" as const, rationale: "" },
      { pair: ["H01", "H02"] as [string, string], partition: "holdout" as const, rationale: "" }
    ],
    forbiddenRootPairs: [
      { pair: ["P01", "P03"] as [string, string], partition: "tuning" as const, rationale: "" },
      { pair: ["H01", "H03"] as [string, string], partition: "holdout" as const, rationale: "" }
    ]
  };
  const instructions = { mechanism: 3, relation: 1, study: 0.5, default: 0.2 } as Record<
    string,
    number
  >;
  const scoreFile = (runtime: string, instructionId: string, body: number) => ({
    scores: world.scores(instructions[instructionId]! + (runtime === "gguf" ? -0.2 : 0), body),
    facts: {
      path: `/x/labels-${runtime}-${instructionId}-t${body}.json`,
      sha256: sha256Hex(`${runtime}${instructionId}${body}`),
      decider: "test",
      runtimeBuild: `${runtime}-build`,
      instructionSha256: sha256Hex(instructionId),
      instruction: `instruction ${instructionId}`
    }
  });
  const tuningScores = scoresOf(
    tuning.decisions.flatMap((row): Array<[string, string, number]> => [
      [row.lo, row.hi, row.loToHi!],
      [row.hi, row.lo, row.hiToLo!]
    ])
  );
  return {
    labels: {
      path: "/x/labels.json",
      sha256: "1".repeat(64),
      value: {
        format: "memora-f3-relation-labels",
        version: 1,
        labelSetSha256: "2".repeat(64),
        items: world.items
      }
    },
    weighting: testWeighting(world.items, weights.pools),
    tuningExport: { path: "/x/m1.json", sha256: "4".repeat(64), value: tuning },
    mapping: { path: "/x/mapping.json", sha256: "5".repeat(64), value: mapping as never },
    v9: {
      path: "/x/v9.json",
      sha256: "6".repeat(64),
      value: {
        format: "memora-relations-v9-verdicts",
        verdicts: [{ lo: "t1", hi: "h9", score: 0.9 }]
      }
    },
    labelScore: async (runtime, instructionId, body) => scoreFile(runtime, instructionId, body),
    tuningScore: async (runtime, instructionId, body) =>
      options.withTuningScores
        ? {
            scores: tuningScores,
            facts: {
              ...scoreFile(runtime, instructionId, body).facts,
              path: `/x/tuning-${runtime}-${body}.json`
            }
          }
        : null,
    now: () => new Date("2026-10-18T12:00:00.000Z")
  };
}

describe("select", () => {
  it("reads the fit split and the tuning partition only", async () => {
    const proposal = await runSelect(selectInputs({ withTuningScores: true }));
    expect(proposal.choice.instructionId).toBe("mechanism");
    const text = JSON.stringify(proposal);
    // No held-out root and no pair outside the tuning notes reaches the proposal.
    expect(text).not.toMatch(/H0[123]|h9/u);
    const mlx = proposal.deciders.find((decider) => decider.runtime === "mlx")!;
    expect(mlx.fitLabels.labels).toBe(108);
    expect(mlx.tuning).toMatchObject({ expectedOf: 1, forbiddenOf: 1 });
    expect(mlx.identity).toMatchObject({
      runtimeKind: "mlx",
      instructionSha256: sha256Hex("mechanism")
    });
    expect(proposal.sealed.length).toBe(4);
  });

  it("leaves the forbidden check pending without tuning scores at the chosen configuration", async () => {
    const proposal = await runSelect(selectInputs({ withTuningScores: false }));
    const gguf = proposal.deciders.find((decider) => decider.runtime === "gguf")!;
    expect(gguf.tuning).toBeNull();
    expect(gguf.escalation).toBeNull();
    expect(gguf.tuningNote).toContain("pending");
    // MLX at the provisional configuration falls back on M1's own run; any other one is pending too.
    const mlx = proposal.deciders.find((decider) => decider.runtime === "mlx")!;
    expect(mlx.tuningNote).toMatch(
      proposal.choice.bodyCharacters === 400 && proposal.choice.instructionId === "mechanism"
        ? /M1's own in-run scores/u
        : /pending/u
    );
  });
});

describe("the freeze guard (D3, R1)", () => {
  let directory = "";
  let proposal: Proposal;
  const parity: ParityFile = {
    format: "memora-f3-freeze-parity",
    version: 1,
    runtimes: {
      mlx: {
        runtimeBuild: "mlx-new",
        reference: { referenceHash: "a".repeat(64), maxAbsDelta: 0.0625 },
        m1Pairs: { pairs: 500, maxAbsDelta: 0.0625 },
        source: "t61"
      },
      gguf: {
        runtimeBuild: "gguf-build",
        reference: { referenceHash: "b".repeat(64), maxAbsDelta: 0 },
        m1Pairs: null,
        source: "unchanged"
      }
    }
  };
  const baseline = (runtime: string) => ({
    format: "memora-ranker-parity-baseline",
    version: 1,
    referenceHash: (runtime === "mlx" ? "a" : "b").repeat(64),
    runtime,
    runtimeBuild: `${runtime}-build`,
    scores: Array.from({ length: 64 }, (_, index) => index / 8)
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-bakeoff-freeze-"));
    proposal = await runSelect(selectInputs({ withTuningScores: true }));
    await writeFile(join(directory, "proposal.json"), JSON.stringify(proposal));
    await writeFile(join(directory, "parity.json"), JSON.stringify(parity));
    for (const runtime of ["mlx", "gguf"])
      await writeFile(
        join(directory, `baseline-${runtime}.json`),
        JSON.stringify(baseline(runtime))
      );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const freeze = (overrides: Partial<Parameters<typeof writeFreeze>[0]> = {}) =>
    writeFreeze({
      proposalPath: join(directory, "proposal.json"),
      parityPath: join(directory, "parity.json"),
      baselinePaths: {
        mlx: join(directory, "baseline-mlx.json"),
        gguf: join(directory, "baseline-gguf.json")
      },
      frozenPath: join(directory, "freeze", "frozen.json"),
      gateFDirectory: join(directory, "freeze", "gate-f"),
      refreeze: false,
      currentHashes: async (value) => value.inputs,
      now: () => new Date("2026-10-19T08:00:00.000Z"),
      ...overrides
    });

  it("refuses a proposal whose inputs changed and a failed parity check", async () => {
    await expect(
      freeze({ currentHashes: async (value) => ({ ...value.inputs, weighting: "0".repeat(64) }) })
    ).rejects.toThrow("input weighting changed");
    const failed = {
      ...parity,
      runtimes: {
        ...parity.runtimes,
        mlx: { ...parity.runtimes.mlx!, m1Pairs: { pairs: 500, maxAbsDelta: 0.5 } }
      }
    };
    await writeFile(join(directory, "parity-failed.json"), JSON.stringify(failed));
    await expect(freeze({ parityPath: join(directory, "parity-failed.json") })).rejects.toThrow(
      "score-parity check did not pass"
    );
    expect((await readHeldOutAccess(join(directory, "freeze", "frozen.json"))).open).toBe(false);
  });

  it("refuses to freeze after a held-out read without a freeze", async () => {
    await mkdir(join(directory, "freeze", "gate-f"), { recursive: true });
    await expect(freeze()).rejects.toThrow("a held-out read happened before the freeze");
    await rm(join(directory, "freeze", "gate-f"), { recursive: true });
  });

  it("writes a record the guard opens, with calibrations the typed configuration accepts", async () => {
    const record = await freeze();
    const access = await readHeldOutAccess(join(directory, "freeze", "frozen.json"));
    expect(access.open).toBe(true);
    expect(record.frozenAt).toBe("2026-10-19T08:00:00.000Z");
    expect(record.calibrations).toHaveLength(2);
    for (const entry of record.calibrations) {
      expect(RelationCalibrationEntrySchema.parse(entry)).toEqual(entry);
      expect(entry).toMatchObject({
        kind: "isotonic",
        freezeHash: record.configHash,
        labelSetHash: "2".repeat(64)
      });
    }
    const mlx = record.calibrations.find((entry) => entry.identity.runtimeKind === "mlx")!;
    expect(record.calibrationIdentity).toBe(relationCalibrationIdentityKey(mlx.identity));
    expect(record.inputHashes.proposal).toBe(
      sha256Hex(await readFile(join(directory, "proposal.json")))
    );
    // Plan decision 29: the suggest edge from the tuning partition, no apply band.
    expect(mlx).toMatchObject({
      applyFrom: null,
      suggestFrom: proposal.deciders.find((decider) => decider.runtime === "mlx")!.threshold!.edge
    });
  });

  it("never overwrites a freeze; a re-freeze keeps the first beside it", async () => {
    await expect(freeze()).rejects.toThrow("the configuration is frozen");
    const first = JSON.parse(await readFile(join(directory, "freeze", "frozen.json"), "utf8"));
    const second = await freeze({
      refreeze: true,
      now: () => new Date("2026-10-20T08:00:00.000Z")
    });
    expect(second.previous).toEqual([
      {
        configHash: first.configHash,
        frozenAt: first.frozenAt,
        file: join(directory, "freeze", "frozen-2026-10-19T08-00-00-000Z.json")
      }
    ]);
    expect(JSON.parse(await readFile(second.previous[0]!.file, "utf8")).configHash).toBe(
      first.configHash
    );
  });

  it("hashes the configuration independently of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const one = buildFreezeRecord({
      proposal,
      proposalSha256: "x",
      parity,
      baselines: { mlx: baseline("mlx") as never, gguf: baseline("gguf") as never },
      frozenAt: new Date(0)
    });
    const two = buildFreezeRecord({
      proposal,
      proposalSha256: "y",
      parity,
      baselines: { mlx: baseline("mlx") as never, gguf: baseline("gguf") as never },
      frozenAt: new Date(1)
    });
    expect(one.configHash).toBe(two.configHash);
    expect(() =>
      buildFreezeRecord({
        proposal,
        proposalSha256: "x",
        parity,
        baselines: { mlx: baseline("mlx") as never },
        frozenAt: new Date(0),
        runtimes: ["gguf"]
      })
    ).toThrow("default decider");
  });

  it("keeps gate F sealed without a freeze record", async () => {
    const previous = process.env[frozenFileEnvironmentVariable];
    process.env[frozenFileEnvironmentVariable] = join(directory, "missing", "frozen.json");
    try {
      await expect(runBakeoffCli(["gate-f"])).rejects.toThrow("held-out sealed until the freeze");
    } finally {
      if (previous === undefined) delete process.env[frozenFileEnvironmentVariable];
      else process.env[frozenFileEnvironmentVariable] = previous;
    }
  });
});

describe("calibrations in probability and score space", () => {
  it("reads a band's lowest score from the map as bandThresholds does", () => {
    const blocks = [
      { fromScore: -3, probability: 0.2 },
      { fromScore: 1, probability: 0.6 },
      { fromScore: 4, probability: 0.9 }
    ];
    expect(scoreAtLevel(blocks, 0.6)).toBe(1);
    expect(scoreAtLevel(blocks, 0.1)).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreAtLevel(blocks, 0.95)).toBeNull();
  });
});

describe("the gate F reads on a synthetic world (after a freeze)", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-bakeoff-gate-f-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("forecasts X1 on held-out lists, R_v6 and R_v9 losses, and the clean eval-split check", async () => {
    const proposal = await runSelect(selectInputs({ withTuningScores: true }));
    const parity: ParityFile = {
      format: "memora-f3-freeze-parity",
      version: 1,
      runtimes: {
        mlx: {
          runtimeBuild: "mlx-build",
          reference: { referenceHash: "a".repeat(64), maxAbsDelta: 0 },
          m1Pairs: null,
          source: "same build"
        },
        gguf: {
          runtimeBuild: "gguf-build",
          reference: { referenceHash: "b".repeat(64), maxAbsDelta: 0 },
          m1Pairs: null,
          source: "same build"
        }
      }
    };
    const baseline = (runtime: string) =>
      ({
        format: "memora-ranker-parity-baseline",
        referenceHash: "c".repeat(64),
        runtime,
        runtimeBuild: `${runtime}-build`,
        scores: new Array(64).fill(1)
      }) as never;
    const proposalText = JSON.stringify(proposal);
    await writeFile(join(directory, "proposal.json"), proposalText);
    const record = buildFreezeRecord({
      proposal,
      proposalSha256: sha256Hex(proposalText),
      parity,
      baselines: { mlx: baseline("mlx"), gguf: baseline("gguf") },
      frozenAt: new Date("2026-10-19T00:00:00Z")
    });
    const calibration = frozenCalibration(record, "mlx");
    // A score far inside the accept band and one far below it.
    const high = 50,
      low = -50;
    expect(calibration.applyFrom).toBeNull();
    expect(high).toBeGreaterThanOrEqual(calibration.suggestFrom!);

    const world = labelWorld();
    const rv6 = [true, true, false].map((related, index): LabelItem => ({
      pairId: `note:spike-a:${index}`,
      kind: "note",
      library: "spike-a",
      lo: `v6a${index}`,
      hi: `v6b${index}`,
      group: index === 0 ? "spike-a:L1|L1" : "spike-a:L1|L2",
      sets: ["rv6"],
      pool: null,
      stratum: null,
      split: null,
      related
    }));
    const sample: LabelItem = {
      ...rv6[0]!,
      pairId: "note:fixture:s",
      library: "fixture",
      lo: "h1",
      hi: "h2",
      group: "fixture:H01|H02",
      sets: ["rv9-sample"],
      related: true
    };
    const fixture = {
      format: "memora-f3-relation-labels",
      version: 1,
      labelSetSha256: "2".repeat(64),
      items: [...world.items, ...rv6, sample]
    };
    const scoreRows: Array<{ query: string; doc: string; logOdds: number }> = [];
    const both = (a: string, b: string, value: number) =>
      scoreRows.push({ query: a, doc: b, logOdds: value }, { query: b, doc: a, logOdds: value });
    for (const item of world.items) both(item.lo, item.hi, item.related ? high : low);
    // R_v6: the first two pairs kept, the third (unrelated) lost.
    rv6.forEach((item, index) => both(item.lo, item.hi, index < 2 ? high : low));
    const scoreFile = {
      format: "memora-relations-pair-scores",
      version: 1,
      decider: "test",
      scale: "log-odds",
      scores: scoreRows
    };
    const name = (runtime: string) =>
      `labels-${runtime}-${record.config.instruction.id}-t${record.config.bodyCharacters}.json`;
    await mkdir(join(directory, "scores"), { recursive: true });
    for (const runtime of ["mlx", "gguf"])
      await writeFile(join(directory, "scores", name(runtime)), JSON.stringify(scoreFile));
    const root = (id: string, partition: "tuning" | "holdout") => ({
      id,
      manifestKey: `mf-${id}`,
      title: `Root ${id}`,
      partition,
      family: "f",
      kind: "document",
      nonconceptual: false,
      records: []
    });
    const mapping = {
      format: "memora-golden-matching-mapping",
      version: 1,
      fixture: { path: "x", version: "matching-benchmark-v1", sha256: "d".repeat(64) },
      manifest: { name: "m", path: "m" },
      roots: [
        root("P01", "tuning"),
        root("P02", "tuning"),
        root("H01", "holdout"),
        root("H02", "holdout"),
        root("H03", "holdout")
      ],
      expectedRootPairs: [
        { pair: ["P01", "P02"], partition: "tuning", rationale: "" },
        { pair: ["H01", "H02"], partition: "holdout", rationale: "" },
        { pair: ["H01", "H03"], partition: "holdout", rationale: "" }
      ],
      forbiddenRootPairs: [{ pair: ["H02", "H03"], partition: "holdout", rationale: "" }],
      ambiguousRootPairs: [],
      subsets: { tuning: [], holdout: [] }
    };
    // S0's export: H01-H02 accepted, H01-H03 below the band, H02-H03 never reached the decider.
    const x1Export = {
      format: "memora-f3-retrieval-export",
      label: "x1-s0",
      notes: [
        { id: "p1", root: "P01" },
        { id: "p2", root: "P02" },
        { id: "h1", root: "H01" },
        { id: "h2", root: "H02" },
        { id: "h3", root: "H03" }
      ],
      candidates: [
        { noteId: "p2", candidateId: "p1", contentOrder: 1 },
        { noteId: "h2", candidateId: "h1", contentOrder: 1 },
        { noteId: "h3", candidateId: "h1", contentOrder: 1 }
      ],
      decisions: [
        { lo: "p1", hi: "p2", loToHi: 0, hiToLo: 0 },
        { lo: "h1", hi: "h2", loToHi: 0, hiToLo: 0 },
        { lo: "h1", hi: "h3", loToHi: 0, hiToLo: 0 }
      ]
    };
    scoreRows.length = 0;
    both("p1", "p2", high);
    both("h1", "h2", high);
    both("h1", "h3", low);
    const x1Scores = { ...scoreFile, scores: [...scoreRows] };
    // R_v9: h1-h2 kept, h1-h3 lost (the freeze pass labels it related).
    const rv9 = [
      { source_note: "h1", target_note: "h2", source_root: "H01", target_root: "H02" },
      { source_note: "h1", target_note: "h3", source_root: "H01", target_root: "H03" }
    ];
    const pass = { items: [{ lo: "h1", hi: "h3", related: { majority: true } }] };
    const files = { labels: fixture, mapping, x1Export, x1Scores, rv9, pass };
    for (const [key, value] of Object.entries(files))
      await writeFile(join(directory, `${key}.json`), JSON.stringify(value));
    const result = await runGateF({
      record,
      values: {
        "x1-export": join(directory, "x1Export.json"),
        "x1-scores": join(directory, "x1Scores.json"),
        "rv9-pass": join(directory, "pass.json")
      },
      paths: {
        labels: join(directory, "labels.json"),
        proposal: join(directory, "proposal.json"),
        mapping: join(directory, "mapping.json"),
        labelScores: join(directory, "scores"),
        rv9Relations: join(directory, "rv9.json"),
        outDir: join(directory, "gate-f")
      },
      now: () => new Date("2026-10-19T01:00:00Z")
    });
    expect(result.x1).toMatchObject({
      expected: 1,
      expectedOf: 2,
      forbidden: 0,
      forbiddenOf: 1,
      reached: 2,
      tuning: { expected: 1, expectedOf: 1 }
    });
    expect(result.x1!.missed).toEqual([
      expect.objectContaining({ pair: "H01/H03", reached: true })
    ]);
    expect(result.rv6).toMatchObject({
      pairs: 3,
      lost: 1,
      related: 2,
      lostRelated: 0,
      loss: 0,
      sameRoot: { pairs: 1, lost: 0 }
    });
    // One lost related pair over 1 + 1 kept x the sample's share (1).
    expect(result.rv9).toMatchObject({
      pairs: 2,
      lost: 1,
      lostRelated: 1,
      loss: 0.5,
      unlabelledLost: 0
    });
    expect(JSON.parse(await readFile(join(directory, "gate-f", "rv9-lost.json"), "utf8"))).toEqual({
      pairs: [["h1", "h3"]]
    });
    expect(result.cleanCheck.map((row) => row.runtime)).toEqual(["mlx", "gguf"]);
    expect(result.cleanCheck[0]).toMatchObject({
      labels: 72,
      precisionAtSuggest: 1,
      recallAtAccept: 1
    });
    const report = renderGateF(result);
    expect(report).toContain("| X1 forecast, held-out expected (optimistic typing) | 1/2 |");
    expect(report).toContain("Typer checks | needs --typer-report");
  });
});

describe("the calibration's parity scores", () => {
  it("come from the build the fit scores came from", async () => {
    const proposal = await runSelect(selectInputs({ withTuningScores: true }));
    const parity: ParityFile = {
      format: "memora-f3-freeze-parity",
      version: 1,
      runtimes: {
        mlx: {
          runtimeBuild: "mlx-build",
          reference: { referenceHash: "a".repeat(64), maxAbsDelta: 0 },
          m1Pairs: null,
          source: "same build"
        }
      }
    };
    const baseline = (runtimeBuild: string) =>
      ({
        format: "memora-ranker-parity-baseline",
        referenceHash: "a".repeat(64),
        runtime: "mlx",
        runtimeBuild,
        scores: new Array(64).fill(0)
      }) as never;
    const build = (runtimeBuild: string) =>
      buildFreezeRecord({
        proposal,
        proposalSha256: "p",
        parity,
        baselines: { mlx: baseline(runtimeBuild) },
        frozenAt: new Date(0),
        runtimes: ["mlx"]
      });
    expect(() => build("another-build")).toThrow("the parity baseline is of another-build");
    expect(build("mlx-build").calibrations).toHaveLength(1);
  });
});

describe("population weights by cell (3.9, the top-up of 2026-10-18)", () => {
  it("names the top-up bands by the proposed mean at 600 characters", () => {
    expect([-0.1, 0, 2.15, 2.15625, 4.374, 4.375, 9].map(topupBandOf)).toEqual([
      0, 1, 1, 2, 2, 3, 3
    ]);
  });

  it("weighs a label by its cell's candidates over its labels, merging empty cells downwards", () => {
    const population = [
      // Stratum 3: band 2 holds 30 candidates, band 3 holds 6 (no label there: it merges into band 2).
      ...Array.from({ length: 30 }, () => ({ stratum: 3, band: 2 })),
      ...Array.from({ length: 6 }, () => ({ stratum: 3, band: 3 })),
      // Stratum 4: band 3 has 20 candidates and 4 labels; band 0 has 2 candidates and no label, the lowest
      // band, so it merges upwards into band 1, which has no candidate but one label.
      ...Array.from({ length: 20 }, () => ({ stratum: 4, band: 3 })),
      ...Array.from({ length: 2 }, () => ({ stratum: 4, band: 0 }))
    ];
    const labels = [
      ...Array.from({ length: 6 }, (_, index) => ({ key: `s3-${index}`, stratum: 3, band: 2 })),
      ...Array.from({ length: 4 }, (_, index) => ({ key: `s4-${index}`, stratum: 4, band: 3 })),
      { key: "s4-low", stratum: 4, band: 1 }
    ];
    const result = cellWeights({ pool: "C", population, labels, scheme: "stratum-and-band" });
    expect(result.weights.get("s3-0")).toBe(36 / 6);
    expect(result.weights.get("s4-0")).toBe(20 / 4);
    expect(result.weights.get("s4-low")).toBe(2);
    expect(
      result.cells.map((cell) => [cell.stratum, cell.bands, cell.population, cell.labels])
    ).toEqual([
      [3, [2, 3], 36, 6],
      [4, [0, 1], 2, 1],
      [4, [3], 20, 4]
    ]);
    // T57's coarse cells: one per stratum.
    const coarse = cellWeights({ pool: "C", population, labels, scheme: "stratum" });
    expect(coarse.weights.get("s3-0")).toBe(36 / 6);
    expect(coarse.weights.get("s4-0")).toBe(22 / 5);
  });

  it("reports a stratum with candidates and no label, and refuses labels with no candidate", () => {
    const unrepresented = cellWeights({
      pool: "B",
      population: [{ stratum: 0, band: 0 }],
      labels: [{ key: "x", stratum: 1, band: 0 }].filter(() => false),
      scheme: "stratum"
    });
    expect(unrepresented.unrepresented).toEqual([{ pool: "B", stratum: 0, population: 1 }]);
    expect(() =>
      cellWeights({
        pool: "B",
        population: [],
        labels: [{ key: "x", stratum: 2, band: 1 }],
        scheme: "stratum"
      })
    ).toThrow("labels and no candidate");
  });

  it("keeps every R_v9 pair out of the labels and the population, and bands labels by the frame", () => {
    const item = (
      pool: string,
      n: number,
      stratum: number,
      split: "fit" | "eval" = "fit"
    ): LabelItem => ({
      pairId: `note:${pool}:${n}`,
      kind: "note",
      library: "x",
      lo: `${pool}lo${n}`,
      hi: `${pool}hi${n}`,
      group: `g${n}`,
      sets: [`pool-${pool}`],
      pool,
      stratum,
      split,
      related: true
    });
    const items = [
      item("A", 1, 4),
      item("A", 2, 4, "eval"),
      item("A", 3, 4),
      item("B", 1, 4),
      item("C", 1, 4)
    ];
    const pair = (pool: string, n: number) => ({
      lo: `${pool}lo${n}`,
      hi: `${pool}hi${n}`,
      stratum: 4
    });
    const population = (pool: string, count: number) =>
      Array.from({ length: count }, (_, index) => pair(pool, index + 1));
    const frameOf = (pool: string, count: number, score: (n: number) => number) =>
      scoresOf(
        Array.from({ length: count }, (_, index) => index + 1).flatMap(
          (n): Array<[string, string, number]> => [
            [`${pool}lo${n}`, `${pool}hi${n}`, score(n)],
            [`${pool}hi${n}`, `${pool}lo${n}`, score(n)]
          ]
        )
      );
    const weighting = buildWeighting({
      items,
      // A3 is an R_v9 pair: out of pool A's labels and population.
      excluded: new Set([notePairKey("Alo3", "Ahi3")]),
      populations: {
        A: { pairs: population("A", 10), frame: null, scheme: "stratum" },
        B: {
          pairs: population("B", 8),
          frame: frameOf("B", 8, (n) => (n <= 2 ? 5 : 3)),
          scheme: "stratum-and-band"
        },
        C: {
          pairs: population("C", 6),
          frame: frameOf("C", 6, () => 5),
          scheme: "stratum-and-band"
        }
      },
      labelBand: null,
      hashes: { weighting: "test" }
    });
    expect(weighting.excludedLabels).toBe(1);
    expect(weighting.excludedPopulation).toBe(1);
    // Pool A: 9 candidates over 2 labels (fit and eval).
    expect(weighting.weightOf.get("note:A:1")).toBe(4.5);
    expect(weighting.weightOf.has("note:A:3")).toBe(false);
    // Pool B: B1 is in band 3 (2 candidates); band 2's 6 candidates have no label and merge into band 3.
    expect(weighting.weightOf.get("note:B:1")).toBe(8);
    expect(weighting.weightOf.get("note:C:1")).toBe(6);
    const fit = weightedPoolLabels({ items }, weighting, "fit");
    expect(fit.map((label) => label.pairId)).toEqual(["note:A:1", "note:B:1", "note:C:1"]);
    expect(weightedPoolLabels({ items }, weighting, "eval").map((label) => label.pairId)).toEqual([
      "note:A:2"
    ]);
    expect(() =>
      buildWeighting({
        items,
        excluded: new Set(),
        populations: {
          A: { pairs: population("A", 10), frame: null, scheme: "stratum" },
          B: { pairs: population("B", 8), frame: null, scheme: "stratum-and-band" },
          C: { pairs: population("C", 6), frame: null, scheme: "stratum" }
        },
        labelBand: null,
        hashes: {}
      })
    ).toThrow("frame scores");
  });

  it("refuses a pool label without a weight", () => {
    const labelled: LabelItem = {
      pairId: "note:A:9",
      kind: "note",
      library: "x",
      lo: "a",
      hi: "b",
      group: "g",
      sets: ["pool-A"],
      pool: "A",
      stratum: 1,
      split: "fit",
      related: false
    };
    expect(() =>
      weightedPoolLabels({ items: [labelled] }, { weightOf: new Map(), excluded: new Set() }, "fit")
    ).toThrow("No population weight");
  });
});

describe("plan decision 29: the decide threshold from the fixture tuning partition", () => {
  // Roots R1-R4, one note each; R1/R4 is forbidden, R1/R2, R1/R3 and R2/R3 are expected.
  const data: Pick<RetrievalExport, "notes" | "candidates" | "typings" | "decisions"> = {
    notes: [
      { id: "a1", root: "R1" },
      { id: "a2", root: "R2" },
      { id: "a3", root: "R3" },
      { id: "a4", root: "R4" }
    ],
    candidates: [
      { noteId: "a2", candidateId: "a1", contentOrder: 1 },
      { noteId: "a3", candidateId: "a1", contentOrder: 1 },
      { noteId: "a4", candidateId: "a1", contentOrder: 1 },
      { noteId: "a3", candidateId: "a2", contentOrder: 2 },
      { noteId: "a4", candidateId: "a2", contentOrder: 2 }
    ],
    decisions: [
      { lo: "a1", hi: "a2", loToHi: 5, hiToLo: 5 },
      { lo: "a1", hi: "a3", loToHi: 3, hiToLo: 3 },
      { lo: "a1", hi: "a4", loToHi: 2, hiToLo: 2 },
      { lo: "a2", hi: "a3", loToHi: 3, hiToLo: 3 },
      // A neither pair: a lower edge that finds as many expected pairs ties, and the higher edge wins.
      { lo: "a2", hi: "a4", loToHi: 2.5, hiToLo: 2.5 }
    ],
    typings: []
  };
  const scores = scoresOf(
    data.decisions.flatMap((row): Array<[string, string, number]> => [
      [row.lo, row.hi, row.loToHi!],
      [row.hi, row.lo, row.hiToLo!]
    ])
  );
  const lists = {
    expected: [
      ["R1", "R2"],
      ["R1", "R3"],
      ["R2", "R3"]
    ] as Array<[string, string]>,
    forbidden: [["R1", "R4"]] as Array<[string, string]>
  };
  const blocks = [
    { fromScore: 0, probability: 0.2 },
    { fromScore: 2.7, probability: 0.6 }
  ];
  const label = (pairId: string, score: number, positive: boolean, group: string) => ({
    pairId,
    lo: `${pairId}lo`,
    hi: `${pairId}hi`,
    pool: "C" as const,
    stratum: 3,
    group,
    positive,
    weight: 2,
    score
  });

  it("takes the edge with the most expected root pairs at 0 forbidden, the higher on a tie", () => {
    const threshold = decideThreshold({
      data,
      scores,
      rule: "mean",
      blocks,
      lists,
      labels: [label("p", 4, true, "corpus:X|Y"), label("n", 2.9, false, "corpus:X|X")]
    });
    expect(threshold).toMatchObject({
      edge: 3,
      probability: 0.6,
      expectedBeforeTyping: 3,
      forbiddenBeforeTyping: 0,
      expectedOf: 3,
      candidates: 4
    });
    // The panel at the edge, reported: the positive above it, the negative (2.9) below.
    expect(threshold.panel.pooled).toMatchObject({ labels: 1, precision: 1, recall: 1 });
    expect(threshold.panelCrossRoot).toMatchObject({ labels: 1, precision: 1 });
  });

  it("has no edge when every band that finds an expected pair links a forbidden one", () => {
    const blocked = {
      ...data,
      decisions: data.decisions.map((row) =>
        row.lo === "a1" && row.hi === "a4" ? { ...row, loToHi: 9, hiToLo: 9 } : row
      )
    };
    const threshold = decideThreshold({
      data: blocked,
      scores: scoresOf(
        blocked.decisions.flatMap((row): Array<[string, string, number]> => [
          [row.lo, row.hi, row.loToHi!],
          [row.hi, row.lo, row.hiToLo!]
        ])
      ),
      rule: "mean",
      blocks,
      lists,
      labels: []
    });
    expect(threshold.edge).toBeNull();
    expect(threshold.panel.pooled).toMatchObject({ labels: 0, precision: null });
  });
});

describe("the typer report gate F reads", () => {
  const report = {
    format: "memora-typer-position-check",
    summary: { pairs: 60, directionAccuracy: 0.9, swapConsistency: 0.95 }
  };

  it("is the product prompt's two-order check, never a typer experiment report", () => {
    expect(typerReportSchema.safeParse(report).success).toBe(true);
    const product = { ...report, orders: "both", prompt: { candidate: null } };
    expect(typerReportSchema.safeParse(product).success).toBe(true);
    expect(typerReportSchema.safeParse({ ...product, orders: "content" }).success).toBe(false);
    expect(
      typerReportSchema.safeParse({ ...product, prompt: { candidate: "candidate-shipped-1" } })
        .success
    ).toBe(false);
  });
});
