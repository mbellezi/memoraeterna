import { describe, expect, it } from "vitest";
import { normalizeTokenUsage } from "./token-usage.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { GoogleGeminiAdapter } from "./google.js";

describe("AI monitoring usage", () => {
  it("preserves breakdowns without adding cached or reasoning tokens twice", () => {
    const usage = normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 80, audio_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 30, accepted_prediction_tokens: 4 } });
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 80, reasoningTokens: 30,
      "provider.prompt_tokens_details.audio_tokens": 2, "provider.completion_tokens_details.accepted_prediction_tokens": 4 });
  });
  it("normalizes Responses usage and rejects unknown or invalid counters", () => {
    expect(normalizeTokenUsage({ input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 }, secret: "credential" }))
      .toMatchObject({ inputTokens: 20, outputTokens: 8, cachedInputTokens: 0, reasoningTokens: 4, totalTokens: 28 });
    expect(normalizeTokenUsage({ prompt_tokens: -1, completion_tokens: NaN, total_tokens: "100" })).toEqual({});
    expect(normalizeTokenUsage(undefined)).toEqual({});
  });
  it("normalizes Gemini's separately reported thinking while retaining the original counters", () => {
    expect(normalizeTokenUsage({ promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 10, totalTokenCount: 35, cachedContentTokenCount: 7 }, "google"))
      .toMatchObject({ inputTokens: 20, outputTokens: 15, reasoningTokens: 10, totalTokens: 35, cachedInputTokens: 7, "provider.candidatesTokenCount": 5 });
    expect(normalizeTokenUsage({ promptTokenCount: 20 }, "google")).not.toHaveProperty("outputTokens");
  });
  it("retains the last cumulative streaming usage even when it arrives without a content delta", async () => {
    const adapter = new OpenAiCompatibleAdapter({ modelId: "model", baseUrl: "https://example.test", apiKey: "secret", capabilities: ["streaming"], fetch: async () => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16,"completion_tokens_details":{"reasoning_tokens":4},"prompt_tokens_details":{"cached_tokens":5}}}\n\ndata: [DONE]\n\n') });
    const result = await adapter.runStreaming({ taskType: "summarization", input: "hello", parameters: {}, metadata: {}, requiredCapabilities: [] }, undefined, () => {});
    expect(result.tokenUsage).toMatchObject({ inputTokens: 10, outputTokens: 6, reasoningTokens: 4, cachedInputTokens: 5, totalTokens: 16 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("keeps Gemini streaming usage and embedding missing usage honest", async () => {
    const adapter = new GoogleGeminiAdapter({ modelId: "gemini", apiKey: "secret", capabilities: ["streaming"], fetch: async () => new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"thoughtsTokenCount":6,"totalTokenCount":16}}\n\n') });
    const result = await adapter.runStreaming({ taskType: "summarization", input: "hello", parameters: {}, metadata: {}, requiredCapabilities: [] }, undefined, () => {});
    expect(result.tokenUsage).toMatchObject({ outputTokens: 8, reasoningTokens: 6, totalTokens: 16 });
  });
});
