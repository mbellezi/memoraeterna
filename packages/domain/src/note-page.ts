import { z } from "zod";

import { AtomicNoteStatusSchema } from "./knowledge.js";
import { ObjectLocateResultSchema } from "./object-address.js";

/**
 * `notes.page`: everything a Note page renders, in one read-only response without AI. The note,
 * its evidence with exact anchors, where it is (`objects.locate`) and the first page of its
 * relations to other notes; `notes.relations` pages more relations. Scores are never part of the
 * contract: a fused legacy score is not a confidence (calibration is docs/plan.md F3).
 */
export const notePageLimits = {
  /** Relations in the first answer and in each further page. */
  relationPage: 20,
  relationPageMax: 50,
  /** Evidence passages listed; the total is always exact. */
  evidence: 100,
  /** The other note's passage shown in a relation card. */
  excerptCharacters: 600,
  successors: 10,
  /** A relation explanation longer than this is clipped when read. */
  explanationCharacters: 4_000
} as const;

export const NotePageInputSchema = z
  .object({
    noteId: z.string().uuid(),
    relationLimit: z
      .number()
      .int()
      .min(1)
      .max(notePageLimits.relationPageMax)
      .default(notePageLimits.relationPage)
  })
  .strict();
export type NotePageInput = z.infer<typeof NotePageInputSchema>;

export const NoteRelationsInputSchema = z
  .object({
    noteId: z.string().uuid(),
    offset: z.number().int().min(0).max(100_000),
    limit: z
      .number()
      .int()
      .min(1)
      .max(notePageLimits.relationPageMax)
      .default(notePageLimits.relationPage)
  })
  .strict();
export type NoteRelationsInput = z.infer<typeof NoteRelationsInputSchema>;

const isoSchema = z.string().datetime();

/** Who the note's text belongs to: the AI, the person (an edit) or a reviewed note evolution. */
export const NoteAuthorshipSchema = z.enum(["ai", "edited", "evolution"]);
export type NoteAuthorship = z.infer<typeof NoteAuthorshipSchema>;

export const NotePageNoteSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    ideaStatement: z.string().min(1),
    bodyMarkdown: z.string().min(1),
    /** Content language; null when it was stored as unknown. */
    language: z.string().min(1).nullable(),
    status: AtomicNoteStatusSchema,
    /** The note was merged or split into newer notes; its history is kept. */
    superseded: z.boolean(),
    ownership: z.enum(["source", "knowledge"]),
    /** A person edited it: automation never changes it again without approval. */
    humanProtected: z.boolean(),
    authorship: NoteAuthorshipSchema,
    generationModel: z.string().min(1),
    /** The source the note was generated from. */
    homeSourceId: z.string().uuid(),
    createdAt: isoSchema,
    /** Also the optimistic-concurrency token of an edit or a review. */
    updatedAt: isoSchema,
    reviewedAt: isoSchema.nullable(),
    /** Time of the latest human edit. */
    lastEditedAt: isoSchema.nullable()
  })
  .strict();
export type NotePageNote = z.infer<typeof NotePageNoteSchema>;

export const NotePageEvidenceSchema = z
  .object({
    chunkId: z.string().uuid(),
    /** The chunk's own source item: a section of a hierarchical work. */
    sourceItemId: z.string().uuid(),
    documentId: z.string().uuid().nullable(),
    sourceSpanId: z.string().uuid().nullable(),
    sourceTitle: z.string(),
    /** Title of the work (the library root) when it differs from `sourceTitle`. */
    workTitle: z.string().nullable(),
    chunkIndex: z.number().int().nonnegative().nullable(),
    /** Offsets of the passage in the document's Markdown. */
    range: z
      .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    page: z.number().int().positive().nullable(),
    excerpt: z.string().max(20_000),
    language: z.string().min(1).nullable(),
    /** The passage the note was generated from first. */
    primary: z.boolean(),
    /** The passage still belongs to the current version of its source. */
    current: z.boolean(),
    /** False when only the retained snapshot of a deleted source survives. */
    sourceAvailable: z.boolean()
  })
  .strict();
export type NotePageEvidence = z.infer<typeof NotePageEvidenceSchema>;

export const NotePageRelationExplanationSchema = z
  .object({
    text: z.string().min(1).max(notePageLimits.explanationCharacters),
    /** The model that wrote the text; null when nobody known wrote it. */
    writtenBy: z.string().min(1).nullable()
  })
  .strict();
export type NotePageRelationExplanation = z.infer<typeof NotePageRelationExplanationSchema>;

export const NotePageRelationSchema = z
  .object({
    id: z.string().uuid(),
    /** The stored type; later phases add values, so renderers map unknown ones safely. */
    type: z.string().min(1).max(40),
    /** Read from the decided direction, never from the stored column order. */
    direction: z.enum(["outgoing", "incoming", "unknown"]),
    /** The decider model; null for an acceptance without a decider. */
    decidedBy: z.string().min(1).nullable(),
    /** Null when no current explanation exists; one is written when the relation is opened. */
    explanation: NotePageRelationExplanationSchema.nullable(),
    other: z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1),
        ideaStatement: z.string().min(1),
        language: z.string().min(1).nullable(),
        status: AtomicNoteStatusSchema,
        superseded: z.boolean(),
        authorship: NoteAuthorshipSchema,
        sourceItemId: z.string().uuid(),
        sourceTitle: z.string(),
        /** The other note's primary passage; null when its chunk is gone. */
        passage: z
          .object({
            chunkId: z.string().uuid(),
            sourceSpanId: z.string().uuid().nullable(),
            chunkIndex: z.number().int().nonnegative(),
            excerpt: z.string().max(notePageLimits.excerptCharacters),
            language: z.string().min(1).nullable()
          })
          .strict()
          .nullable()
      })
      .strict()
  })
  .strict();
export type NotePageRelation = z.infer<typeof NotePageRelationSchema>;

export const NotePageRelationsSchema = z
  .object({
    items: z.array(NotePageRelationSchema).max(notePageLimits.relationPageMax),
    total: z.number().int().nonnegative()
  })
  .strict();
export type NotePageRelations = z.infer<typeof NotePageRelationsSchema>;

export const NotePageSchema = z
  .object({
    note: NotePageNoteSchema,
    successors: z
      .array(z.object({ id: z.string().uuid(), title: z.string().min(1) }).strict())
      .max(notePageLimits.successors),
    evidence: z
      .object({
        items: z.array(NotePageEvidenceSchema).max(notePageLimits.evidence),
        total: z.number().int().nonnegative()
      })
      .strict(),
    /** Exactly what `objects.locate` answers for `memora://note/<id>`. */
    placement: ObjectLocateResultSchema,
    relations: NotePageRelationsSchema
  })
  .strict();
export type NotePage = z.infer<typeof NotePageSchema>;

/** An edit makes a note the person's; a reviewed evolution is the next claim; otherwise the AI's. */
export function noteAuthorship(facts: { edited: boolean; evolution: boolean }): NoteAuthorship {
  if (facts.edited) return "edited";
  return facts.evolution ? "evolution" : "ai";
}

/** A blank value or a message key (`knowledge.relations.explanations.*`) is not an explanation. */
export function isRealRelationExplanation(text: string | null | undefined): text is string {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith("knowledge.");
}

/** A blank model name is unknown, so one odd row never fails a whole page. */
export function knownModel(model: string | null | undefined): string | null {
  return typeof model === "string" && model.trim() ? model : null;
}

/**
 * The explanation stored by the decide call of a matching run. Only real text counts, and only a
 * decision taken by the model in that call names its writer.
 */
export function relationExplanation(input: {
  text: string | null | undefined;
  decisionSource: string | null | undefined;
  matchingModel: string | null | undefined;
}): NotePageRelationExplanation | null {
  if (!isRealRelationExplanation(input.text)) return null;
  return {
    text: input.text.slice(0, notePageLimits.explanationCharacters),
    writtenBy: input.decisionSource === "model" ? knownModel(input.matchingModel) : null
  };
}
