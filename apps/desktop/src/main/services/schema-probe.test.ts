import { describe, expect, it, vi } from "vitest";

import {
  readSchemaProbeCalls,
  runSchemaProbe,
  schemaProbeContract,
  schemaProbeOutputSchema
} from "./schema-probe.js";

describe("MEMORA_GOLDEN_SCHEMA_PROBE", () => {
  it("is off unless set, and takes 1 to 20 calls", () => {
    expect(readSchemaProbeCalls({})).toBeNull();
    expect(readSchemaProbeCalls({ MEMORA_GOLDEN_SCHEMA_PROBE: "  " })).toBeNull();
    expect(readSchemaProbeCalls({ MEMORA_GOLDEN_SCHEMA_PROBE: "12" })).toBe(12);
    for (const value of ["0", "21", "-1", "1.5", "many"])
      expect(() => readSchemaProbeCalls({ MEMORA_GOLDEN_SCHEMA_PROBE: value })).toThrow(
        "MEMORA_GOLDEN_SCHEMA_PROBE must be an integer from 1 to 20"
      );
  });
});

describe("the probe's strict schema", () => {
  it("is the contract's own closed object, named for the provider", () => {
    expect(schemaProbeOutputSchema).toEqual({
      name: "schema_probe_verdict",
      strict: true,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["same", "different"] },
          reason: { type: "string" }
        },
        required: ["verdict", "reason"],
        additionalProperties: false
      }
    });
    expect(schemaProbeContract.safeParse({ verdict: "same", reason: "x" }).success).toBe(true);
  });
});

describe("runSchemaProbe", () => {
  const result = (output: string, extra: Record<string, unknown> = {}) => ({
    output,
    schemaMode: "strict",
    inputTokens: 100,
    outputTokens: 10,
    ...extra
  });

  it("states the strict schema on every call and counts what comes back", async () => {
    const calls: Array<{ prompt: string; context: Record<string, unknown> }> = [];
    const answers = [
      result('{"verdict":"same","reason":"They match."}'),
      // Valid JSON that breaks the contract, and a stray character the parser recovers from.
      result('{"verdict":"maybe","reason":"x"}'),
      result('{"verdict":"different","reason":"y"})'),
      result('{"verdict":"same","reason":"z"}', {
        schemaMode: "none",
        requestOptions: { schemaFallback: "refused" }
      })
    ];
    const ai = {
      runDefaultTask: vi.fn(async (_task: string, prompt: string, context: unknown) => {
        calls.push({ prompt, context: context as Record<string, unknown> });
        return answers.shift() as never;
      })
    };
    const report = await runSchemaProbe({ ai, calls: 4 });
    expect(report).toEqual({
      calls: 4,
      answered: 4,
      valid: 3,
      invalid: 1,
      failed: 0,
      schemaModes: { strict: 3, none: 1 },
      schemaFallbacks: 1,
      inputTokens: 400,
      outputTokens: 40,
      errors: []
    });
    expect(ai.runDefaultTask.mock.calls.every(([task]) => task === "structured-output")).toBe(true);
    for (const { context } of calls)
      expect(context).toMatchObject({
        operation: "schema_probe",
        outputSchema: schemaProbeOutputSchema
      });
    // Synthetic statements only, and every prompt is its own request.
    expect(new Set(calls.map((call) => call.prompt)).size).toBe(4);
  });

  it("makes a repeated pair a new request in a later round", async () => {
    const prompts: string[] = [];
    const ai = {
      runDefaultTask: vi.fn(async (_task: string, prompt: string) => {
        prompts.push(prompt);
        return result('{"verdict":"same","reason":"x"}') as never;
      })
    };
    await runSchemaProbe({ ai, calls: 7 });
    expect(new Set(prompts).size).toBe(7);
  });

  it("counts a failed call and a missing route, and keeps the first error lines only", async () => {
    const ai = {
      runDefaultTask: vi
        .fn()
        .mockRejectedValueOnce(new Error("AI provider request failed (400).\nsecond line"))
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("third"))
        .mockRejectedValueOnce(new Error("fourth"))
        .mockResolvedValueOnce(result('{"verdict":"same","reason":"x"}'))
    };
    const report = await runSchemaProbe({ ai, calls: 5 });
    expect(report).toMatchObject({ calls: 5, answered: 1, valid: 1, failed: 4 });
    expect(report.errors).toEqual([
      "AI provider request failed (400).",
      "no route serves structured output",
      "third"
    ]);
  });
});
