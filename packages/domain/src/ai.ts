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
