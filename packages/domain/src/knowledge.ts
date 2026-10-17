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

export const QuestionStatusSchema = z.enum(["open", "answered", "archived"]);

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

/** `active` is the status of a generated note at birth: usable at once, review is optional. */
export const AtomicNoteStatusSchema = z.enum([
  "active",
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

export type AtomicNoteGenerationCandidate = z.infer<typeof AtomicNoteGenerationCandidateSchema>;

export const AtomicNoteGenerationOutputSchema = z
  .object({
    notes: z.array(AtomicNoteGenerationCandidateSchema).max(50)
  })
  .strict();

export type AtomicNoteGenerationOutput = z.infer<typeof AtomicNoteGenerationOutputSchema>;

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

export const AtomicNoteReviewActionSchema = z.enum(["approve", "edit", "discard"]);

export type AtomicNoteReviewAction = z.infer<typeof AtomicNoteReviewActionSchema>;

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

export type AtomicNoteRelationType = z.infer<typeof AtomicNoteRelationTypeSchema>;

/**
 * Relations v2 vocabulary (F3 decision D10). New relations are written with these seven types;
 * the typer's `none` is a veto and is never stored. The eight values above stay readable on legacy
 * rows (no stored row is rewritten, and `similar_to` never becomes `same_as`).
 */
export const noteRelationWriteTypes = [
  "supports",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "clarifies",
  "same_as"
] as const;
export const NoteRelationWriteTypeSchema = z.enum(noteRelationWriteTypes);
export type NoteRelationWriteType = z.infer<typeof NoteRelationWriteTypeSchema>;

/** Write types that read from a subject to an object; the other write types are symmetric. */
export const directedNoteRelationTypes = [
  "supports",
  "extends",
  "depends_on",
  "example_of",
  "clarifies"
] as const satisfies readonly NoteRelationWriteType[];
export const symmetricNoteRelationTypes = [
  "contradicts",
  "same_as"
] as const satisfies readonly NoteRelationWriteType[];

/** Every stored value a reader may meet: the write types and the legacy ones. */
export const noteRelationReadTypes = [
  ...noteRelationWriteTypes,
  "contrasts",
  "similar_to",
  "mentions",
  "related"
] as const;
export const NoteRelationReadTypeSchema = z.enum(noteRelationReadTypes);
export type NoteRelationReadType = z.infer<typeof NoteRelationReadTypeSchema>;

/** What the typer answers per pair: a write type, or `none` (a veto: nothing is persisted). */
export const NoteRelationTypingSchema = z.enum([...noteRelationWriteTypes, "none"]);
export type NoteRelationTyping = z.infer<typeof NoteRelationTypingSchema>;

/**
 * Direction of a stored note pair (D8). The pair is stored once, endpoints sorted by UUID
 * (`lo < hi`); the direction says how it reads. `unknown` exists only on legacy rows.
 */
export const NoteRelationDirectionSchema = z.enum(["lo_to_hi", "hi_to_lo", "symmetric", "unknown"]);
export type NoteRelationDirection = z.infer<typeof NoteRelationDirectionSchema>;

/** Automation's outcome (D9), apart from the human review status; null on legacy rows. */
export const NoteRelationBandSchema = z.enum(["apply", "suggest"]);
export type NoteRelationBand = z.infer<typeof NoteRelationBandSchema>;

/** Who withdrew a relation automatically (D9, D20, D22). */
export const NoteRelationVetoSourceSchema = z.enum(["explainer", "typer"]);
export type NoteRelationVetoSource = z.infer<typeof NoteRelationVetoSourceSchema>;

/** Legacy types that read the same both ways; every other legacy type kept its judged direction. */
export const symmetricLegacyNoteRelationTypes = ["contrasts", "similar_to"] as const;

/** Whether a stored type (write or legacy) reads the same both ways. An untyped row is neutral. */
export function isSymmetricNoteRelationType(type: string | null): boolean {
  return (
    type === null ||
    (symmetricNoteRelationTypes as readonly string[]).includes(type) ||
    (symmetricLegacyNoteRelationTypes as readonly string[]).includes(type)
  );
}

/**
 * The stored form of a decided pair: both endpoints sorted by UUID and the direction the relation
 * reads in. `subjectId -> objectId` is the decided direction (the typer's A -> B, or the note being
 * matched -> its candidate for the generative decider); a symmetric or untyped relation is
 * `symmetric`. PostgreSQL orders lowercase UUIDs as their text does, so this agrees with the
 * database's `lo < hi`.
 */
export function noteRelationPair(
  subjectId: string,
  objectId: string,
  type: string | null
): { lo: string; hi: string; direction: Exclude<NoteRelationDirection, "unknown"> } {
  const subject = subjectId.toLowerCase(),
    object = objectId.toLowerCase();
  if (subject === object) throw new Error("A note relation needs two different notes.");
  const [lo, hi] = subject < object ? [subject, object] : [object, subject];
  if (isSymmetricNoteRelationType(type)) return { lo, hi, direction: "symmetric" };
  return { lo, hi, direction: subject === lo ? "lo_to_hi" : "hi_to_lo" };
}

/** The decided subject of a stored pair, or null when the relation reads both ways or is unknown. */
export function noteRelationSubject(relation: {
  sourceAtomicNoteId: string;
  targetAtomicNoteId: string;
  direction: NoteRelationDirection;
}): string | null {
  if (relation.direction === "lo_to_hi") return relation.sourceAtomicNoteId;
  if (relation.direction === "hi_to_lo") return relation.targetAtomicNoteId;
  return null;
}

export const AtomicNoteRelationStatusSchema = z.enum(["pending_review", "accepted", "rejected"]);

export type AtomicNoteRelationStatus = z.infer<typeof AtomicNoteRelationStatusSchema>;

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
