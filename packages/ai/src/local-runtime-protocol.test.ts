import { describe, expect, it } from "vitest";

import { mlxHelperMessageSchema, mlxHelperRequestSchema, parseMlxHelperOutput } from "./local-runtime-protocol.js";

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
    expect(mlxHelperRequestSchema.parse({
      ...base,
      parameters: {
        maxTokens: 4,
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
        presencePenalty: 1.5,
        enableThinking: true
      }
    })).toMatchObject({
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
    expect(mlxHelperMessageSchema.parse({
      protocolVersion: 1,
      requestId,
      kind: "progress",
      progress: 0.65,
      messageKey: "localModels.progress.generating"
    })).toMatchObject({ kind: "progress", progress: 0.65 });

    expect(() => mlxHelperMessageSchema.parse({
      protocolVersion: 1,
      requestId,
      kind: "result",
      ok: true,
      output: "OK"
    })).toThrow();
  });

  it("ignores native MLX diagnostics outside the JSONL protocol", () => {
    const messages = parseMlxHelperOutput([
      "MLX error: diagnostic emitted by the native runtime",
      JSON.stringify({
        protocolVersion: 1,
        requestId,
        kind: "result",
        ok: true,
        output: "OK",
        durationMs: 12
      })
    ].join("\n"));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "result", ok: true, output: "OK" });
  });

  it("rejects JSON values that do not conform to the helper protocol", () => {
    expect(() => parseMlxHelperOutput(JSON.stringify({
      protocolVersion: 1,
      requestId,
      kind: "unexpected"
    }))).toThrow();
  });
});
