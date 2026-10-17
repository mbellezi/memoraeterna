import { describe, expect, it } from "vitest";

import type { PairText, ScoreCall } from "../spikes/reranker/runtimes.ts";
import {
  combinationsOf,
  drawPairs,
  measureB1,
  p0BudgetMs,
  renderB1Markdown
} from "./b1-benchmark.ts";
import type { PairScorer } from "./pair-scoring.ts";

const artifact = {
  name: "qwen3-reranker-0.6b-mlx",
  repository: "mlx-community/Qwen3-Reranker-0.6B",
  revision: "0123456789abcdef0123456789abcdef01234567",
  license: "apache-2.0",
  mainFile: "model.safetensors",
  bytes: 1,
  sha256: "f".repeat(64)
};

const candidates: PairText[] = Array.from({ length: 600 }, (_, index) => ({
  query: `query ${index}`,
  document: `document ${index}`
}));

interface Call {
  size: number;
  batch: number;
}

/** A scorer whose call takes `msPerPair` per pair, plus a fixed overhead, recording what it was asked. */
function timedScorer(calls: Call[], msPerPair: (batch: number) => number): PairScorer {
  return {
    name: "mlx",
    artifact,
    async scorePairs(pairs, batchSize): Promise<ScoreCall> {
      calls.push({ size: pairs.length, batch: batchSize });
      return {
        logOdds: pairs.map(() => 0),
        wallMs: 5 + pairs.length * msPerPair(batchSize),
        inferenceMs: pairs.length * msPerPair(batchSize),
        tokenCounts: pairs.map(() => 300)
      };
    }
  };
}

describe("B1 combinations", () => {
  it("pairs each call size with the helper batches that fit in it", () => {
    expect(
      combinationsOf({ callSizes: [48, 16, 32, 16], helperBatches: [32, 16, 48], batched: true })
    ).toEqual([
      { callSize: 16, helperBatch: 16 },
      { callSize: 32, helperBatch: 16 },
      { callSize: 32, helperBatch: 32 },
      { callSize: 48, helperBatch: 16 },
      { callSize: 48, helperBatch: 32 },
      { callSize: 48, helperBatch: 48 }
    ]);
  });

  it("has no helper batch when the runtime ranks one pair at a time", () => {
    expect(combinationsOf({ callSizes: [32, 16], helperBatches: [16], batched: false })).toEqual([
      { callSize: 16, helperBatch: null },
      { callSize: 32, helperBatch: null }
    ]);
  });
});

describe("the seeded draw", () => {
  it("is deterministic, without replacement and different for another seed", () => {
    const first = drawPairs(candidates, 100, 7);
    expect(drawPairs(candidates, 100, 7)).toEqual(first);
    expect(drawPairs(candidates, 100, 8)).not.toEqual(first);
    expect(new Set(first.map((pair) => pair.query)).size).toBe(100);
    expect(() => drawPairs(candidates, 601, 7)).toThrow("Cannot draw 601");
  });
});

describe("measuring B1", () => {
  const options = {
    callSizes: [16, 48],
    helperBatches: [16, 48],
    batched: true,
    repeats: 3,
    callsPerRepeat: 4,
    seed: 11
  };

  it("times the same calls for every combination, repeated, after one untimed call each", async () => {
    const calls: Call[] = [];
    const result = await measureB1(
      timedScorer(calls, () => 10),
      candidates,
      options
    );
    // Model load, one warm call per combination (16/16, 48/16, 48/48), then the measured calls.
    expect(calls.slice(0, 4).map((call) => call.size)).toEqual([16, 16, 48, 48]);
    expect(calls).toHaveLength(4 + 3 * 3 * 4);
    expect(result.combinations.map((row) => [row.callSize, row.helperBatch, row.calls])).toEqual([
      [16, 16, 12],
      [48, 16, 12],
      [48, 48, 12]
    ]);
    expect(result.poolPairs).toBe(48 * 4);
  });

  it("reports ms per pair, the device share, tokens and the P0 budget", async () => {
    const result = await measureB1(
      timedScorer([], (batch) => (batch === 48 ? 30 : 10)),
      candidates,
      options
    );
    const [small, mid, large] = result.combinations;
    expect(small?.callMs.mean).toBe(5 + 16 * 10);
    expect(small?.msPerPair.mean).toBeCloseTo((5 + 160) / 16, 9);
    expect(small?.inferenceMsPerPair).toBe(10);
    expect(small?.meanTokensPerPair).toBe(300);
    expect(small?.withinBudgetMean).toBe(true);
    expect(mid?.callMs.mean).toBe(5 + 48 * 10);
    expect(mid?.callsOverBudget).toBe(0);
    // 48 pairs at 30 ms is 1,445 ms: over the 1.0 s budget in every call.
    expect(large?.callMs.p95).toBe(5 + 48 * 30);
    expect(large?.callsOverBudget).toBe(12);
    expect(large?.withinBudgetMean).toBe(false);
    expect(large?.withinBudgetP95).toBe(false);
    expect(p0BudgetMs).toBe(1_000);
  });

  it("prints a table with one row per combination", async () => {
    const result = await measureB1(
      timedScorer([], () => 10),
      candidates,
      options
    );
    const markdown = renderB1Markdown(result, {
      runtime: "mlx",
      hostLoadAverage: { before: [1, 2, 3], after: [1.5, 2, 3] }
    });
    expect(markdown).toContain("B1 mlx: 3 repeats of 4 calls");
    expect(markdown.split("\n").filter((line) => /^\| \d+ \| /u.test(line))).toHaveLength(3);
  });

  it("refuses a scorer that returns non-finite scores and an empty plan", async () => {
    const broken: PairScorer = {
      name: "mlx",
      artifact,
      scorePairs: async (pairs) => ({ logOdds: pairs.map(() => Number.NaN), wallMs: 1 })
    };
    await expect(measureB1(broken, candidates, options)).rejects.toThrow("non-finite");
    await expect(
      measureB1(
        timedScorer([], () => 1),
        candidates,
        { ...options, callSizes: [] }
      )
    ).rejects.toThrow("no call size");
  });
});
