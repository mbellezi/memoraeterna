import { z } from "zod";

import { LanguageCodeSchema } from "./language.js";
import {
  ConfidenceScoreSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  OptionalMetadataSchema,
  StableIdSchema
} from "./primitives.js";

export const GraphEntityTypeSchema = z.enum([
  "Person",
  "Organization",
  "Place",
  "Event",
  "Concept",
  "Work",
  "Publication",
  "Publisher",
  "Project",
  "Product",
  "FieldOfStudy",
  "Tag",
  "Collection"
]);

export type GraphEntityType = z.infer<typeof GraphEntityTypeSchema>;

export const GraphEntitySchema = z
  .object({
    id: StableIdSchema,
    type: GraphEntityTypeSchema,
    canonicalName: NonEmptyStringSchema,
    aliases: z.array(NonEmptyStringSchema).default([]),
    description: z.string().optional(),
    language: LanguageCodeSchema.optional(),
    externalRefs: z.record(z.string(), z.string()).default({}),
    confidence: ConfidenceScoreSchema.optional(),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema.optional()
  })
  .strict();

export type GraphEntity = z.infer<typeof GraphEntitySchema>;

export const RelationSchema = z
  .object({
    id: StableIdSchema,
    subjectEntityId: StableIdSchema,
    predicate: NonEmptyStringSchema,
    objectEntityId: StableIdSchema,
    sourceItemId: StableIdSchema.optional(),
    evidenceChunkId: StableIdSchema.optional(),
    sourceSpanId: StableIdSchema.optional(),
    confidence: ConfidenceScoreSchema.optional(),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type Relation = z.infer<typeof RelationSchema>;
