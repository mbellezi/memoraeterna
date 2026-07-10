import { z } from "zod";

import { LanguageCodeSchema } from "./language.js";
import {
  ConfidenceScoreSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  OptionalMetadataSchema,
  StableIdSchema
} from "./primitives.js";

export const ClaimSchema = z
  .object({
    id: StableIdSchema,
    text: NonEmptyStringSchema,
    sourceItemId: StableIdSchema,
    evidenceChunkId: StableIdSchema.optional(),
    sourceSpanId: StableIdSchema.optional(),
    confidence: ConfidenceScoreSchema.optional(),
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type Claim = z.infer<typeof ClaimSchema>;

export const QuestionStatusSchema = z.enum([
  "open",
  "answered",
  "archived"
]);

export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const QuestionSchema = z
  .object({
    id: StableIdSchema,
    text: NonEmptyStringSchema,
    status: QuestionStatusSchema,
    language: LanguageCodeSchema.optional(),
    relatedEntityIds: z.array(StableIdSchema).default([]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type Question = z.infer<typeof QuestionSchema>;

export const AtomicNoteStatusSchema = z.enum([
  "pending_review",
  "approved",
  "rejected",
  "archived"
]);

export type AtomicNoteStatus = z.infer<typeof AtomicNoteStatusSchema>;

export const AtomicNoteSchema = z
  .object({
    id: StableIdSchema,
    title: NonEmptyStringSchema,
    bodyMarkdown: NonEmptyStringSchema,
    ideaStatement: NonEmptyStringSchema,
    language: LanguageCodeSchema.optional(),
    status: AtomicNoteStatusSchema,
    createdFromSourceItemId: StableIdSchema.optional(),
    sourceSpanId: StableIdSchema.optional(),
    evidenceChunkId: StableIdSchema.optional(),
    generationModel: z.string().min(1).optional(),
    generationProvider: z.string().min(1).optional(),
    generationRuntime: z.string().min(1).optional(),
    generationProfileId: StableIdSchema.optional(),
    aiTaskRunId: StableIdSchema.optional(),
    generationPromptVersion: z.string().min(1).optional(),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type AtomicNote = z.infer<typeof AtomicNoteSchema>;

export const AtomicNoteGenerationCandidateSchema = z
  .object({
    title: NonEmptyStringSchema,
    bodyMarkdown: NonEmptyStringSchema,
    ideaStatement: NonEmptyStringSchema,
    language: LanguageCodeSchema.optional(),
    evidenceChunkIds: z.array(StableIdSchema).min(1)
  })
  .strict();

export type AtomicNoteGenerationCandidate = z.infer<
  typeof AtomicNoteGenerationCandidateSchema
>;

export const AtomicNoteGenerationOutputSchema = z
  .object({
    notes: z.array(AtomicNoteGenerationCandidateSchema).max(50)
  })
  .strict();

export type AtomicNoteGenerationOutput = z.infer<
  typeof AtomicNoteGenerationOutputSchema
>;

export const AtomicNoteSourceLinkSchema = z
  .object({
    id: StableIdSchema,
    atomicNoteId: StableIdSchema,
    sourceItemId: StableIdSchema,
    chunkId: StableIdSchema,
    sourceSpanId: StableIdSchema.optional(),
    claimId: StableIdSchema.optional(),
    relationType: z.string().min(1),
    confidence: ConfidenceScoreSchema.optional(),
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type AtomicNoteSourceLink = z.infer<typeof AtomicNoteSourceLinkSchema>;

export const AtomicNoteReviewActionSchema = z.enum([
  "approve",
  "edit",
  "discard"
]);

export type AtomicNoteReviewAction = z.infer<
  typeof AtomicNoteReviewActionSchema
>;

export const AtomicNoteRelationTypeSchema = z.enum([
  "supports",
  "contrasts",
  "extends",
  "similar_to",
  "depends_on",
  "clarifies",
  "mentions",
  "related"
]);

export type AtomicNoteRelationType = z.infer<
  typeof AtomicNoteRelationTypeSchema
>;

export const AtomicNoteRelationStatusSchema = z.enum([
  "pending_review",
  "accepted",
  "rejected"
]);

export type AtomicNoteRelationStatus = z.infer<
  typeof AtomicNoteRelationStatusSchema
>;

export const AtomicNoteRelationSchema = z
  .object({
    id: StableIdSchema,
    sourceAtomicNoteId: StableIdSchema,
    targetAtomicNoteId: StableIdSchema,
    relationType: AtomicNoteRelationTypeSchema,
    vectorScore: ConfidenceScoreSchema.optional(),
    graphScore: ConfidenceScoreSchema.optional(),
    rerankScore: ConfidenceScoreSchema.optional(),
    finalScore: ConfidenceScoreSchema.optional(),
    explanation: z.string().optional(),
    status: AtomicNoteRelationStatusSchema,
    createdAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((relation, context) => {
    if (relation.sourceAtomicNoteId === relation.targetAtomicNoteId) {
      context.addIssue({
        code: "custom",
        message: "atomic note relations must connect two different notes",
        path: ["targetAtomicNoteId"]
      });
    }
  });

export type AtomicNoteRelation = z.infer<typeof AtomicNoteRelationSchema>;

export const SourceSummarySchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema,
    summary: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    provider: NonEmptyStringSchema.optional(),
    runtime: NonEmptyStringSchema.optional(),
    profileId: StableIdSchema.optional(),
    aiTaskRunId: StableIdSchema.optional(),
    promptVersion: NonEmptyStringSchema.optional(),
    language: LanguageCodeSchema.optional(),
    generatedAt: IsoDateTimeSchema,
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type SourceSummary = z.infer<typeof SourceSummarySchema>;
