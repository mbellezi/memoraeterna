import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toStrictJsonSchema, type AiOutputSchema } from "@app/domain";

import { aiTaskRequestSchema, type AiTaskRequest } from "./contracts.js";
import { GoogleGeminiAdapter } from "./google.js";
import { NodeLlamaCppAdapter, MlxAdapter } from "./local-adapters.js";
import { OpenAiCodexAdapter } from "./openai-codex.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { outputSchemaIdentity } from "./output-schema-identity.js";
import { remoteCallReport } from "./remote-execution.js";

const contract = z
  .object({ verdict: z.enum(["same", "different"]), reason: z.string().min(1) })
  .strict();
const outputSchema = toStrictJsonSchema(contract, "pair_verdict") as AiOutputSchema;
const wireSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["same", "different"] },
    reason: { type: "string" }
  },
  required: ["verdict", "reason"],
  additionalProperties: false
};

const request = (
  taskType: AiTaskRequest["taskType"] = "structured-output",
  withSchema = true
): AiTaskRequest => ({
  taskType,
  input: "decide",
  requiredCapabilities: [],
  parameters: {},
  metadata: {},
  ...(withSchema ? { outputSchema } : {})
});

const events = (...payloads: unknown[]) =>
  payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
const sse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const answer = '{"verdict":"same","reason":"x"}';
const payloadOf = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;
const refusal = (message: string, status = 400) =>
  Response.json({ error: { message, type: "invalid_request_error" } }, { status });
/** Two contracts of one model: the source judge's and a typing batch's (any batch size). */
const judgeSchema = toStrictJsonSchema(
  z.object({ items: z.array(z.array(z.string()).max(7)).max(12) }).strict(),
  "source_judge"
) as AiOutputSchema;
const typingSchema = (maxPairs: number) =>
  toStrictJsonSchema(
    z.object({ pairs: z.array(z.object({ type: z.string() }).strict()).max(maxPairs) }).strict(),
    "relation_typing"
  ) as AiOutputSchema;
const withSchema = (schema: AiOutputSchema): AiTaskRequest => ({
  ...request(),
  outputSchema: schema
});
const formatName = (payload: Record<string, unknown> | undefined) =>
  ((payload?.text as { format?: { name?: string } } | undefined)?.format?.name ??
    (payload?.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema
      ?.name) ||
  null;

describe("a refused schema's identity", () => {
  it("is the name and the body, whatever the order of its keys", () => {
    const reordered = {
      strict: outputSchema.strict,
      schema: Object.fromEntries(Object.entries(outputSchema.schema).reverse()),
      name: outputSchema.name
    };
    expect(outputSchemaIdentity(reordered)).toBe(outputSchemaIdentity(outputSchema));
    expect(outputSchemaIdentity(typingSchema(4))).not.toBe(outputSchemaIdentity(typingSchema(8)));
    expect(outputSchemaIdentity({ ...outputSchema, name: "other" })).not.toBe(
      outputSchemaIdentity(outputSchema)
    );
  });
});

describe("the request contract", () => {
  it("carries a strict output schema and rejects a malformed one", () => {
    expect(aiTaskRequestSchema.parse(request()).outputSchema).toEqual({
      name: "pair_verdict",
      strict: true,
      schema: wireSchema
    });
    expect(() =>
      aiTaskRequestSchema.parse({ ...request(), outputSchema: { name: "x y", schema: {} } })
    ).toThrow();
  });
});

describe("Codex text.format", () => {
  const codexEvents = (text: string) =>
    events(
      { type: "response.output_text.delta", delta: text },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } }
    );
  // The process remembers a refusal per base URL, model and schema, so every test uses its own backend.
  let backend = 0;
  const codex = (fetch: typeof globalThis.fetch) =>
    new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-5.6-terra",
      capabilities: ["structured-output", "streaming"],
      baseUrl: `https://schema-${(backend += 1)}.example.test/codex`,
      fetch,
      runtime: { retry: { maxAttempts: 3 } },
      random: () => 0.5
    });

  it("sends the schema as a strict json_schema format and reports the mode", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const adapter = codex(async (_input, init) => {
      payloads.push(payloadOf(init));
      return sse(codexEvents(answer));
    });
    const result = await adapter.run(request());
    expect(payloads[0]!.text).toEqual({
      format: { type: "json_schema", name: "pair_verdict", schema: wireSchema, strict: true },
      verbosity: "low"
    });
    expect(result).toMatchObject({
      output: answer,
      schemaMode: "strict",
      requestOptions: { schemaMode: "strict" }
    });
    expect(result.requestOptions).not.toHaveProperty("schemaFallback");
  });

  it("sends no format for a request without a schema, and says so only in the result", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const adapter = codex(async (_input, init) => {
      payloads.push(payloadOf(init));
      return sse(codexEvents(answer));
    });
    const result = await adapter.run(request("structured-output", false));
    expect(payloads[0]!.text).toEqual({ verbosity: "low" });
    expect(result.schemaMode).toBe("none");
    expect(result.requestOptions).not.toHaveProperty("schemaMode");
  });

  it("resends once without the format when it is refused, and remembers that per backend, model and schema", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Invalid schema for text.format 'pair_verdict': 'strict' is not supported."),
      sse(codexEvents("first")),
      sse(codexEvents("second")),
      sse(codexEvents("other model"))
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const adapter = codex(fetch);
    await expect(adapter.run(request())).resolves.toMatchObject({
      output: "first",
      schemaMode: "none",
      requestOptions: { schemaMode: "none", schemaFallback: "refused" },
      // The provider received both requests of that one call: a schema fallback, not a repair.
      attempts: 2
    });
    expect(payloads[0]!.text).toHaveProperty("format");
    expect(payloads[1]!.text).toEqual({ verbosity: "low" });
    // The next call of this process goes straight to the request the backend accepts.
    await expect(adapter.run(request())).resolves.toMatchObject({
      output: "second",
      requestOptions: { schemaMode: "none", schemaFallback: "refused_earlier" },
      attempts: 1
    });
    expect(payloads[2]!.text).toEqual({ verbosity: "low" });
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(adapter.run({ ...request(), modelId: "gpt-5.6-luna" })).resolves.toMatchObject({
      output: "other model",
      schemaMode: "strict"
    });
    expect(payloads[3]!.text).toHaveProperty("format");
  });

  it("keeps sending a model's other schemas after one is refused, and never re-sends the refused one", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Invalid schema for text.format 'source_judge': 'strict' is not supported."),
      sse(codexEvents("judged")),
      sse(codexEvents("typed")),
      sse(codexEvents("typed again")),
      sse(codexEvents("judged again"))
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const adapter = codex(fetch);
    await expect(adapter.run(withSchema(judgeSchema))).resolves.toMatchObject({
      output: "judged",
      requestOptions: { schemaMode: "none", schemaFallback: "refused" }
    });
    // A typing call on the same model is sent its strict format, at either batch size.
    for (const [maxPairs, output] of [
      [8, "typed"],
      [4, "typed again"]
    ] as const) {
      const typed = await adapter.run(withSchema(typingSchema(maxPairs)));
      expect(typed).toMatchObject({ output, schemaMode: "strict", attempts: 1 });
      expect(typed.requestOptions).not.toHaveProperty("schemaFallback");
    }
    expect(payloads.slice(2, 4).map(formatName)).toEqual(["relation_typing", "relation_typing"]);
    // The refused schema itself goes without the format at once.
    await expect(adapter.run(withSchema(judgeSchema))).resolves.toMatchObject({
      output: "judged again",
      requestOptions: { schemaMode: "none", schemaFallback: "refused_earlier" },
      attempts: 1
    });
    expect(payloads.map(formatName)).toEqual([
      "source_judge",
      null,
      "relation_typing",
      "relation_typing",
      null
    ]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("never falls back for a refusal that does not name the format", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      refusal("Request rejected for account policy")
    );
    const error = await codex(fetch)
      .run(request())
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("Request rejected for account policy");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(remoteCallReport(error)).toMatchObject({
      attempts: 1,
      requestOptions: { schemaMode: "strict" }
    });
  });

  it("falls back from both refused shapes in one call: the format first, then the lean decide shape", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Unsupported parameter: 'text.format'."),
      refusal("Unknown parameter: include"),
      sse(codexEvents(answer))
    ];
    const adapter = codex(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const result = await adapter.run({
      ...request("reranking"),
      parameters: { reasoningLevel: "low" }
    });
    expect(result).toMatchObject({ output: answer, attempts: 3, schemaMode: "none" });
    expect(payloads).toHaveLength(3);
    expect(payloads[2]!.text).toEqual({ verbosity: "low" });
    expect(payloads[2]).toHaveProperty("include");
  });
});

describe("OpenAI-compatible response_format", () => {
  let endpoint = 0;
  const adapter = (fetch: typeof globalThis.fetch) =>
    new OpenAiCompatibleAdapter({
      baseUrl: `https://schema-${(endpoint += 1)}.example.test/v1`,
      apiKey: "secret-key",
      modelId: "model",
      capabilities: ["structured-output", "streaming"],
      fetch,
      runtime: { retry: { maxAttempts: 3 } },
      random: () => 0.5
    });
  const completion = (text: string) =>
    Response.json({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 }
    });
  const chunks = (text: string) =>
    sse(events({ choices: [{ delta: { content: text } }] }, { usage: { prompt_tokens: 1 } }));

  it("sends json_schema strict and reports the mode", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const result = await adapter(async (_input, init) => {
      payloads.push(payloadOf(init));
      return completion(answer);
    }).run(request());
    expect(payloads[0]!.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "pair_verdict", schema: wireSchema, strict: true }
    });
    expect(result).toMatchObject({ output: answer, schemaMode: "strict" });
    expect(result.requestOptions).toMatchObject({ schemaMode: "strict" });
  });

  it("keeps json_object for a JSON task without a schema, and sends nothing for a text task", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const openAi = adapter(async (_input, init) => {
      payloads.push(payloadOf(init));
      return completion(answer);
    });
    await expect(openAi.run(request("structured-output", false))).resolves.toMatchObject({
      schemaMode: "json"
    });
    await expect(openAi.run(request("text-generation", false))).resolves.toMatchObject({
      schemaMode: "none"
    });
    expect(payloads[0]!.response_format).toEqual({ type: "json_object" });
    expect(payloads[1]).not.toHaveProperty("response_format");
  });

  it("falls back once to json_object on a 400 that names response_format, and remembers that", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Invalid parameter: 'response_format' of type 'json_schema' is not supported."),
      completion("first"),
      completion("second")
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const openAi = adapter(fetch);
    await expect(openAi.run(request())).resolves.toMatchObject({
      output: "first",
      schemaMode: "json",
      requestOptions: { schemaMode: "json", schemaFallback: "refused" },
      attempts: 2
    });
    expect(payloads[0]!.response_format).toHaveProperty("type", "json_schema");
    expect(payloads[1]!.response_format).toEqual({ type: "json_object" });
    await expect(openAi.run(request())).resolves.toMatchObject({
      output: "second",
      requestOptions: { schemaMode: "json", schemaFallback: "refused_earlier" },
      attempts: 1
    });
    expect(payloads[2]!.response_format).toEqual({ type: "json_object" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps sending a model's other schemas after one is refused, and never re-sends the refused one", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Invalid parameter: 'response_format' of type 'json_schema' is not supported."),
      completion("judged"),
      completion("typed"),
      completion("judged again")
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const openAi = adapter(fetch);
    await expect(openAi.run(withSchema(judgeSchema))).resolves.toMatchObject({
      output: "judged",
      requestOptions: { schemaMode: "json", schemaFallback: "refused" }
    });
    const typed = await openAi.run(withSchema(typingSchema(8)));
    expect(typed).toMatchObject({ output: "typed", schemaMode: "strict", attempts: 1 });
    expect(typed.requestOptions).not.toHaveProperty("schemaFallback");
    await expect(openAi.run(withSchema(judgeSchema))).resolves.toMatchObject({
      output: "judged again",
      requestOptions: { schemaMode: "json", schemaFallback: "refused_earlier" },
      attempts: 1
    });
    expect(payloads.map(formatName)).toEqual(["source_judge", null, "relation_typing", null]);
    expect(payloads[3]!.response_format).toEqual({ type: "json_object" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not fall back for a refusal that does not name the format", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => refusal("Unknown model"));
    await expect(adapter(fetch).run(request())).rejects.toThrow("Unknown model");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("streams with the schema, and drops stream_options and the format one at a time", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Unrecognized request argument supplied: stream_options"),
      refusal("response_format json_schema is not supported by this model"),
      chunks(answer)
    ];
    const openAi = adapter(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const result = await openAi.runStreaming(request(), undefined, () => undefined);
    expect(result).toMatchObject({
      output: answer,
      schemaMode: "json",
      requestOptions: { schemaMode: "json", schemaFallback: "refused" },
      attempts: 3
    });
    expect(payloads[0]).toHaveProperty("stream_options");
    expect(payloads[1]).not.toHaveProperty("stream_options");
    expect(payloads[1]!.response_format).toHaveProperty("type", "json_schema");
    expect(payloads[2]!.response_format).toEqual({ type: "json_object" });
  });
});

describe("Gemini responseJsonSchema", () => {
  const gemini = (fetch: typeof globalThis.fetch) =>
    new GoogleGeminiAdapter({
      apiKey: "google-secret-key",
      modelId: "gemini-test",
      capabilities: ["structured-output"],
      fetch,
      random: () => 0.5
    });

  it("sends the schema with the JSON mime type", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const result = await gemini(async (_input, init) => {
      payloads.push(payloadOf(init));
      return Response.json({ candidates: [{ content: { parts: [{ text: answer }] } }] });
    }).run(request());
    expect(payloads[0]!.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: wireSchema
    });
    expect(result.schemaMode).toBe("strict");
  });

  it("keeps the JSON mime type alone without a schema", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const result = await gemini(async (_input, init) => {
      payloads.push(payloadOf(init));
      return Response.json({ candidates: [{ content: { parts: [{ text: answer }] } }] });
    }).run(request("structured-output", false));
    expect(payloads[0]!.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(result.schemaMode).toBe("json");
  });
});

describe("local runtimes", () => {
  const capabilities = ["text-generation", "structured-output", "offline"] as const;

  it("hands a GGUF call the schema, which becomes a grammar, and reports the mode the runtime used", async () => {
    const seen: unknown[] = [];
    const adapter = new NodeLlamaCppAdapter(
      { modelId: "local", modelPath: "/models/local.gguf", capabilities: [...capabilities] },
      async (input) => {
        seen.push(input.outputSchema);
        return { output: answer, durationMs: 1, schemaMode: "grammar" };
      }
    );
    await expect(adapter.run(request())).resolves.toMatchObject({ schemaMode: "grammar" });
    expect(seen).toEqual([outputSchema]);
    // A runtime that could not compile the grammar says it ran without one.
    const unconstrained = new NodeLlamaCppAdapter(
      { modelId: "local", modelPath: "/models/local.gguf", capabilities: [...capabilities] },
      async () => ({ output: answer, durationMs: 1 })
    );
    await expect(unconstrained.run(request())).resolves.toMatchObject({ schemaMode: "none" });
  });

  it("hands an MLX call the schema (F4 D24), except with thinking on, and reports the helper's mode", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const mlx = (schemaMode?: "grammar") =>
      new MlxAdapter(
        {
          modelId: "mlx",
          modelPath: "/models/mlx",
          helperPath: "/helper",
          capabilities: [...capabilities]
        },
        async (input) => {
          inputs.push(input as unknown as Record<string, unknown>);
          return { output: answer, durationMs: 1, ...(schemaMode ? { schemaMode } : {}) };
        }
      );
    await expect(mlx("grammar").run(request())).resolves.toMatchObject({ schemaMode: "grammar" });
    expect(inputs[0]!.outputSchema).toEqual(outputSchema);
    // A helper that did not take the schema says nothing: the answer ran unconstrained.
    await expect(mlx().run(request())).resolves.toMatchObject({ schemaMode: "none" });
    const thinking = await mlx("grammar").run({
      ...request(),
      parameters: { ...request().parameters, reasoningLevel: "on" }
    });
    expect(inputs[2]).not.toHaveProperty("outputSchema");
    expect(thinking).toMatchObject({
      schemaMode: "none",
      requestOptions: { grammar: { refusal: "thinking" } }
    });
  });

  it("does not report a schema mode for an embedding", async () => {
    const adapter = new NodeLlamaCppAdapter(
      {
        modelId: "embedder",
        modelPath: "/models/embed.gguf",
        capabilities: ["embedding", "offline"]
      },
      undefined,
      async () => ({ output: [0.1, 0.2], durationMs: 1 })
    );
    const result = await adapter.run({
      taskType: "embedding",
      input: "text",
      requiredCapabilities: [],
      parameters: {},
      metadata: {}
    });
    expect(result).not.toHaveProperty("schemaMode");
  });
});
