import { z } from "zod";
import {
  AtomicNoteRelationStatusSchema,
  AtomicNoteRelationTypeSchema,
  NoteRelationReadTypeSchema,
  type AtomicNoteRelationType,
  type NoteRelationWriteType
} from "./knowledge.js";

/**
 * Source-relation settings: unknown fields are refused. The shortlist settings design E deleted
 * (F3 D27) left stored settings through the matching settings v2 migration.
 */
export const SourceRelationSettingsSchema = z
  .object({
    evidenceChunksPerSource: z.number().int().min(1).max(12).default(3),
    evidenceMaxCharacters: z.number().int().min(300).max(6000).default(1000),
    summaryMaxCharacters: z.number().int().min(300).max(6000).default(1200),
    maxOutputTokens: z.number().int().min(512).max(16384).default(4096),
    maxRelationsPerPair: z.number().int().min(1).max(20).default(4),
    maxInputTokens: z.number().int().min(2_000).max(200_000).default(20_000),
    minImportance: z.number().min(0).max(1).default(0.75),
    minConfidence: z.number().min(0).max(1).default(0.85),
    includeWeakTypes: z.boolean().default(false)
  })
  .strict();
export type SourceRelationSettings = z.infer<typeof SourceRelationSettingsSchema>;
export const defaultSourceRelationSettings: SourceRelationSettings =
  SourceRelationSettingsSchema.parse({});

/**
 * How far source matching got for a work, stored in the stage checkpoint metadata (design E, F3
 * D27): the relations its note connections promoted with no call, the nearest sources discovery
 * selected and how many of them the judge decided. Only `budgetExhausted` means a pair could not be
 * completed. Checkpoints written before design E also hold the shortlist's cap flags; they are read
 * and ignored.
 */
export const SourceRelationCoverageSchema = z.object({
  judgedPairs: z.number().int().nonnegative(),
  candidatePairs: z.number().int().nonnegative(),
  /** A pair could not be completed because the input token budget was exhausted. */
  budgetExhausted: z.boolean(),
  /** Source relations promoted or refreshed from note relations; absent before design E. */
  promoted: z.number().int().nonnegative().optional()
});
export type SourceRelationCoverage = z.infer<typeof SourceRelationCoverageSchema>;

/**
 * The compact, score-only source verdict (`source-relations-v6`, and F3's per-pair `-v5`; docs/plan.md
 * decision 17): a pair of works answers at most `maxItemsPerPair` items `[from, to, type, importance,
 * confidence, [from chunks], [to chunks]]`, with integer scores from 0 to 100 and no prose.
 */
export const sourceDecisionLimits = {
  maxItemsPerPair: 2,
  maxChunksPerSide: 3,
  maxScore: 100
} as const;

/**
 * Types that read the same both ways: the judge's legacy `contrasts` and `similar_to` (stored from
 * the lower prompt alias to the higher one) and the write vocabulary's `contradicts` and `same_as`.
 */
export const symmetricSourceRelationTypes: ReadonlyArray<string> = [
  "contrasts",
  "similar_to",
  "contradicts",
  "same_as"
];
/** Types kept only when the settings include weak types. */
export const weakSourceRelationTypes: ReadonlyArray<string> = ["mentions", "related"];

/**
 * Stored types that name the same relation: the judge's `contrasts` is written as `contradicts`
 * (F3 D27), so a relation saved as `contrasts` before is the same relation, for merging and for a
 * rejection the owner made.
 */
export function equivalentSourceRelationTypes(type: string): string[] {
  if (type === "contradicts" || type === "contrasts") return ["contradicts", "contrasts"];
  return [type];
}

/**
 * The type a v5 verdict is written with (F3 D27): `contrasts` becomes `contradicts`; `similar_to`
 * is dropped as weak unless the typed configuration keeps it (Q14); every other type is written as
 * answered (the weak `mentions` and `related` stay under the floors).
 */
export function sourceVerdictWriteType(
  type: AtomicNoteRelationType,
  options: { keepSimilarTo: boolean }
): string | null {
  if (type === "contrasts") return "contradicts";
  if (type === "similar_to") return options.keepSimilarTo ? type : null;
  return type;
}

/**
 * The write type a note relation is promoted with (F3 D27): a write type as stored, the legacy
 * `contrasts` as `contradicts`; the legacy `similar_to`, `mentions` and `related` are not promoted
 * (`similar_to` never becomes `same_as`, D10). Null: the relation promotes nothing.
 */
export function promotableNoteRelationType(type: string | null): NoteRelationWriteType | null {
  switch (type) {
    case "supports":
    case "contradicts":
    case "extends":
    case "depends_on":
    case "example_of":
    case "clarifies":
    case "same_as":
      return type;
    case "contrasts":
      return "contradicts";
    default:
      return null;
  }
}

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

/**
 * How a source relation came to be (F3 D27): `judged` by the source judge, with its scores, or
 * `promoted` from typed shown note relations (applied, kept or suggested) with no call, with no
 * scores (unknown stays unknown).
 */
export const SourceRelationOriginSchema = z.enum(["judged", "promoted"]);
export type SourceRelationOrigin = z.infer<typeof SourceRelationOriginSchema>;

export const SourceRelationViewSchema = z
  .object({
    id: z.string().uuid(),
    sourceItemId: z.string().uuid(),
    targetSourceItemId: z.string().uuid(),
    sourceTitle: z.string(),
    targetTitle: z.string(),
    /** The write vocabulary or a legacy type an older row keeps. */
    relationType: NoteRelationReadTypeSchema,
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
    /** The judge's scores; null on a promoted relation, which no judge scored. */
    importance: z.number().min(0).max(1).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    origin: SourceRelationOriginSchema,
    /** The note relations it is promoted from (a judged relation may carry them too); else null. */
    supportCount: z.number().int().positive().nullable(),
    /**
     * Whether it reads from its source to its target (decision 31b): a directed type the judge
     * decided, or one that rests on a note relation whose direction the owner or the decider gave.
     * False: the sources are linked and nothing says who extends whom.
     */
    directed: z.boolean(),
    /**
     * Decision 29: an automatic relation nobody kept, judged or promoted alike. True while the
     * relation has no human verdict (`status` pending review) and no note relation that reads as
     * applied supports it; it stops being one when the owner keeps it (`status` accepted) or any
     * of its supporting note relations reads as applied (kept by the owner, or an existing applied
     * one, D47). The owner's removal (`status` rejected) is final.
     */
    suggested: z.boolean(),
    status: AtomicNoteRelationStatusSchema,
    current: z.boolean(),
    evidence: z.array(SourceRelationEvidenceSchema).max(100),
    updatedAt: z.string().datetime()
  })
  .strict();
export type SourceRelationView = z.infer<typeof SourceRelationViewSchema>;

/**
 * The one state a source relation reads as (decision 29): `suggested` while it is automatic and
 * nobody kept it, `accepted` once the owner kept it, `confirmed` while it has no verdict of its own
 * but rests on a note relation that reads as applied, `rejected` once the owner removed it.
 */
export type SourceRelationState = "suggested" | "confirmed" | "accepted" | "rejected";

export function sourceRelationState(
  relation: Pick<SourceRelationView, "status" | "suggested">
): SourceRelationState {
  if (relation.status !== "pending_review") return relation.status;
  return relation.suggested ? "suggested" : "confirmed";
}

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
