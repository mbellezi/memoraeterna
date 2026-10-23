import { z } from "zod";

import { IsoDateTimeSchema, OptionalMetadataSchema, StableIdSchema } from "./primitives.js";

// A job's state is the `jobs` row's status plus the Gardener columns (F4 D5): see `gardener/state.ts`.

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

export type IngestionStageStatus = z.infer<typeof IngestionStageStatusSchema>;

export const IngestionStageCheckpointSchema = z
  .object({
    status: IngestionStageStatusSchema,
    completedAt: IsoDateTimeSchema.optional(),
    metadata: OptionalMetadataSchema
  })
  .strict();

export type IngestionStageCheckpoint = z.infer<typeof IngestionStageCheckpointSchema>;

export const IngestionRunSchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema.optional(),
    status: IngestionRunStatusSchema,
    currentStage: z.string().min(1),
    stagesCheckpoint: z.record(z.string(), IngestionStageCheckpointSchema),
    error: z.string().optional(),
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type IngestionRun = z.infer<typeof IngestionRunSchema>;
