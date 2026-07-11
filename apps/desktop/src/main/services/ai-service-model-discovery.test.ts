import { afterEach, describe, expect, it, vi } from "vitest";

import { AiService } from "./ai-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI model discovery", () => {
  it("discovers and normalizes models from an unsaved OpenAI-compatible provider", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://example.test/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer transient-secret");
      return new Response(JSON.stringify({
        data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }, {}]
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await createService().discoverModels({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "transient-secret"
    });

    expect(models).toEqual(["a-model", "z-model"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the Gemini model endpoint without requiring a saved provider", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-secret"
      );
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createService().discoverModels({
      provider: "google",
      apiKey: "gemini-secret"
    })).resolves.toEqual(["gemini-test"]);
  });
});

function createService(): AiService {
  return new AiService({
    userDataPath: "/tmp/memora-ai-discovery-test",
    getPool: () => null,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false
  });
}
