import { describe, expect, it } from "vitest";

import {
  LocalRankerError,
  parseRankRequest,
  probabilityLogOdds,
  rankRequestLimits,
  rankRequestSchema,
  rankTaskRequest,
  readRankResult,
  serializeRankRequest
} from "./ranker-input.js";

const request = {
  instruction: "Decide whether the Document is about the Query's topic.",
  query: "Title: Photosynthesis\nIdea: Light becomes chemical energy.",
  documents: ["Topic: Plant biology", "Topic: Football leagues"]
};

describe("rank request contract", () => {
  it("round-trips a rank request through the task input string", () => {
    const task = rankTaskRequest(request);

    expect(task).toMatchObject({ taskType: "reranking", requiredCapabilities: ["reranking"] });
    expect(typeof task.input).toBe("string");
    expect(parseRankRequest(task.input)).toEqual(request);
    expect(parseRankRequest(request)).toEqual(request);
    expect(serializeRankRequest(request)).toBe(JSON.stringify(request));
  });

  it("keeps the text exactly as given, without trimming", () => {
    const spaced = { ...request, query: "  leading and trailing  " };
    expect(parseRankRequest(JSON.stringify(spaced)).query).toBe("  leading and trailing  ");
  });

  it("refuses prompts, blank text, template placeholders and oversized requests as unsupported", () => {
    const refusals = [
      "Decide which candidate notes are related. Answer in JSON.",
      JSON.stringify({ ...request, documents: [] }),
      JSON.stringify({
        ...request,
        documents: Array.from({ length: rankRequestLimits.maxDocuments + 1 }, () => "doc")
      }),
      JSON.stringify({ ...request, query: " \n\t " }),
      JSON.stringify({ ...request, instruction: "Rank {{document}} for {{query}}" }),
      JSON.stringify({ ...request, query: "x".repeat(rankRequestLimits.maxTextCharacters + 1) }),
      JSON.stringify({ ...request, extra: true })
    ];
    for (const input of refusals) {
      expect(() => parseRankRequest(input)).toThrow(LocalRankerError);
      expect(() => parseRankRequest(input)).toThrow("errors.ai.unsupportedTask");
    }
    expect(
      rankRequestSchema.safeParse({
        ...request,
        documents: Array.from({ length: rankRequestLimits.maxDocuments }, () => "doc")
      }).success
    ).toBe(true);
  });

  it("accepts only a result that scores every document with agreeing lengths", () => {
    const result = {
      logOdds: [2, -3],
      scores: [0.88, 0.05],
      tokenCounts: [120, 98],
      truncated: [false, true]
    };

    expect(readRankResult({ output: result }, 2)).toEqual(result);
    for (const output of [
      { ...result, scores: [0.88] },
      { ...result, logOdds: [2, Number.POSITIVE_INFINITY] },
      { ...result, scores: [1.2, 0.1] },
      "not a result"
    ]) {
      expect(() => readRankResult({ output }, 2)).toThrow(
        "errors.localModels.invalidRuntimeResponse"
      );
    }
    expect(() => readRankResult({ output: result }, 3)).toThrow(
      "errors.localModels.invalidRuntimeResponse"
    );
  });

  it("turns probabilities into finite, clamped log-odds", () => {
    expect(probabilityLogOdds(0.5)).toBe(0);
    expect(probabilityLogOdds(0.9)).toBeCloseTo(Math.log(9), 12);
    expect(probabilityLogOdds(1)).toBeCloseTo(16.118, 3);
    expect(probabilityLogOdds(0)).toBeCloseTo(-16.118, 3);
    expect(probabilityLogOdds(0.25)).toBeCloseTo(-probabilityLogOdds(0.75), 12);
  });
});
