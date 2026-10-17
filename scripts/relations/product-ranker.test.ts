import { describe, expect, it } from "vitest";

import type { AiTaskRequest, AiTaskResult } from "../../packages/ai/src/contracts.js";
import {
  parseRankPairsRequest,
  rankPairsLimits,
  rankPairsTaskRequest
} from "../../packages/ai/src/ranker-input.js";
import { rankThroughAdapter } from "./product-ranker.ts";

const pairs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    query: `query ${index}`,
    document: `document ${index}`
  }));

function fakeAdapter(failOnCall?: number) {
  const requests: AiTaskRequest[] = [];
  return {
    requests,
    async run(request: AiTaskRequest): Promise<AiTaskResult> {
      requests.push(request);
      if (requests.length === failOnCall) throw new Error("the helper crashed");
      const input = parseRankPairsRequest(request.input);
      const logOdds = input.pairs.map((pair) => Number(/\d+/u.exec(pair.query)![0]) / 10);
      return {
        taskType: "reranking",
        output: {
          logOdds,
          scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
          tokenCounts: logOdds.map(() => 100),
          truncated: logOdds.map((_, index) => index === 0)
        },
        providerId: "local",
        modelId: "m",
        runtime: "local",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costEstimate: 0
      } as AiTaskResult;
    }
  };
}

describe("scoring through the product adapter", () => {
  it("splits the pairs into the calls AiService.rankPairs makes, with the same request on the wire", async () => {
    const adapter = fakeAdapter();
    const plan = {
      perCall: rankPairsLimits.perCall.mlx,
      helperBatchSize: rankPairsLimits.helperBatchSize
    };
    const progress: number[] = [];
    const scored = await rankThroughAdapter(adapter, plan, "An instruction.", pairs(70), (done) =>
      progress.push(done)
    );
    expect(
      adapter.requests.map((request) => parseRankPairsRequest(request.input).pairs.length)
    ).toEqual([32, 32, 6]);
    expect(adapter.requests[0]).toEqual(
      rankPairsTaskRequest(
        parseRankPairsRequest({ instruction: "An instruction.", pairs: pairs(70).slice(0, 32) }),
        { batchSize: 16 }
      )
    );
    expect(adapter.requests[2]!.parameters).toEqual({ batchSize: 16 });
    // Scores come back in pair order, one per pair.
    expect(scored.logOdds).toEqual(Array.from({ length: 70 }, (_, index) => index / 10));
    expect(scored.calls).toBe(3);
    expect(scored.callMs).toHaveLength(3);
    expect(scored.truncated).toBe(3);
    expect(scored.tokenCounts).toHaveLength(70);
    expect(progress).toEqual([32, 64, 70]);
  });

  it("sends GGUF calls of 16 pairs and no helper batch", async () => {
    const adapter = fakeAdapter();
    await rankThroughAdapter(
      adapter,
      { perCall: rankPairsLimits.perCall.gguf, helperBatchSize: null },
      "An instruction.",
      pairs(33)
    );
    expect(
      adapter.requests.map((request) => parseRankPairsRequest(request.input).pairs.length)
    ).toEqual([16, 16, 1]);
    expect(adapter.requests.every((request) => Object.keys(request.parameters).length === 0)).toBe(
      true
    );
  });

  it("fails on a call that does not score every pair", async () => {
    await expect(
      rankThroughAdapter(
        fakeAdapter(2),
        { perCall: 2, helperBatchSize: null },
        "An instruction.",
        pairs(5)
      )
    ).rejects.toThrow("the helper crashed");
  });
});
