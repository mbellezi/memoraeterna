import { describe, expect, it } from "vitest";

import { OpenAiCodexAdapter } from "./openai-codex.js";

describe("OpenAI Codex adapter", () => {
  it("lists visible subscription models with OAuth account headers", async () => {
    const adapter = new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-test",
      capabilities: ["text-generation"],
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer oauth-access");
        expect(headers.get("chatgpt-account-id")).toBe("account-1");
        return Response.json({ models: [
          { slug: "gpt-visible", display_name: "Visible", visibility: "list", max_output_tokens: 128_000 },
          { slug: "gpt-hidden", visibility: "hide" }
        ] });
      }
    });

    await expect(adapter.listModels()).resolves.toMatchObject([
      {
        modelId: "gpt-visible",
        displayName: "Visible",
        limits: { maxTokens: 128_000 },
        parameterCapabilities: {}
      }
    ]);
  });

  it.each(["gpt-5.6-terra", "gpt-5.6-luna"])(
    "omits the unsupported max_output_tokens parameter for %s",
    async (modelId) => {
      const body = [
        'data: {"type":"response.output_text.delta","delta":"summary"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
      ].join("");
      const adapter = new OpenAiCodexAdapter({
        accessToken: "oauth-access",
        accountId: "account-1",
        modelId,
        capabilities: ["summarization", "streaming"],
        fetch: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(payload).not.toHaveProperty("max_output_tokens");
          expect(payload).toMatchObject({
            model: modelId,
            reasoning: { effort: "low", summary: "auto" }
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
      });

      await expect(adapter.run({
        taskType: "summarization",
        input: "test",
        requiredCapabilities: ["summarization"],
        parameters: { maxTokens: 16_384, reasoningLevel: "off" },
        metadata: {}
      })).resolves.toMatchObject({ output: "summary", modelId });
    }
  );

  it("streams a generative response and rejects embeddings", async () => {
    const body = [
      'data: {"type":"response.output_text.delta","delta":"hello "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2}}}\n\n'
    ].join("");
    const adapter = new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-5.6-sol",
      capabilities: ["text-generation", "streaming"],
      fetch: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(payload).toMatchObject({
          model: "gpt-5.6-sol",
          store: false,
          stream: true,
          reasoning: { effort: "max" }
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
    });

    await expect(adapter.run({
      taskType: "text-generation",
      input: "test",
      requiredCapabilities: ["text-generation"],
      parameters: { reasoningLevel: "max" },
      metadata: {}
    })).resolves.toMatchObject({ output: "hello world", inputTokens: 2, outputTokens: 2 });
    await expect(adapter.run({
      taskType: "embedding",
      input: "test",
      requiredCapabilities: ["embedding"],
      parameters: {},
      metadata: {}
    })).rejects.toThrow("errors.ai.unsupportedTask");
  });

  it("preserves the detailed provider response when a request fails", async () => {
    const adapter = new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-5.6-terra",
      capabilities: ["summarization"],
      fetch: async () => Response.json({
        detail: "Request rejected for account policy"
      }, { status: 400 })
    });

    const error = await adapter.run({
      taskType: "summarization",
      input: "test",
      requiredCapabilities: ["summarization"],
      parameters: {},
      metadata: {}
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("AI provider request failed (400).");
    expect((error as Error).message).toContain("Request rejected for account policy");
  });
});
