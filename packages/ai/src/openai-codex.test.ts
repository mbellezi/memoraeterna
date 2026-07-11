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
          { slug: "gpt-visible", display_name: "Visible", visibility: "list" },
          { slug: "gpt-hidden", visibility: "hide" }
        ] });
      }
    });

    await expect(adapter.listModels()).resolves.toMatchObject([
      { modelId: "gpt-visible", displayName: "Visible" }
    ]);
  });

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
});
