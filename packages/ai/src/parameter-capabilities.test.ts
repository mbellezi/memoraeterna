import { describe, expect, it } from "vitest";
import { normalizeAiModelParameters } from "@app/domain";

import {
  googleParameterCapabilities,
  localParameterCapabilities,
  openAiCodexParameterCapabilities,
  openAiCompatibleParameterCapabilities
} from "./parameter-capabilities.js";

const generationCapabilities = ["text-generation", "structured-output"] as const;

describe("model parameter capabilities", () => {
  it("exposes Qwen 3.5 MLX reasoning as a binary switch without a budget", () => {
    const capabilities = localParameterCapabilities({
      runtime: "mlx",
      modelId: "mlx-community/Qwen3.5-9B-4bit",
      catalogId: "mlx-qwen3.5-9b-4bit",
      capabilities: generationCapabilities
    });

    expect(capabilities.reasoning).toEqual({ levels: ["off", "on"] });
    expect(capabilities).not.toHaveProperty("contextWindow");
    expect(capabilities.topP).toEqual({ min: 0, max: 1, step: 0.05 });
    expect(capabilities.topK).toEqual({ min: 1, step: 1 });
    expect(capabilities.presencePenalty).toEqual({ min: -2, max: 2, step: 0.1 });
    expect(normalizeAiModelParameters({
      reasoningLevel: "high",
      reasoningMaxTokens: 4_096,
      topP: 0.9,
      topK: 20,
      presencePenalty: 1.5
    }, capabilities)).toEqual({
      reasoningLevel: "on",
      topP: 0.9,
      topK: 20,
      presencePenalty: 1.5
    });
  });

  it("does not advertise parameters that an adapter does not forward", () => {
    expect(openAiCompatibleParameterCapabilities({
      modelId: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      capabilities: generationCapabilities
    })).not.toHaveProperty("contextWindow");
    expect(localParameterCapabilities({
      runtime: "mlx",
      modelId: "mlx-community/gemma-3-4b-it-4bit",
      capabilities: generationCapabilities
    })).not.toHaveProperty("contextWindow");
    expect(localParameterCapabilities({
      runtime: "gguf",
      modelId: "generic-instruct.gguf",
      capabilities: generationCapabilities
    })).not.toHaveProperty("presencePenalty");
    expect(openAiCompatibleParameterCapabilities({
      modelId: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      capabilities: generationCapabilities
    })).not.toHaveProperty("topK");
  });

  it("exposes only wire-level OAuth controls for GPT-5.6 Terra and Luna", () => {
    for (const modelId of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
      const capabilities = openAiCodexParameterCapabilities({
        modelId,
        capabilities: generationCapabilities
      });

      expect(capabilities).toEqual({
        reasoning: { levels: ["low", "medium", "high", "xhigh", "max"] }
      });
      expect(normalizeAiModelParameters({
        maxTokens: 16_384,
        reasoningLevel: "off"
      }, capabilities)).toEqual({ reasoningLevel: "low" });
    }
  });

  it("offers a thinking budget only for Qwen 3.5 served by DashScope", () => {
    const dashScope = openAiCompatibleParameterCapabilities({
      modelId: "qwen3.5-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      capabilities: generationCapabilities
    });
    const selfHosted = openAiCompatibleParameterCapabilities({
      modelId: "Qwen/Qwen3.5-9B",
      baseUrl: "http://127.0.0.1:8000/v1",
      capabilities: generationCapabilities
    });

    expect(dashScope.reasoning).toEqual({
      levels: ["off", "on"],
      maxTokens: { min: 1, max: 81_920, step: 1 }
    });
    expect(selfHosted.reasoning).toEqual({ levels: ["off", "on"] });
  });

  it("distinguishes Gemini thinking budgets from thinking levels", () => {
    expect(googleParameterCapabilities({
      modelId: "gemini-2.5-flash",
      capabilities: generationCapabilities
    }).reasoning).toEqual({
      levels: ["off", "on"],
      maxTokens: { min: 1, max: 24_576, step: 1 }
    });
    expect(googleParameterCapabilities({
      modelId: "gemini-3.1-pro-preview",
      capabilities: generationCapabilities
    }).reasoning).toEqual({ levels: ["low", "medium", "high"] });
    expect(googleParameterCapabilities({
      modelId: "gemini-3.5-flash",
      capabilities: generationCapabilities
    })).toMatchObject({
      temperature: { min: 0, max: 2 },
      topP: { min: 0, max: 1 },
      topK: { min: 1 },
      presencePenalty: { min: -2, max: 2 }
    });
  });
});
