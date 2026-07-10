import { z } from "zod";

export const AiTaskTypes = [
  "metadata-lookup",
  "cataloging",
  "text-generation",
  "structured-output",
  "summarization",
  "entity-extraction",
  "claim-extraction",
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

export const AiReasoningLevelSchema = z.enum(["off", "minimal", "low", "medium", "high"]);
export type AiReasoningLevel = z.infer<typeof AiReasoningLevelSchema>;

export const AiModelParametersSchema = z.object({
  contextWindow: z.number().int().min(128).max(2_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  reasoningLevel: AiReasoningLevelSchema.optional(),
  topP: z.number().min(0).max(1).optional(),
  dimensions: z.union([z.literal(256), z.literal(768), z.literal(1024)]).optional(),
  seed: z.number().int().nonnegative().optional()
}).strict();
export type AiModelParameters = z.infer<typeof AiModelParametersSchema>;
