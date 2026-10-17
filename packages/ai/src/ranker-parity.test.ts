import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AiCassette,
  AiCassetteMissError,
  compareRankerParity,
  createDecideValidation,
  createRankerParityRecord,
  decideValidationParityFailed,
  isDecideValidationCurrent,
  rankPairsTaskRequest,
  rankerParityBaselineApplies,
  rankerParityConfig,
  rankerParityPlan,
  rankerParityRecordSchema,
  rankerParityReference,
  rankerParityReferenceHash,
  rankerParityReferenceSchema,
  scoreRankerParityReference,
  type AiModelAdapter,
  type AiTaskRequest,
  type AiTaskResult,
  type RankerParityBaseline,
  type RankResult
} from "./index.js";

const smoke = {
  passed: true,
  modelCard: { logOdds: [7.6, -11.4], expected: [7.625, -11.375], maxDelta: 0.03 },
  relevance: [{ language: "en", relevant: 8, irrelevant: -8, margin: 16 }],
  failures: []
};

const subject = {
  runtime: "mlx" as const,
  revision: "rev",
  artifactSha256: "a".repeat(64),
  runtimeBuild: "memora-mlx-helper@sha256:" + "b".repeat(64)
};

/** Scores spread over the log-odds range the reference spans, in reference order. */
const scores = Array.from({ length: 64 }, (_, index) => -12 + index * 0.31);

describe("the parity reference", () => {
  it("holds 64 directed pairs: both directions of 32 note pairs of the fixture's note text", () => {
    const reference = rankerParityReference();

    expect(reference.pairs).toHaveLength(rankerParityConfig.pairs);
    expect(new Set(reference.pairs.map((pair) => pair.id)).size).toBe(64);
    for (let index = 0; index < 64; index += 2) {
      const forward = reference.pairs[index]!;
      const backward = reference.pairs[index + 1]!;
      expect(backward.query).toBe(forward.document);
      expect(backward.document).toBe(forward.query);
      expect(forward.query).not.toBe(forward.document);
    }
    // The relation-pair-text-v1 shape: a title, an idea and the first body characters.
    for (const pair of reference.pairs) {
      expect(pair.query).toMatch(/^Title: .+\nIdea: .+\nText: /u);
      expect(pair.query.length).toBeLessThan(800);
    }
    expect(reference.instruction).toMatch(/same underlying mechanism/u);
    expect(rankerParityReferenceSchema.safeParse(reference).success).toBe(true);
  });

  it("is a protocol constant: its hash is pinned, and only scoring text changes it", () => {
    const reference = rankerParityReference();
    expect(rankerParityReferenceHash()).toBe(
      "77c2d41683fc4b9697e5925ae95b1a8f2b18a3a2673e52bd560118750b9854f9"
    );
    expect(
      rankerParityReferenceHash({
        ...reference,
        description: "reworded",
        pairs: reference.pairs.map((pair) => ({ ...pair, id: `x-${pair.id}` }))
      })
    ).toBe(rankerParityReferenceHash());
    expect(
      rankerParityReferenceHash({ ...reference, instruction: "Another instruction" })
    ).not.toBe(rankerParityReferenceHash());
    const edited = reference.pairs.map((pair, index) =>
      index === 7 ? { ...pair, document: `${pair.document}.` } : pair
    );
    expect(rankerParityReferenceHash({ ...reference, pairs: edited })).not.toBe(
      rankerParityReferenceHash()
    );
  });

  it("is scored in fixed calls per runtime, whatever the product splits calls at", () => {
    expect(rankerParityConfig.tolerance).toBe(0.125);
    expect(rankerParityPlan("mlx")).toEqual({ pairsPerCall: 32, helperBatchSize: 16 });
    expect(rankerParityPlan("gguf")).toEqual({ pairsPerCall: 16 });
  });
});

describe("scoring the reference", () => {
  it("sends the MLX plan: two calls of 32 pairs under the reference instruction, in order", async () => {
    const reference = rankerParityReference();
    const calls: Array<{ pairs: number; first: string; helperBatchSize?: number }> = [];
    let next = 0;

    const logOdds = await scoreRankerParityReference("mlx", async (request, plan) => {
      calls.push({
        pairs: request.pairs.length,
        first: request.pairs[0]!.query,
        ...(plan.helperBatchSize ? { helperBatchSize: plan.helperBatchSize } : {})
      });
      expect(request.instruction).toBe(reference.instruction);
      return result(request.pairs.map(() => next++));
    });

    expect(calls).toEqual([
      { pairs: 32, first: reference.pairs[0]!.query, helperBatchSize: 16 },
      { pairs: 32, first: reference.pairs[32]!.query, helperBatchSize: 16 }
    ]);
    expect(logOdds).toEqual(Array.from({ length: 64 }, (_, index) => index));
  });

  it("sends the GGUF plan: four calls of 16 pairs, no helper batch", async () => {
    const sizes: number[] = [];
    const batches: Array<number | undefined> = [];
    await scoreRankerParityReference("gguf", async (request, plan) => {
      sizes.push(request.pairs.length);
      batches.push(plan.helperBatchSize);
      return result(request.pairs.map(() => 0));
    });
    expect(sizes).toEqual([16, 16, 16, 16]);
    expect(batches).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("fails when a call does not score every pair", async () => {
    await expect(
      scoreRankerParityReference("mlx", async (request) =>
        result(request.pairs.slice(1).map(() => 0))
      )
    ).rejects.toThrow("did not score every pair");
  });
});

describe("comparing scores", () => {
  it("measures the largest and the mean distance and names the worst pair", () => {
    const delta = compareRankerParity([1, 2, 3, 4], [1, 2.5, 2.9, 4]);
    expect(delta.maxDelta).toBeCloseTo(0.5, 12);
    expect(delta.meanDelta).toBeCloseTo(0.15, 12);
    expect(delta.worstIndex).toBe(1);
  });

  it("is infinite when a score is not finite, and refuses scores that do not line up", () => {
    expect(compareRankerParity([1], [Number.NaN]).maxDelta).toBe(Number.POSITIVE_INFINITY);
    expect(() => compareRankerParity([1, 2], [1])).toThrow("do not cover the same pairs");
    expect(() => compareRankerParity([], [])).toThrow("do not cover the same pairs");
  });
});

describe("the parity record", () => {
  it("takes the first run as the baseline of the install: nothing to drift from yet", () => {
    const record = createRankerParityRecord({
      runtime: "mlx",
      scores,
      runtimeBuild: subject.runtimeBuild
    });

    expect(record).toMatchObject({
      passed: true,
      maxDelta: 0,
      tolerance: 0.125,
      baseline: {
        source: "validation",
        runtimeBuild: subject.runtimeBuild,
        referenceHash: rankerParityReferenceHash(),
        plan: { pairsPerCall: 32, helperBatchSize: 16 }
      }
    });
    expect(record.baseline.scores).toEqual(scores);
    expect(rankerParityRecordSchema.safeParse(record).success).toBe(true);
  });

  it("reuses the calibration within the tolerance and keeps the baseline it was measured against", () => {
    const baseline = calibrationBaseline("mlx");
    const rebuilt = scores.map((score, index) => score + (index % 2 === 0 ? 0.125 : -0.0625));

    const record = createRankerParityRecord({
      runtime: "mlx",
      scores: rebuilt,
      runtimeBuild: "rebuilt",
      baseline
    });

    expect(record.passed).toBe(true);
    expect(record.maxDelta).toBeCloseTo(0.125, 12);
    expect(record.baseline).toEqual(baseline);
    expect(record.scores).toEqual(rebuilt);
  });

  it("leaves the decider uncalibrated beyond 0.125 log-odds on a single pair", () => {
    const drifted = scores.map((score, index) => (index === 40 ? score + 0.1251 : score));

    const record = createRankerParityRecord({
      runtime: "mlx",
      scores: drifted,
      runtimeBuild: "rebuilt",
      baseline: calibrationBaseline("mlx")
    });

    expect(record.passed).toBe(false);
    expect(record.maxDelta).toBeCloseTo(0.1251, 12);
  });

  it("does not let a series of small drifts pass against the one before", () => {
    const first = createRankerParityRecord({ runtime: "mlx", scores, runtimeBuild: "b1" });
    const step = (previous: readonly number[]) => previous.map((score) => score + 0.1);
    const second = createRankerParityRecord({
      runtime: "mlx",
      scores: step(scores),
      runtimeBuild: "b2",
      baseline: first.baseline
    });
    const third = createRankerParityRecord({
      runtime: "mlx",
      scores: step(second.scores),
      runtimeBuild: "b3",
      baseline: second.baseline
    });

    expect(second.passed).toBe(true);
    expect(third.passed).toBe(false);
    expect(third.baseline.scores).toEqual(scores);
  });

  it("ignores a baseline of another reference or another batching and starts a new one", () => {
    const otherReference = { ...calibrationBaseline("mlx"), referenceHash: "c".repeat(64) };
    const otherPlan = {
      ...calibrationBaseline("mlx"),
      plan: { pairsPerCall: 16, helperBatchSize: 16 }
    };
    const ggufPlan = calibrationBaseline("gguf");

    for (const baseline of [otherReference, otherPlan, ggufPlan]) {
      expect(rankerParityBaselineApplies(baseline, "mlx")).toBe(false);
      const record = createRankerParityRecord({
        runtime: "mlx",
        scores: scores.map((score) => score + 5),
        runtimeBuild: "rebuilt",
        baseline
      });
      expect(record).toMatchObject({ passed: true, maxDelta: 0 });
      expect(record.baseline.source).toBe("validation");
    }
    expect(rankerParityBaselineApplies(calibrationBaseline("mlx"), "mlx")).toBe(true);
    expect(rankerParityBaselineApplies(null, "mlx")).toBe(false);
  });
});

describe("the parity record inside a decide validation", () => {
  it("is stored with the validation and a failure reads as uncalibrated", () => {
    const passed = createRankerParityRecord({ runtime: "mlx", scores, runtimeBuild: "b" });
    const failed = createRankerParityRecord({
      runtime: "mlx",
      scores: scores.map((score) => score + 1),
      runtimeBuild: "b2",
      baseline: passed.baseline
    });

    const good = createDecideValidation(subject, smoke, new Date(), passed);
    const bad = createDecideValidation(subject, smoke, new Date(), failed);
    const unchecked = createDecideValidation(subject, smoke);

    expect(decideValidationParityFailed(good)).toBe(false);
    expect(decideValidationParityFailed(bad)).toBe(true);
    expect(decideValidationParityFailed(unchecked)).toBe(false);
    expect(decideValidationParityFailed(null)).toBe(false);
    expect(unchecked.parity).toBeUndefined();
    // A failed parity check does not void the validation: the smoke test passed on this build.
    expect(isDecideValidationCurrent(bad, subject)).toBe(true);
    expect(isDecideValidationCurrent(bad, { ...subject, runtimeBuild: "other" })).toBe(false);
  });
});

describe("the cassette wrap of a pairs request", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-pairs-cassette-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const request = {
    instruction: "Decide whether the two notes link.",
    pairs: [
      { query: "Title: A", document: "Title: B" },
      { query: "Title: B", document: "Title: A" }
    ]
  };

  class FakeRanker implements AiModelAdapter {
    public calls = 0;
    public describe() {
      return {
        providerId: "local-mlx",
        modelId: "Qwen/Qwen3-Reranker-0.6B",
        runtime: "local" as const,
        capabilities: ["reranking" as const, "offline" as const],
        parameterCapabilities: {},
        limits: {},
        requirements: { adapter: "mlx-swift-lm", revision: "rev" }
      };
    }
    public canHandle() {
      return true;
    }
    public async run(task: AiTaskRequest): Promise<AiTaskResult> {
      this.calls += 1;
      const logOdds = [3 + this.calls, -2];
      return {
        taskType: task.taskType,
        output: {
          logOdds,
          scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
          tokenCounts: [90, 91],
          truncated: [false, false]
        },
        providerId: "local-mlx",
        modelId: "Qwen/Qwen3-Reranker-0.6B",
        runtime: "local",
        durationMs: 30,
        inputTokens: 181,
        outputTokens: 0,
        costEstimate: 0
      };
    }
  }

  it("records a pairs call and replays it without running the model", async () => {
    const live = new FakeRanker();
    const recorded = await new AiCassette({ mode: "record", directory })
      .wrap(live)
      .run(rankPairsTaskRequest(request, { batchSize: 16 }));
    expect(live.calls).toBe(1);

    const offline = new FakeRanker();
    const replayed = await new AiCassette({ mode: "replay", directory })
      .wrap(offline)
      .run(rankPairsTaskRequest(request, { batchSize: 16 }));

    expect(offline.calls).toBe(0);
    expect(replayed.output).toEqual(recorded.output);
  });

  it("keys batch 1 and batch 16 apart, so a replay of one never serves the other", async () => {
    await new AiCassette({ mode: "record", directory })
      .wrap(new FakeRanker())
      .run(rankPairsTaskRequest(request, { batchSize: 16 }));
    const replay = new AiCassette({ mode: "replay", directory }).wrap(new FakeRanker());

    await expect(
      replay.run(rankPairsTaskRequest(request, { batchSize: 1 }))
    ).rejects.toBeInstanceOf(AiCassetteMissError);
    await expect(replay.run(rankPairsTaskRequest(request))).rejects.toBeInstanceOf(
      AiCassetteMissError
    );
    await expect(
      replay.run(rankPairsTaskRequest(request, { batchSize: 16 }))
    ).resolves.toBeDefined();
  });
});

function result(logOdds: number[]): RankResult {
  return {
    logOdds,
    scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
    tokenCounts: logOdds.map(() => 300),
    truncated: logOdds.map(() => false)
  };
}

function calibrationBaseline(runtime: "mlx" | "gguf"): RankerParityBaseline {
  return {
    source: "calibration",
    referenceHash: rankerParityReferenceHash(),
    plan: rankerParityPlan(runtime),
    runtimeBuild: null,
    scores
  };
}
