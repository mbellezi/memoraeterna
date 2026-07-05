import { z } from "zod";

import {
  IsoDateTimeSchema,
  OptionalMetadataSchema,
  ProgressRatioSchema,
  StableIdSchema
} from "./primitives.js";

export const JobStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "retrying",
  "completed",
  "failed",
  "canceled"
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const IngestionRunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
  "retrying"
]);

export type IngestionRunStatus = z.infer<typeof IngestionRunStatusSchema>;

export const IngestionStageStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped"
]);

export type IngestionStageStatus = z.infer<
  typeof IngestionStageStatusSchema
>;

export const IngestionStageCheckpointSchema = z
  .object({
    status: IngestionStageStatusSchema,
    completedAt: IsoDateTimeSchema.optional(),
    metadata: OptionalMetadataSchema
  })
  .strict();

export type IngestionStageCheckpoint = z.infer<
  typeof IngestionStageCheckpointSchema
>;

export const IngestionRunSchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema.optional(),
    status: IngestionRunStatusSchema,
    currentStage: z.string().min(1),
    stagesCheckpoint: z.record(
      z.string(),
      IngestionStageCheckpointSchema
    ),
    error: z.string().optional(),
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type IngestionRun = z.infer<typeof IngestionRunSchema>;

export const IngestionJobSchema = z
  .object({
    id: StableIdSchema,
    type: z.literal("ingestion"),
    status: JobStatusSchema,
    sourceItemId: StableIdSchema.optional(),
    documentId: StableIdSchema.optional(),
    ingestionRunId: StableIdSchema.optional(),
    payload: OptionalMetadataSchema,
    progress: ProgressRatioSchema,
    error: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional()
  })
  .strict();

export type IngestionJob = z.infer<typeof IngestionJobSchema>;

export const EmbeddingTargetTypeSchema = z.enum([
  "chunk",
  "atomic_note",
  "document",
  "source_item"
]);

export type EmbeddingTargetType = z.infer<typeof EmbeddingTargetTypeSchema>;

export const EmbeddingJobSchema = z
  .object({
    id: StableIdSchema,
    type: z.literal("embedding"),
    status: JobStatusSchema,
    targetType: EmbeddingTargetTypeSchema,
    targetId: StableIdSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
    payload: OptionalMetadataSchema,
    progress: ProgressRatioSchema,
    error: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional()
  })
  .strict();

export type EmbeddingJob = z.infer<typeof EmbeddingJobSchema>;
