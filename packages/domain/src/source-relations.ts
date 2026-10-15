import { z } from "zod";
import { AtomicNoteRelationStatusSchema, AtomicNoteRelationTypeSchema } from "./knowledge.js";

export const SourceRelationSettingsSchema = z
  .object({
    reciprocalRankConstant: z.number().int().min(1).max(200).default(60),
    evidenceChunksPerSource: z.number().int().min(1).max(12).default(3),
    evidenceMaxCharacters: z.number().int().min(300).max(6000).default(1000),
    summaryMaxCharacters: z.number().int().min(300).max(6000).default(1200),
    noteRelationsPerPair: z.number().int().min(0).max(30).default(6),
    maxOutputTokens: z.number().int().min(512).max(16384).default(4096),
    maxCandidates: z.number().int().min(1).max(200).default(40),
    maxPairs: z.number().int().min(1).max(50).default(8),
    maxRelations: z.number().int().min(1).max(200).default(10),
    maxRelationsPerPair: z.number().int().min(1).max(20).default(4),
    maxInputTokens: z.number().int().min(2_000).max(200_000).default(20_000),
    minImportance: z.number().min(0).max(1).default(0.75),
    minConfidence: z.number().min(0).max(1).default(0.8),
    includeWeakTypes: z.boolean().default(false)
  })
  .strict();
export type SourceRelationSettings = z.infer<typeof SourceRelationSettingsSchema>;
export const defaultSourceRelationSettings = SourceRelationSettingsSchema.parse({});

/**
 * How far source matching got for a work, stored in the stage checkpoint metadata: the candidate
 * works it considered, how many it judged, and why any was left unjudged. The per-run pair cap and
 * the relation limit are limits of the design, not failures; only `budgetExhausted` means a pair
 * could not be completed.
 */
export const SourceRelationCoverageSchema = z
  .object({
    judgedPairs: z.number().int().nonnegative(),
    candidatePairs: z.number().int().nonnegative(),
    /** The per-run pair cap (`maxPairs`) left candidates unjudged. */
    capReached: z.boolean(),
    /** The relation limit (`maxRelations`) left candidates unjudged. */
    relationLimitReached: z.boolean(),
    /** A pair could not be completed because the input token budget was exhausted. */
    budgetExhausted: z.boolean()
  })
  .strict();
export type SourceRelationCoverage = z.infer<typeof SourceRelationCoverageSchema>;

/**
 * The compact, score-only source verdict (`source-relations-v5`, docs/plan.md decision 17): a pair
 * of works answers at most `maxItemsPerPair` items `[from, to, type, importance, confidence, [from
 * chunks], [to chunks]]`, with integer scores from 0 to 100 and no prose.
 */
export const sourceDecisionLimits = {
  maxItemsPerPair: 2,
  maxChunksPerSide: 3,
  maxScore: 100
} as const;

/** Types that read the same both ways: stored from the lower prompt alias to the higher one. */
export const symmetricSourceRelationTypes: ReadonlyArray<string> = ["contrasts", "similar_to"];
/** Types kept only when the settings include weak types. */
export const weakSourceRelationTypes: ReadonlyArray<string> = ["mentions", "related"];

/**
 * One item of a source verdict as the decider answered it, endpoints and chunks resolved to IDs. It
 * is stored with every decision, raw scores apart from the floors, so the floors can be tuned again
 * on stored verdicts without new calls.
 */
export const SourceDecisionItemSchema = z
  .object({
    from: z.string().uuid(),
    to: z.string().uuid(),
    type: AtomicNoteRelationTypeSchema,
    importance: z.number().int().min(0).max(sourceDecisionLimits.maxScore),
    confidence: z.number().int().min(0).max(sourceDecisionLimits.maxScore),
    fromChunks: z.array(z.string().uuid()).min(1).max(sourceDecisionLimits.maxChunksPerSide),
    toChunks: z.array(z.string().uuid()).min(1).max(sourceDecisionLimits.maxChunksPerSide),
    /** 0 for the first answer, 1 for the repair. */
    attempt: z.number().int().min(0).max(1)
  })
  .strict();
export type SourceDecisionItem = z.infer<typeof SourceDecisionItemSchema>;

/** Whether a raw verdict passes the floors of the given settings (scores are integer / 100). */
export function sourceDecisionPassesFloors(
  item: Pick<SourceDecisionItem, "type" | "importance" | "confidence">,
  settings: Pick<SourceRelationSettings, "minImportance" | "minConfidence" | "includeWeakTypes">
): boolean {
  return (
    item.importance / sourceDecisionLimits.maxScore >= settings.minImportance &&
    item.confidence / sourceDecisionLimits.maxScore >= settings.minConfidence &&
    (settings.includeWeakTypes || !weakSourceRelationTypes.includes(item.type))
  );
}

/** What source-relation explanations are written from: up to this many passages per source. */
export const sourceRelationExplanationLimits = { passagesPerSource: 2 } as const;

export const SourceRelationEvidenceSchema = z
  .object({
    id: z.string().uuid(),
    origin: z.enum(["atomic_notes", "source_analysis"]),
    sourceChunkId: z.string().uuid(),
    targetChunkId: z.string().uuid(),
    sourceSpanId: z.string().uuid().nullable(),
    targetSpanId: z.string().uuid().nullable(),
    sourceExcerpt: z.string(),
    targetExcerpt: z.string(),
    sourceNoteId: z.string().uuid().nullable(),
    targetNoteId: z.string().uuid().nullable(),
    noteRelationId: z.string().uuid().nullable(),
    current: z.boolean()
  })
  .strict();

export const SourceRelationViewSchema = z
  .object({
    id: z.string().uuid(),
    sourceItemId: z.string().uuid(),
    targetSourceItemId: z.string().uuid(),
    sourceTitle: z.string(),
    targetTitle: z.string(),
    relationType: AtomicNoteRelationTypeSchema,
    /** Prose stored by the earlier matcher; null for relations decided without prose. */
    sourceIdea: z.string().nullable(),
    targetIdea: z.string().nullable(),
    explanation: z.string().nullable(),
    /**
     * The explanation written when the owner opened the relation, while its inputs still hold; its
     * source references are `<source-ref id="..." />` tags. Null when none is written or current.
     */
    writtenExplanation: z
      .object({ text: z.string().min(1), writtenBy: z.string().min(1) })
      .strict()
      .nullable(),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    status: AtomicNoteRelationStatusSchema,
    current: z.boolean(),
    evidence: z.array(SourceRelationEvidenceSchema).max(100),
    updatedAt: z.string().datetime()
  })
  .strict();
export type SourceRelationView = z.infer<typeof SourceRelationViewSchema>;

export const SourceRelationsPageSchema = z
  .object({
    relations: z.array(SourceRelationViewSchema).max(100),
    hasMore: z.boolean(),
    total: z.number().int().nonnegative()
  })
  .strict();
export const SourceRelationReviewInputSchema = z
  .object({
    id: z.string().uuid(),
    status: AtomicNoteRelationStatusSchema,
    expectedUpdatedAt: z.string().datetime()
  })
  .strict();
