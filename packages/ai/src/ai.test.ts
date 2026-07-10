import { describe, expect, it } from "vitest";

import { AiModelRegistry, OpenAiCompatibleAdapter } from "./index.js";

describe("AI adapters", () => {
  it("negotiates capabilities", () => {
    const registry = new AiModelRegistry();
    registry.register(new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model",
      capabilities: ["text-generation", "requires-network"]
    }));
    expect(registry.list(["text-generation"])).toHaveLength(1);
    expect(() => registry.resolve({ requiredCapabilities: ["embedding"] })).toThrow("errors.ai.noCompatibleModel");
  });

  it("runs an OpenAI-compatible embedding request without exposing the key in the result", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "embed",
      capabilities: ["embedding"],
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
    });
    const result = await adapter.run({
      taskType: "embedding", input: "hello", modelId: "embed",
      requiredCapabilities: ["embedding"], parameters: {}, metadata: {}
    });
    expect(result.output).toEqual([0.1, 0.2]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
