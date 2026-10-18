import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTextDeltaStream,
  runsStreaming,
  type AiProgressEvent,
  type AiTaskRequest
} from "./contracts.js";
import { GoogleGeminiAdapter } from "./google.js";
import {
  MlxAdapter,
  mlxAnswerStream,
  NodeLlamaCppAdapter,
  reportGeneratedChunk,
  stripThinkingOutput
} from "./local-adapters.js";
import { OpenAiCodexAdapter } from "./openai-codex.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { AiRuntimeConfigInput } from "./remote-execution.js";

// F3 D22: the adapters that stream emit the answer text, and only the answer text, as
// `{kind: "text", delta}` events beside their progress events.

const encoder = new TextEncoder();
const request: AiTaskRequest = {
  taskType: "text-generation",
  input: "hello",
  requiredCapabilities: [],
  parameters: { maxTokens: 64 },
  metadata: {}
};
const events = (...payloads: unknown[]) =>
  payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
const sse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
/** A stream that delivers `first`, then neither ends nor fails (a provider that went silent). */
const silentAfter = (first: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first));
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
const runtime = (): AiRuntimeConfigInput => ({
  retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400 }
});

const openAi = (fetch: typeof globalThis.fetch) =>
  new OpenAiCompatibleAdapter({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    modelId: "model",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(),
    random: () => 0.5
  });
const codex = (fetch: typeof globalThis.fetch) =>
  new OpenAiCodexAdapter({
    accessToken: "oauth-access-token",
    accountId: "account-1",
    modelId: "gpt-test",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(),
    random: () => 0.5
  });
const google = (fetch: typeof globalThis.fetch) =>
  new GoogleGeminiAdapter({
    apiKey: "google-secret-key",
    modelId: "gemini-test",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(),
    random: () => 0.5
  });

/** The text events among everything a streamed call reported. */
const textOf = (seen: AiProgressEvent[]) =>
  seen.flatMap((event) => (event.kind === "text" ? [event] : []));
const wordsOf = (seen: AiProgressEvent[]) => textOf(seen).map((event) => event.delta);

describe("the answer text of a streamed call", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is streamed by an OpenAI-compatible server piece by piece, and never its reasoning", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse(
          events(
            { choices: [{ delta: { reasoning_content: "thinking about it" } }] },
            { choices: [{ delta: { reasoning: "more thinking" } }] },
            { choices: [{ delta: { content: "The first " } }] },
            { choices: [{ delta: { content: "" } }] },
            { choices: [{ delta: { content: "note." } }] },
            { usage: { prompt_tokens: 1, completion_tokens: 2 } }
          ) + "data: [DONE]\n\n"
        )
      );
    const seen: AiProgressEvent[] = [];
    const result = await openAi(fetch).runStreaming(request, undefined, (event) =>
      seen.push(event)
    );
    expect(wordsOf(seen)).toEqual(["The first ", "note."]);
    expect(result.output).toBe("The first note.");
    // Text events carry no progress; the progress events are untouched and still end at 1.
    expect(textOf(seen).every((event) => !("progress" in event))).toBe(true);
    expect(seen.filter((event) => event.kind !== "text").at(-1)).toMatchObject({ progress: 1 });
  });

  it("is streamed by ChatGPT/Codex from the answer deltas only", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sse(
        events(
          { type: "response.created" },
          { type: "response.reasoning_summary_text.delta", delta: "Considering the notes" },
          { type: "response.reasoning_text.delta", delta: "more reasoning" },
          { type: "response.output_text.delta", delta: "Both notes " },
          { type: "response.output_text.delta", delta: "agree." },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 2 } }
          }
        )
      )
    );
    const seen: AiProgressEvent[] = [];
    const result = await codex(fetch).runStreaming(request, undefined, (event) => seen.push(event));
    expect(wordsOf(seen)).toEqual(["Both notes ", "agree."]);
    expect(result.output).toBe("Both notes agree.");
  });

  it("is streamed by Gemini without its thought summaries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sse(
        events(
          {
            candidates: [{ content: { parts: [{ text: "Weighing both notes", thought: true }] } }]
          },
          { candidates: [{ content: { parts: [{ text: "The notes " }] } }] },
          {
            candidates: [
              {
                content: { parts: [{ text: "hidden thought", thought: true }, { text: "agree." }] }
              }
            ]
          },
          { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } }
        )
      )
    );
    const seen: AiProgressEvent[] = [];
    const result = await google(fetch).runStreaming(request, undefined, (event) =>
      seen.push(event)
    );
    expect(wordsOf(seen)).toEqual(["The notes ", "agree."]);
    expect(result.output).toBe("The notes agree.");
  });

  it("marks the first piece of a retried attempt, so the text of the attempt that failed is void", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        silentAfter(events({ choices: [{ delta: { content: "The first att" } }] }))
      )
      .mockResolvedValue(
        sse(
          events(
            { choices: [{ delta: { content: "The second " } }] },
            { choices: [{ delta: { content: "attempt." } }] }
          ) + "data: [DONE]\n\n"
        )
      );
    const seen: AiProgressEvent[] = [];
    const result = openAi(fetch).runStreaming(request, undefined, (event) => seen.push(event));
    await vi.advanceTimersByTimeAsync(20_050);
    await expect(result).resolves.toMatchObject({ output: "The second attempt." });
    expect(textOf(seen)).toEqual([
      { kind: "text", delta: "The first att" },
      { kind: "text", delta: "The second ", restart: true },
      { kind: "text", delta: "attempt." }
    ]);
    // What a listener that follows the protocol shows: the second attempt alone.
    let shown = "";
    for (const event of textOf(seen)) shown = (event.restart ? "" : shown) + event.delta;
    expect(shown).toBe("The second attempt.");
  });

  it("is not streamed by a call that does not stream", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ choices: [{ message: { content: "answer" } }] }));
    await expect(openAi(fetch).run(request)).resolves.toMatchObject({ output: "answer" });
  });

  it("has a helper that sends nothing for empty text and nobody to hear it", () => {
    const seen: AiProgressEvent[] = [];
    const stream = createTextDeltaStream((event) => seen.push(event));
    stream.delta("");
    stream.attempt();
    stream.delta("a");
    stream.attempt();
    stream.delta("b");
    stream.delta("c");
    expect(seen).toEqual([
      { kind: "text", delta: "a" },
      { kind: "text", delta: "b", restart: true },
      { kind: "text", delta: "c" }
    ]);
    expect(() => createTextDeltaStream(undefined).delta("x")).not.toThrow();
  });
});

describe("the answer text of a local call", () => {
  const base = { modelId: "local-test", modelPath: "/managed/model" };

  it("reports a GGUF chunk as text and then as progress", () => {
    const seen: AiProgressEvent[] = [];
    reportGeneratedChunk((event) => seen.push(event), "The notes ", 10, 100);
    reportGeneratedChunk((event) => seen.push(event), "", 10, 100);
    expect(seen).toEqual([
      { kind: "text", delta: "The notes " },
      { progress: 0.025 },
      // An empty chunk is progress only.
      { progress: 0.025 }
    ]);
    expect(() => reportGeneratedChunk(undefined, "x", 1, 1)).not.toThrow();
  });

  it("passes the text a GGUF executor streams on to the caller", async () => {
    const adapter = new NodeLlamaCppAdapter(
      { ...base, capabilities: ["text-generation", "supports-progress-events"] },
      async (input) => {
        input.onProgress?.({ kind: "text", delta: "Local " });
        input.onProgress?.({ kind: "text", delta: "text." });
        return { output: "Local text.", inputTokens: 1, outputTokens: 2, durationMs: 1 };
      }
    );
    expect(runsStreaming(adapter, "text-generation")).toBe(true);
    const seen: AiProgressEvent[] = [];
    const result = await adapter.runStreaming(request, undefined, (event) => seen.push(event));
    expect(wordsOf(seen)).toEqual(["Local ", "text."]);
    expect(result.output).toBe("Local text.");
  });

  it("streams the MLX helper's delta lines as text events, the answer only (T61)", async () => {
    const pieces = ["Thinking Process:\nprivate", "\n</think>\n\n", "mlx ", "answer"];
    const executions: Array<Record<string, unknown>> = [];
    const adapter = new MlxAdapter(
      {
        ...base,
        capabilities: ["text-generation", "supports-progress-events"],
        helperPath: "/managed/helper"
      },
      async (input) => {
        executions.push({ stream: Boolean(input.onDelta), stallMs: input.stallMs });
        input.onProgress?.({ progress: 0.65, messageKey: "localModels.progress.generating" });
        for (const piece of pieces) input.onDelta?.(piece);
        return { output: pieces.join(""), durationMs: 3 };
      }
    );
    expect(runsStreaming(adapter, "text-generation")).toBe(true);
    const seen: AiProgressEvent[] = [];
    const result = await adapter.runStreaming(
      { ...request, parameters: { maxTokens: 64, reasoningLevel: "low" } },
      undefined,
      (event) => seen.push(event)
    );
    // The reasoning before `</think>` never leaves; the answer's leading whitespace neither.
    expect(wordsOf(seen)).toEqual(["mlx ", "answer"]);
    expect(wordsOf(seen).join("")).toBe(result.output);
    expect(result.output).toBe("mlx answer");
    expect(seen).toContainEqual({ progress: 0.65, messageKey: "localModels.progress.generating" });
    expect(executions).toEqual([{ stream: true, stallMs: 60_000 }]);
    // Without streaming the same text comes back whole.
    expect((await adapter.run(request)).output).toBe("mlx answer");
    expect(executions[1]).toEqual({ stream: false, stallMs: undefined });
    expect(stripThinkingOutput("a</think> b")).toBe("b");
  });

  it("holds an MLX answer back only while it may be a reasoning block", () => {
    const off = mlxAnswerStream(false);
    expect([off.push("  <th"), off.push("ink>plan"), off.push("</think> Yes"), off.end()]).toEqual([
      "",
      "",
      "Yes",
      ""
    ]);
    const plain = mlxAnswerStream(false);
    expect([plain.push(" <"), plain.push("b>bold"), plain.push(" text"), plain.end()]).toEqual([
      "",
      "<b>bold",
      " text",
      ""
    ]);
    // Thinking on: the template opens the block in the prompt, so nothing streams before `</think>`.
    const on = mlxAnswerStream(true);
    expect([on.push("reasoning "), on.push("more"), on.end()]).toEqual(["", "", "reasoning more"]);
  });
});
