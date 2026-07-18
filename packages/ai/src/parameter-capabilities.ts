import {
  AiModelParameterCapabilitiesSchema,
  type AiCapability,
  type AiModelParameterCapabilities,
  type AiReasoningLevel
} from "@app/domain";

import { openAiSupportedReasoningLevels } from "./reasoning.js";

const contextWindow = { min: 128, max: 2_000_000, step: 1 } as const;
const maxTokens = { min: 1, max: 1_000_000, step: 1 } as const;
const localMaxTokens = { min: 1, max: 32_768, step: 1 } as const;
const temperature = { min: 0, max: 2, step: 0.1 } as const;
const topP = { min: 0, max: 1, step: 0.05 } as const;
const topK = { min: 1, step: 1 } as const;
const presencePenalty = { min: -2, max: 2, step: 0.1 } as const;
const seed = { min: 0, step: 1 } as const;
const dimensions = { values: [256, 768, 1_024] as const };

export function openAiCompatibleParameterCapabilities(input: {
  modelId: string;
  baseUrl: string;
  capabilities: readonly AiCapability[];
}): AiModelParameterCapabilities {
  const common = commonRemoteCapabilities(input.capabilities);
  if (!hasGeneration(input.capabilities)) return parseCapabilities(common);

  const qwen35 = isQwen35Model(input.modelId);
  const reasoning = qwen35ReasoningCapabilities(input.modelId, input.baseUrl)
    ?? reasoningLevels(openAiSupportedReasoningLevels(input.modelId));
  return parseCapabilities({
    ...common,
    temperature,
    topP,
    ...(qwen35 ? { topK } : {}),
    presencePenalty,
    seed,
    ...(reasoning ? { reasoning } : {})
  });
}

export function googleParameterCapabilities(input: {
  modelId: string;
  capabilities: readonly AiCapability[];
}): AiModelParameterCapabilities {
  const common = commonRemoteCapabilities(input.capabilities);
  if (!hasGeneration(input.capabilities)) return parseCapabilities(common);
  const reasoning = googleReasoningCapabilities(input.modelId);
  return parseCapabilities({
    ...common,
    temperature,
    topP,
    topK,
    presencePenalty,
    seed,
    ...(reasoning ? { reasoning } : {})
  });
}

export function openAiCodexParameterCapabilities(input: {
  modelId: string;
  capabilities: readonly AiCapability[];
  maxOutputTokens?: number;
}): AiModelParameterCapabilities {
  const levels = openAiSupportedReasoningLevels(input.modelId);
  return parseCapabilities({
    ...(hasGeneration(input.capabilities) ? {
      maxTokens: { min: 1, ...(input.maxOutputTokens !== undefined ? { max: input.maxOutputTokens } : {}), step: 1 },
      ...(levels ? { reasoning: { levels: [...levels] } } : {})
    } : {}),
    ...(input.capabilities.includes("embedding") ? { dimensions } : {})
  });
}

export function localParameterCapabilities(input: {
  runtime: "gguf" | "mlx";
  modelId: string;
  catalogId?: string;
  capabilities: readonly AiCapability[];
}): AiModelParameterCapabilities {
  const embeddingOnly = input.capabilities.includes("embedding") && !hasGeneration(input.capabilities);
  if (embeddingOnly) {
    return input.runtime === "gguf" ? parseCapabilities({ contextWindow, dimensions }) : {};
  }
  if (!hasGeneration(input.capabilities)) return {};
  if (input.runtime === "gguf") {
    return parseCapabilities({
      contextWindow,
      maxTokens: localMaxTokens,
      temperature,
      topP,
      topK,
      seed
    });
  }
  const qwen35 = input.catalogId === "mlx-qwen3.5-9b-4bit" || /qwen3\.5[-/ ]?9b/i.test(input.modelId);
  return parseCapabilities({
    maxTokens: localMaxTokens,
    temperature,
    topP,
    topK,
    presencePenalty,
    seed,
    ...(qwen35 ? { reasoning: { levels: ["off", "on"] } } : {})
  });
}

export function providerParameterCapabilities(input: {
  provider: "google" | "openai-compatible" | "openai-codex";
  modelId: string;
  baseUrl?: string | null;
  capabilities: readonly AiCapability[];
}): AiModelParameterCapabilities {
  if (input.provider === "google") {
    return googleParameterCapabilities(input);
  }
  if (input.provider === "openai-codex") {
    return openAiCodexParameterCapabilities(input);
  }
  return openAiCompatibleParameterCapabilities({
    ...input,
    baseUrl: input.baseUrl ?? "http://127.0.0.1:11434/v1"
  });
}

export function isDashScopeBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "dashscope.aliyuncs.com"
      || hostname.endsWith(".dashscope.aliyuncs.com")
      || hostname === "aliyuncs.com"
      || hostname.endsWith(".aliyuncs.com");
  } catch {
    return false;
  }
}

export function isQwen35Model(modelId: string): boolean {
  return /(?:^|[/_-])qwen3[._-]?5(?:[/_.-]|$)/i.test(modelId);
}

function commonRemoteCapabilities(capabilities: readonly AiCapability[]): Record<string, unknown> {
  return {
    ...(hasGeneration(capabilities) ? { maxTokens } : {}),
    ...(capabilities.includes("embedding") ? { dimensions } : {})
  };
}

function hasGeneration(capabilities: readonly AiCapability[]): boolean {
  return capabilities.some((capability) => [
    "text-generation",
    "structured-output",
    "summarization",
    "knowledge-graph-generation",
    "atomic-note-generation",
    "reranking"
  ].includes(capability));
}

function qwen35ReasoningCapabilities(
  modelId: string,
  baseUrl: string
): { levels: AiReasoningLevel[]; maxTokens?: { min: number; max?: number; step: number } } | undefined {
  if (!isQwen35Model(modelId)) return undefined;
  if (!isDashScopeBaseUrl(baseUrl)) return { levels: ["off", "on"] };
  const maximum = /qwen3[._-]?5-plus/i.test(modelId) ? 81_920 : undefined;
  return {
    levels: ["off", "on"],
    maxTokens: { min: 1, ...(maximum !== undefined ? { max: maximum } : {}), step: 1 }
  };
}

function googleReasoningCapabilities(
  modelId: string
): { levels: AiReasoningLevel[]; maxTokens?: { min: number; max: number; step: number } } | undefined {
  const id = modelId.toLowerCase();
  if (id.includes("gemini-2.5")) {
    if (id.includes("pro")) {
      return { levels: ["on"], maxTokens: { min: 128, max: 32_768, step: 1 } };
    }
    const minimum = id.includes("flash-lite") ? 512 : 1;
    return { levels: ["off", "on"], maxTokens: { min: minimum, max: 24_576, step: 1 } };
  }
  if (!/gemini-3(?:[.\-]|$)/i.test(modelId)) return undefined;
  if (/gemini-3(?:\.\d+)?-pro/i.test(modelId)) return { levels: ["low", "medium", "high"] };
  if (/gemini-3(?:\.\d+)?-flash-lite-image/i.test(modelId)) return { levels: ["minimal", "high"] };
  return { levels: ["minimal", "low", "medium", "high"] };
}

function reasoningLevels(
  levels: readonly AiReasoningLevel[] | undefined
): { levels: AiReasoningLevel[] } | undefined {
  return levels ? { levels: [...levels] } : undefined;
}

function parseCapabilities(value: unknown): AiModelParameterCapabilities {
  return AiModelParameterCapabilitiesSchema.parse(value);
}
