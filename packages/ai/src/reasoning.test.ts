import { describe, expect, it } from "vitest";

import {
  effectiveReasoningLevel,
  effectiveReasoningParameters,
  googleThinkingConfig,
  openAiReasoningEffort
} from "./reasoning.js";

describe("reasoning parameter compatibility", () => {
  it("maps the complete OpenAI effort scale", () => {
    expect(openAiReasoningEffort("off")).toBe("none");
    expect(openAiReasoningEffort("minimal")).toBe("minimal");
    expect(openAiReasoningEffort("xhigh")).toBe("xhigh");
    expect(openAiReasoningEffort("max")).toBe("max");
  });

  it("normalizes OpenAI effort to each model family's supported subset", () => {
    expect(effectiveReasoningLevel("openai-codex", "gpt-5", "minimal")).toBe("minimal");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5", "off")).toBe("minimal");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.1", "minimal")).toBe("low");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.1", "xhigh")).toBe("high");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.4", "minimal")).toBe("low");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.4-pro", "minimal")).toBe("medium");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.4-pro", "low")).toBe("medium");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.2-codex", "off")).toBe("low");
    expect(effectiveReasoningLevel("openai-compatible", "openai/o3", "minimal")).toBe("low");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.6", "max")).toBe("max");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.6-sol", "minimal")).toBe("low");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.6-terra", "off")).toBe("low");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.6-terra", "max")).toBe("max");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.6-luna", "off")).toBe("low");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.6-luna", "max")).toBe("max");
    expect(effectiveReasoningLevel("openai-codex", "gpt-5.5", "max")).toBe("xhigh");
  });

  it("uses thinking budgets for Gemini 2.5", () => {
    expect(googleThinkingConfig("gemini-2.5-flash", "off")).toEqual({ thinkingBudget: 0 });
    expect(googleThinkingConfig("gemini-2.5-pro", "off")).toEqual({ thinkingBudget: 1_024 });
    expect(googleThinkingConfig("gemini-2.5-flash", "on")).toEqual({ thinkingBudget: -1 });
    expect(googleThinkingConfig("gemini-2.5-flash", "on", 4_096)).toEqual({ thinkingBudget: 4_096 });
    expect(googleThinkingConfig("gemini-2.5-flash", "medium")).toEqual({ thinkingBudget: 8_192 });
    expect(googleThinkingConfig("gemini-2.5-pro", "xhigh")).toEqual({ thinkingBudget: 24_576 });
  });

  it("normalizes unsupported Gemini 3 levels to the closest supported level", () => {
    expect(effectiveReasoningLevel("google", "gemini-3.1-pro-preview", "off")).toBe("low");
    expect(effectiveReasoningLevel("google", "gemini-3.5-flash", "off")).toBe("minimal");
    expect(effectiveReasoningLevel("google", "gemini-3.5-flash", "xhigh")).toBe("high");
    expect(effectiveReasoningLevel("google", "gemini-3.5-flash", "max")).toBe("high");
    expect(googleThinkingConfig("gemini-3.1-pro-preview", "minimal")).toEqual({ thinkingLevel: "low" });
    expect(googleThinkingConfig("gemini-2.0-flash", "high")).toBeUndefined();
  });

  it("records the same effective level that is sent to the provider", () => {
    expect(effectiveReasoningParameters("google", "gemini-3.1-pro-preview", {
      reasoningLevel: "off",
      maxTokens: 100
    })).toEqual({ reasoningLevel: "low", maxTokens: 100 });
    expect(effectiveReasoningParameters("openai-codex", "gpt-5.4", {
      reasoningLevel: "minimal"
    })).toEqual({ reasoningLevel: "low" });
    expect(effectiveReasoningParameters("openai-codex", "gpt-5.6-luna", {
      reasoningLevel: "max"
    })).toEqual({ reasoningLevel: "max" });
  });
});
