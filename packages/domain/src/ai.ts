import { z } from "zod";

export const AiTaskTypes = [
  "metadata-lookup",
  "cataloging",
  "text-generation",
  "structured-output",
  "summarization",
  "entity-extraction",
  "claim-extraction",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "embedding",
  "reranking",
  "image-understanding",
  "document-ocr",
  "audio-transcription",
  "video-understanding",
  "writing-assistance"
] as const;

export const AiTaskTypeSchema = z.enum(AiTaskTypes);

export type AiTaskType = z.infer<typeof AiTaskTypeSchema>;

export const AiCapabilities = [
  "text-generation",
  "structured-output",
  "json-schema-output",
  "summarization",
  "entity-extraction",
  "claim-extraction",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "embedding",
  "reranking",
  "image-understanding",
  "document-ocr",
  "audio-transcription",
  "video-understanding",
  "streaming",
  "cancellation",
  "batching",
  "offline",
  "local-files",
  "requires-api-key",
  "requires-network",
  "supports-progress-events"
] as const;

export const AiCapabilitySchema = z.enum(AiCapabilities);

export type AiCapability = z.infer<typeof AiCapabilitySchema>;

export const AiReasoningLevelSchema = z.enum(["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type AiReasoningLevel = z.infer<typeof AiReasoningLevelSchema>;

export const AiModelParametersSchema = z.object({
  contextWindow: z.number().int().min(128).max(2_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  reasoningLevel: AiReasoningLevelSchema.optional(),
  reasoningMaxTokens: z.number().int().min(1).max(1_000_000).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(1_000_000).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  dimensions: z.union([z.literal(256), z.literal(768), z.literal(1024)]).optional(),
  seed: z.number().int().nonnegative().optional()
}).strict();
export type AiModelParameters = z.infer<typeof AiModelParametersSchema>;

export const AiParameterRangeSchema = z.object({
  min: z.number(),
  max: z.number().optional(),
  step: z.number().positive().optional()
}).strict().superRefine((range, context) => {
  if (range.max !== undefined && range.max < range.min) {
    context.addIssue({ code: "custom", message: "Parameter maximum must be greater than or equal to its minimum.", path: ["max"] });
  }
});
export type AiParameterRange = z.infer<typeof AiParameterRangeSchema>;

export const AiModelParameterCapabilitiesSchema = z.object({
  contextWindow: AiParameterRangeSchema.optional(),
  temperature: AiParameterRangeSchema.optional(),
  maxTokens: AiParameterRangeSchema.optional(),
  reasoning: z.object({
    levels: z.array(AiReasoningLevelSchema).min(1),
    maxTokens: AiParameterRangeSchema.optional()
  }).strict().optional(),
  topP: AiParameterRangeSchema.optional(),
  topK: AiParameterRangeSchema.optional(),
  presencePenalty: AiParameterRangeSchema.optional(),
  dimensions: z.object({
    values: z.array(z.union([z.literal(256), z.literal(768), z.literal(1024)])).min(1)
  }).strict().optional(),
  seed: AiParameterRangeSchema.optional()
}).strict();
export type AiModelParameterCapabilities = z.infer<typeof AiModelParameterCapabilitiesSchema>;

export function normalizeAiModelParameters(
  parameters: AiModelParameters,
  capabilities: AiModelParameterCapabilities
): AiModelParameters {
  const normalized: AiModelParameters = {};
  copySupportedNumber("contextWindow", parameters, capabilities, normalized);
  copySupportedNumber("temperature", parameters, capabilities, normalized);
  copySupportedNumber("maxTokens", parameters, capabilities, normalized);
  copySupportedNumber("topP", parameters, capabilities, normalized);
  copySupportedNumber("topK", parameters, capabilities, normalized);
  copySupportedNumber("presencePenalty", parameters, capabilities, normalized);
  copySupportedNumber("seed", parameters, capabilities, normalized);

  if (parameters.dimensions !== undefined && capabilities.dimensions?.values.includes(parameters.dimensions)) {
    normalized.dimensions = parameters.dimensions;
  }
  if (parameters.reasoningLevel !== undefined && capabilities.reasoning) {
    normalized.reasoningLevel = normalizeReasoningLevel(parameters.reasoningLevel, capabilities.reasoning.levels);
  }
  if (parameters.reasoningMaxTokens !== undefined && capabilities.reasoning?.maxTokens
      && normalized.reasoningLevel !== "off") {
    normalized.reasoningMaxTokens = clampToRange(parameters.reasoningMaxTokens, capabilities.reasoning.maxTokens);
  }
  return normalized;
}

function copySupportedNumber(
  key: "contextWindow" | "temperature" | "maxTokens" | "topP" | "topK" | "presencePenalty" | "seed",
  parameters: AiModelParameters,
  capabilities: AiModelParameterCapabilities,
  normalized: AiModelParameters
): void {
  const value = parameters[key];
  const range = capabilities[key];
  if (value === undefined || !range) return;
  Object.assign(normalized, { [key]: clampToRange(value, range) });
}

function clampToRange(value: number, range: AiParameterRange): number {
  return Math.min(range.max ?? value, Math.max(range.min, value));
}

function normalizeReasoningLevel(
  level: AiReasoningLevel,
  supported: readonly AiReasoningLevel[]
): AiReasoningLevel {
  if (supported.includes(level)) return level;
  if (supported.includes("on") && level !== "off") return "on";
  if (level === "on") {
    return supported.includes("medium") ? "medium" : supported[0] ?? level;
  }
  const ordered: readonly AiReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const requestedIndex = ordered.indexOf(level);
  for (let distance = 1; distance < ordered.length; distance += 1) {
    const higher = ordered[requestedIndex + distance];
    if (higher && supported.includes(higher)) return higher;
    const lower = ordered[requestedIndex - distance];
    if (lower && supported.includes(lower)) return lower;
  }
  return supported[0] ?? level;
}
