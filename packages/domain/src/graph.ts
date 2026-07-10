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

export const ExtractedGraphEntitySchema = z.object({
  key: z.string().trim().min(1).max(120),
  type: GraphEntityTypeSchema,
  canonicalName: NonEmptyStringSchema,
  aliases: z.array(NonEmptyStringSchema).max(20).default([]),
  description: z.string().trim().min(1).max(2_000).optional(),
  confidence: ConfidenceScoreSchema,
  evidenceChunkIds: z.array(StableIdSchema).min(1).max(50)
}).strict();

export const ExtractedClaimSchema = z.object({
  text: NonEmptyStringSchema,
  confidence: ConfidenceScoreSchema,
  evidenceChunkIds: z.array(StableIdSchema).min(1).max(50),
  relatedEntityKeys: z.array(z.string().trim().min(1).max(120)).max(30).default([])
}).strict();

export const ExtractedEntityRelationSchema = z.object({
  subjectEntityKey: z.string().trim().min(1).max(120),
  predicate: z.string().trim().min(1).max(120),
  objectEntityKey: z.string().trim().min(1).max(120),
  confidence: ConfidenceScoreSchema,
  evidenceChunkIds: z.array(StableIdSchema).min(1).max(50)
}).strict();

export const KnowledgeGraphGenerationOutputSchema = z.object({
  entities: z.array(ExtractedGraphEntitySchema).max(100),
  claims: z.array(ExtractedClaimSchema).max(100),
  relations: z.array(ExtractedEntityRelationSchema).max(200)
}).strict().superRefine((output, context) => {
  const keys = new Set(output.entities.map((entity) => entity.key));
  if (keys.size !== output.entities.length) {
    context.addIssue({ code: "custom", message: "entity keys must be unique", path: ["entities"] });
  }
  for (const [index, claim] of output.claims.entries()) {
    for (const key of claim.relatedEntityKeys) {
      if (!keys.has(key)) context.addIssue({
        code: "custom", message: "claim references an unknown entity key", path: ["claims", index, "relatedEntityKeys"]
      });
    }
  }
  for (const [index, relation] of output.relations.entries()) {
    if (!keys.has(relation.subjectEntityKey) || !keys.has(relation.objectEntityKey)) {
      context.addIssue({
        code: "custom", message: "relation references an unknown entity key", path: ["relations", index]
      });
    }
    if (relation.subjectEntityKey === relation.objectEntityKey) {
      context.addIssue({ code: "custom", message: "relation must connect different entities", path: ["relations", index] });
    }
  }
});

export type KnowledgeGraphGenerationOutput = z.infer<typeof KnowledgeGraphGenerationOutputSchema>;
