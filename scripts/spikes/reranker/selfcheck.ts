/**
 * Self-check for the Spike A metric helpers (vitest does not include `scripts/`).
 *
 *   npx tsx scripts/spikes/reranker/selfcheck.ts
 */
import assert from "node:assert/strict";

import {
  auc,
  chooseThreshold,
  labelledScores,
  logit,
  pairKey,
  percentile,
  pearson,
  ranks,
  rootOutcome,
  rootPairScores,
  spearman
} from "./metrics.js";

const close = (actual: number, expected: number, epsilon = 1e-9): void =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not close to ${expected}`);

// Ranks and AUC, including ties and -Infinity ("not retrieved").
assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
close(auc([3, 4], [1, 2]) ?? Number.NaN, 1);
close(auc([1, 2], [3, 4]) ?? Number.NaN, 0);
close(auc([1, 2], [1, 2]) ?? Number.NaN, 0.5);
close(auc([2, Number.NEGATIVE_INFINITY], [1, Number.NEGATIVE_INFINITY]) ?? Number.NaN, 0.625);
assert.equal(auc([], [1]), null);

// Correlations and percentiles.
close(pearson([1, 2, 3], [2, 4, 6]), 1);
close(pearson([1, 2, 3], [3, 2, 1]), -1);
close(spearman([1, 2, 3, 4], [1, 4, 9, 16]), 1);
close(percentile([1, 2, 3, 4], 0.5), 2.5);
close(percentile([5], 0.95), 5);
close(logit(0.5), 0);
assert.ok(Number.isFinite(logit(1)) && Number.isFinite(logit(0)));

// Root-pair aggregation: max over rows in either direction, same-root rows ignored.
assert.equal(pairKey("B", "A"), "A/B");
const scores = rootPairScores([
  { rootA: "A", rootB: "B", score: 1 },
  { rootA: "B", rootB: "A", score: 3 },
  { rootA: "A", rootB: "A", score: 99 }
]);
assert.equal(scores.get("A/B"), 3);
assert.equal(scores.has("A/A"), false);

// Threshold: zero forbidden on tuning, midpoint of the optimal plateau.
const tuning = labelledScores(
  new Map([
    ["A/B", 5],
    ["C/D", 3],
    ["E/F", 1],
    ["G/H", 2]
  ]),
  ["A/B", "C/D", "E/F", "X/Y"],
  ["G/H"]
);
const choice = chooseThreshold(tuning);
assert.ok(choice);
close(choice.threshold, 2.5);
assert.equal(choice.expectedFound, 2);
const heldOut = labelledScores(
  new Map([
    ["A/B", 4],
    ["Q/R", 2.6],
    ["S/T", 2.4]
  ]),
  ["A/B", "Q/R", "U/V"],
  ["S/T"]
);
const outcome = rootOutcome(heldOut, choice.threshold);
assert.equal(outcome.expectedFound, 2);
assert.equal(outcome.forbiddenFound, 0);
assert.equal(outcome.expectedRetrieved, 2);
assert.equal(chooseThreshold(labelledScores(new Map([["G/H", 9]]), ["A/B"], ["G/H"])), null);

console.info("reranker spike metric self-check passed");
