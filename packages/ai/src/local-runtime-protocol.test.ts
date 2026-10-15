import { describe, expect, it } from "vitest";

import {
  mlxHelperMessageSchema,
  mlxHelperRequestSchema,
  parseMlxHelperOutput
} from "./local-runtime-protocol.js";

const requestId = "d1b64150-63cc-4e0d-93a4-fd8560d80b2a";

describe("mlxHelperMessageSchema", () => {
  it("disables model thinking by default and accepts an explicit opt-in", () => {
    const base = {
      protocolVersion: 1 as const,
      requestId,
      command: "generate" as const,
      modelPath: "/managed/model",
      prompt: "Reply with exactly: OK"
    };
    expect(mlxHelperRequestSchema.parse(base)).toMatchObject({
      command: "generate",
      parameters: { enableThinking: false }
    });
    expect(
      mlxHelperRequestSchema.parse({
        ...base,
        parameters: {
          maxTokens: 4,
          temperature: 0.7,
          topP: 0.8,
          topK: 20,
          presencePenalty: 1.5,
          enableThinking: true
        }
      })
    ).toMatchObject({
      command: "generate",
      parameters: { topP: 0.8, topK: 20, presencePenalty: 1.5, enableThinking: true }
    });
  });

  it("accepts successful and failed result messages with the same kind", () => {
    const success = mlxHelperMessageSchema.parse({
      protocolVersion: 1,
      requestId: requestId.toUpperCase(),
      kind: "result",
      ok: true,
      output: "OK",
      inputTokens: 5,
      outputTokens: 1,
      durationMs: 12
    });
    const failure = mlxHelperMessageSchema.parse({
      protocolVersion: 1,
      requestId,
      kind: "result",
      ok: false,
      error: {
        code: "loadFailed",
        messageKey: "errors.localModels.runtimeFailed",
        recoverable: true
      }
    });

    expect(success).toMatchObject({ requestId, kind: "result", ok: true });
    expect(failure).toMatchObject({ kind: "result", ok: false });
  });

  it("continues to validate progress messages strictly", () => {
    expect(
      mlxHelperMessageSchema.parse({
        protocolVersion: 1,
        requestId,
        kind: "progress",
        progress: 0.65,
        messageKey: "localModels.progress.generating"
      })
    ).toMatchObject({ kind: "progress", progress: 0.65 });

    expect(() =>
      mlxHelperMessageSchema.parse({
        protocolVersion: 1,
        requestId,
        kind: "result",
        ok: true,
        output: "OK"
      })
    ).toThrow();
  });

  it("ignores native MLX diagnostics outside the JSONL protocol", () => {
    const messages = parseMlxHelperOutput(
      [
        "MLX error: diagnostic emitted by the native runtime",
        JSON.stringify({
          protocolVersion: 1,
          requestId,
          kind: "result",
          ok: true,
          output: "OK",
          durationMs: 12
        })
      ].join("\n")
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "result", ok: true, output: "OK" });
  });

  it("rejects JSON values that do not conform to the helper protocol", () => {
    expect(() =>
      parseMlxHelperOutput(
        JSON.stringify({
          protocolVersion: 1,
          requestId,
          kind: "unexpected"
        })
      )
    ).toThrow();
  });
});

const timing = {
  loadMs: 0,
  modelCached: true,
  tokenizeMs: 0.4,
  inferenceMs: 59.8,
  perItemMs: 29.9,
  totalMs: 60.6,
  batches: [{ size: 2, sequenceLength: 108, ms: 59.8 }]
};

describe("embed and score requests", () => {
  it("accepts the documented embed request and rejects unknown or out-of-range fields", () => {
    const base = {
      protocolVersion: 1 as const,
      requestId,
      command: "embed" as const,
      modelPath: "/abs/Qwen3-Embedding-0.6B",
      texts: ["a", "b"]
    };

    expect(
      mlxHelperRequestSchema.parse({
        ...base,
        normalize: true,
        dimensions: 1_024,
        maxTokens: 8_192,
        batchSize: 16
      })
    ).toMatchObject({ command: "embed", texts: ["a", "b"], dimensions: 1_024 });
    expect(() => mlxHelperRequestSchema.parse({ ...base, texts: [] })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...base, texts: [""] })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...base, batchSize: 513 })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...base, maxTokens: 1 })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...base, unknown: true })).toThrow();
  });

  it("accepts a score request as one query with documents or as explicit pairs, never both", () => {
    const base = {
      protocolVersion: 1 as const,
      requestId,
      command: "score" as const,
      modelPath: "/abs/Qwen3-Reranker-0.6B"
    };
    const documents = { ...base, query: "q", documents: ["d1", "d2"], batchSize: 16 };
    const pairs = {
      ...base,
      instruction: "Judge relevance",
      pairs: [{ query: "q", document: "d", instruction: "other" }]
    };

    expect(mlxHelperRequestSchema.parse(documents)).toMatchObject({ command: "score" });
    expect(mlxHelperRequestSchema.parse(pairs)).toMatchObject({ command: "score" });
    expect(() => mlxHelperRequestSchema.parse({ ...documents, pairs: pairs.pairs })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...pairs, query: "q" })).toThrow();
    expect(() => mlxHelperRequestSchema.parse(base)).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...base, documents: ["d"] })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...documents, documents: [] })).toThrow();
    expect(() => mlxHelperRequestSchema.parse({ ...documents, maxTokens: 32 })).toThrow();
  });
});

describe("embed and score results", () => {
  it("accepts the helper's embed result with an uppercase request ID", () => {
    const message = mlxHelperMessageSchema.parse({
      protocolVersion: 1,
      requestId: requestId.toUpperCase(),
      kind: "result",
      ok: true,
      durationMs: 717,
      inputTokens: 6,
      embeddings: [
        [0.6, 0.8],
        [0.8, 0.6]
      ],
      dimensions: 2,
      normalized: true,
      pooling: "last",
      tokenCounts: [3, 3],
      truncated: [false, true],
      timing
    });

    expect(message).toMatchObject({ requestId, dimensions: 2, pooling: "last" });
  });

  it("accepts the helper's score result", () => {
    const message = mlxHelperMessageSchema.parse({
      protocolVersion: 1,
      requestId,
      kind: "result",
      ok: true,
      durationMs: 61,
      inputTokens: 193,
      scores: [0.99951, 0.0000047],
      logOdds: [7.625, -12.277],
      yesTokenId: 9693,
      noTokenId: 2152,
      tokenCounts: [85, 108],
      truncated: [false, false],
      timing
    });

    expect(message).toMatchObject({ logOdds: [7.625, -12.277], yesTokenId: 9693 });
  });

  it("rejects results whose lengths or shape disagree", () => {
    const embed = {
      protocolVersion: 1,
      requestId,
      kind: "result",
      ok: true,
      durationMs: 1,
      inputTokens: 3,
      embeddings: [[0.6, 0.8]],
      dimensions: 2,
      normalized: true,
      pooling: "mean",
      tokenCounts: [3],
      truncated: [false],
      timing
    };
    const score = {
      protocolVersion: 1,
      requestId,
      kind: "result",
      ok: true,
      durationMs: 1,
      inputTokens: 3,
      scores: [0.5],
      logOdds: [0],
      yesTokenId: 1,
      noTokenId: 2,
      tokenCounts: [3],
      truncated: [false],
      timing
    };

    expect(() => mlxHelperMessageSchema.parse(embed)).not.toThrow();
    expect(() => mlxHelperMessageSchema.parse(score)).not.toThrow();
    expect(() => mlxHelperMessageSchema.parse({ ...embed, dimensions: 3 })).toThrow();
    expect(() => mlxHelperMessageSchema.parse({ ...embed, tokenCounts: [3, 3] })).toThrow();
    expect(() => mlxHelperMessageSchema.parse({ ...embed, pooling: "attention" })).toThrow();
    expect(() => mlxHelperMessageSchema.parse({ ...score, logOdds: [0, 1] })).toThrow();
    expect(() => mlxHelperMessageSchema.parse({ ...score, scores: [1.5] })).toThrow();
    expect(() => mlxHelperMessageSchema.parse({ ...score, extra: 1 })).toThrow();
    expect(() =>
      mlxHelperMessageSchema.parse({ ...score, timing: { ...timing, extra: 1 } })
    ).toThrow();
  });
});
