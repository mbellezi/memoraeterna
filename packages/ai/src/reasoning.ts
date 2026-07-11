import type { AiModelParameters, AiReasoningLevel } from "@app/domain";

export function effectiveReasoningLevel(
  providerId: string,
  modelId: string,
  level: AiReasoningLevel | undefined
): AiReasoningLevel | undefined {
  if (!level) return undefined;
  const usesGeminiReasoning = providerId === "google"
    || (providerId === "openai-compatible" && modelId.toLowerCase().includes("gemini"));
  if (usesGeminiReasoning) {
    if (isGemini25(modelId)) {
      if (level === "xhigh" || level === "max") return "high";
      if (level === "off" && isGeminiPro(modelId)) return "low";
      return level;
    }
    if (!isGemini3(modelId)) return undefined;
    if (level === "xhigh" || level === "max") return "high";
    if (isGemini3Pro(modelId) && (level === "off" || level === "minimal")) return "low";
    if (isGeminiFlashLiteImage(modelId)) {
      if (level === "off" || level === "low") return "minimal";
      if (level === "medium") return "high";
    }
    return level === "off" ? "minimal" : level;
  }

  const usesOpenAiReasoning = providerId === "openai-codex"
    || (providerId === "openai-compatible" && isOpenAiReasoningModel(modelId));
  if (!usesOpenAiReasoning) return level;
  const supported = openAiSupportedReasoningLevels(modelId);
  return supported ? closestSupportedReasoningLevel(level, supported) : level;
}

export function effectiveReasoningParameters(
  providerId: string,
  modelId: string,
  parameters: AiModelParameters
): AiModelParameters {
  if (parameters.reasoningLevel === undefined) return parameters;
  const reasoningLevel = effectiveReasoningLevel(providerId, modelId, parameters.reasoningLevel);
  if (reasoningLevel === parameters.reasoningLevel) return parameters;
  const effective = { ...parameters };
  if (reasoningLevel === undefined) delete effective.reasoningLevel;
  else effective.reasoningLevel = reasoningLevel;
  return effective;
}

export function openAiReasoningEffort(level: AiReasoningLevel | undefined): string | undefined {
  if (!level) return undefined;
  return level === "off" ? "none" : level;
}

export function googleThinkingConfig(
  modelId: string,
  level: AiReasoningLevel | undefined
): { thinkingLevel: string } | { thinkingBudget: number } | undefined {
  const effective = effectiveReasoningLevel("google", modelId, level);
  if (!effective) return undefined;
  if (isGemini25(modelId)) {
    if (effective === "off") return { thinkingBudget: 0 };
    return { thinkingBudget: ({ minimal: 1_024, low: 1_024, medium: 8_192, high: 24_576, xhigh: 24_576, max: 24_576 })[effective] };
  }
  return { thinkingLevel: effective };
}

function isGemini25(modelId: string): boolean {
  return modelId.toLowerCase().includes("gemini-2.5");
}

function isGemini3(modelId: string): boolean {
  return /gemini-3(?:[.\-]|$)/i.test(modelId);
}

function isGeminiPro(modelId: string): boolean {
  return modelId.toLowerCase().includes("pro");
}

function isGemini3Pro(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-pro/i.test(modelId);
}

function isGeminiFlashLiteImage(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-flash-lite-image/i.test(modelId);
}

function isOpenAiReasoningModel(modelId: string): boolean {
  const id = unqualifiedModelId(modelId);
  return id.startsWith("gpt-5") || /^o[134](?:-|$)/.test(id) || id.startsWith("gpt-realtime-2");
}

function openAiSupportedReasoningLevels(modelId: string): readonly AiReasoningLevel[] | undefined {
  const id = unqualifiedModelId(modelId);
  if (id.startsWith("gpt-realtime-2")) return ["minimal", "low", "medium", "high", "xhigh"];
  if (/^o[134](?:-|$)/.test(id)) return ["low", "medium", "high"];
  if (!id.startsWith("gpt-5")) return undefined;

  const version = id.match(/^gpt-5\.(\d+)/)?.[1];
  const minorVersion = version === undefined ? null : Number(version);
  const isPro = /-pro(?:-|$)/.test(id);
  const isCodex = /-codex(?:-|$)/.test(id);

  if (isPro) {
    if (minorVersion !== null && minorVersion >= 2) return ["medium", "high", "xhigh"];
    return ["high"];
  }
  if (isCodex) {
    return minorVersion !== null && minorVersion >= 2
      ? ["low", "medium", "high", "xhigh"]
      : ["low", "medium", "high"];
  }
  if (minorVersion !== null) {
    if (minorVersion >= 6) return ["off", "low", "medium", "high", "xhigh", "max"];
    return minorVersion >= 2
      ? ["off", "low", "medium", "high", "xhigh"]
      : ["off", "low", "medium", "high"];
  }
  if (/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return ["minimal", "low", "medium", "high"];
  }
  return ["low", "medium", "high"];
}

function closestSupportedReasoningLevel(
  level: AiReasoningLevel,
  supported: readonly AiReasoningLevel[]
): AiReasoningLevel {
  if (supported.includes(level)) return level;
  const ordered: readonly AiReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const requestedIndex = ordered.indexOf(level);
  for (let distance = 1; distance < ordered.length; distance += 1) {
    const higher = ordered[requestedIndex + distance];
    if (higher && supported.includes(higher)) return higher;
    const lower = ordered[requestedIndex - distance];
    if (lower && supported.includes(lower)) return lower;
  }
  return level;
}

function unqualifiedModelId(modelId: string): string {
  return modelId.toLowerCase().split("/").at(-1) ?? modelId.toLowerCase();
}
