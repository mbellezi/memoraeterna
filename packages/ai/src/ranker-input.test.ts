import { describe, expect, it } from "vitest";

import {
  LocalRankerError,
  parseRankInput,
  parseRankPairsRequest,
  parseRankRequest,
  probabilityLogOdds,
  rankInputCount,
  rankPairsLimits,
  rankPairsTaskRequest,
  rankRequestLimits,
  rankRequestSchema,
  rankTaskRequest,
  readRankPairsParameters,
  readRankResult,
  serializeRankPairsRequest,
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

const pairsRequest = {
  instruction: "Decide whether the two notes link.",
  pairs: [
    { query: "Title: A\nIdea: One.", document: "Title: B\nIdea: Two." },
    { query: "Title: B\nIdea: Two.", document: "Title: A\nIdea: One." }
  ]
};

describe("rank request contract of the topic gate", () => {
  it("serializes the {query, documents} request byte for byte as F2 did", () => {
    // The recorded gate entries of the F2 cassettes are keyed by this exact input and no parameters.
    expect(rankTaskRequest(request)).toStrictEqual({
      taskType: "reranking",
      input:
        '{"instruction":"Decide whether the Document is about the Query\'s topic.",' +
        '"query":"Title: Photosynthesis\\nIdea: Light becomes chemical energy.",' +
        '"documents":["Topic: Plant biology","Topic: Football leagues"]}',
      requiredCapabilities: ["reranking"],
      parameters: {},
      metadata: {}
    });
  });

  it("refuses a pairs input as a documents request", () => {
    expect(() => parseRankRequest(JSON.stringify(pairsRequest))).toThrow(
      "errors.ai.unsupportedTask"
    );
  });
});

describe("rank pairs request contract", () => {
  it("round-trips through the task input string and keeps the text as given", () => {
    const task = rankPairsTaskRequest(pairsRequest);

    expect(task).toMatchObject({
      taskType: "reranking",
      requiredCapabilities: ["reranking"],
      parameters: {},
      metadata: {}
    });
    expect(parseRankPairsRequest(task.input)).toEqual(pairsRequest);
    expect(parseRankPairsRequest(pairsRequest)).toEqual(pairsRequest);
    expect(serializeRankPairsRequest(pairsRequest)).toBe(JSON.stringify(pairsRequest));
    expect(
      parseRankPairsRequest({
        ...pairsRequest,
        pairs: [{ query: "  padded  ", document: "doc" }]
      }).pairs[0]!.query
    ).toBe("  padded  ");
  });

  it("carries the helper batch size in the parameters, not in the input", () => {
    const batch1 = rankPairsTaskRequest(pairsRequest, { batchSize: 1 });
    const batch16 = rankPairsTaskRequest(pairsRequest, { batchSize: 16 });

    expect(batch1.parameters).toEqual({ batchSize: 1 });
    expect(batch16.parameters).toEqual({ batchSize: 16 });
    expect(batch1.input).toBe(batch16.input);
    expect(readRankPairsParameters(batch16.parameters)).toEqual({ batchSize: 16 });
    expect(readRankPairsParameters({})).toEqual({});
  });

  it("refuses an invalid batch size and any other parameter", () => {
    for (const batchSize of [0, -1, 1.5, rankPairsLimits.maxHelperBatchSize + 1]) {
      expect(() => rankPairsTaskRequest(pairsRequest, { batchSize })).toThrow(
        "errors.ai.unsupportedTask"
      );
    }
    expect(() => readRankPairsParameters({ temperature: 0.2 })).toThrow(
      "errors.ai.unsupportedTask"
    );
  });

  it("refuses blank text, no pairs, too many pairs, unknown keys and a documents request", () => {
    const bad: unknown[] = [
      { ...pairsRequest, instruction: " " },
      { ...pairsRequest, instruction: "uses {{query}}" },
      { ...pairsRequest, pairs: [] },
      { ...pairsRequest, pairs: [{ query: " ", document: "x" }] },
      { ...pairsRequest, pairs: [{ query: "x", document: "" }] },
      {
        ...pairsRequest,
        pairs: Array.from({ length: rankPairsLimits.maxPairs + 1 }, () => pairsRequest.pairs[0])
      },
      { ...pairsRequest, pairs: [{ query: "x", document: "y", instruction: "z" }] },
      { ...pairsRequest, extra: true },
      request,
      "not json {"
    ];
    for (const input of bad) {
      expect(() => parseRankPairsRequest(input)).toThrow("errors.ai.unsupportedTask");
    }
    expect(() =>
      parseRankPairsRequest({
        ...pairsRequest,
        pairs: [{ query: "x".repeat(rankRequestLimits.maxTextCharacters + 1), document: "y" }]
      })
    ).toThrow("errors.ai.unsupportedTask");
  });

  it("selects the wire shape of an input by its pairs and counts its scores", () => {
    const documents = parseRankInput(rankTaskRequest(request).input);
    const pairs = parseRankInput(rankPairsTaskRequest(pairsRequest).input);

    expect(documents.kind).toBe("documents");
    expect(rankInputCount(documents)).toBe(2);
    expect(pairs.kind).toBe("pairs");
    expect(rankInputCount(pairs)).toBe(2);
    expect(() =>
      parseRankInput(JSON.stringify({ instruction: "x", query: "q", pairs: [] }))
    ).toThrow("errors.ai.unsupportedTask");
  });

  it("keeps the per-runtime call sizes under the bound and the P0 budget", () => {
    expect(rankPairsLimits.perCall).toEqual({ mlx: 32, gguf: 16 });
    expect(rankPairsLimits.perCall.mlx).toBeLessThanOrEqual(rankPairsLimits.maxPairs);
    expect(rankPairsLimits.helperBatchSize).toBe(16);
    // The documents request keeps its F2 bound.
    expect(rankRequestLimits.maxDocuments).toBe(32);
  });
});
