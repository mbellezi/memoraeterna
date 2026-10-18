import { z } from "zod";

import {
  AtomicNoteStatusSchema,
  NoteRelationBandSchema,
  NoteRelationVetoSourceSchema,
  type NoteRelationBand
} from "./knowledge.js";
import { ObjectLocateResultSchema } from "./object-address.js";

/**
 * `notes.page`: everything a Note page renders, in one read-only response without AI. The note,
 * its evidence with exact anchors, where it is (`objects.locate`) and the first page of its
 * relations to other notes, in three groups (shown, withdrawn, earlier versions);
 * `notes.relations` pages more relations of one group. The legacy fused score is never part of the
 * contract: it is not a confidence. The calibrated probability is (F4 Diagnostics read it), but no
 * renderer shows it as a percentage: a relation says "Strong" or "Possible" (D42).
 */
export const notePageLimits = {
  /** Relations in the first answer and in each further page. */
  relationPage: 20,
  relationPageMax: 50,
  /** Relations of the withdrawn and earlier-version groups in the first answer and each page. */
  groupPage: 20,
  /** Evidence passages listed; the total is always exact. */
  evidence: 100,
  /** The other note's passage shown in a relation card. */
  excerptCharacters: 600,
  /** The longest evidence excerpt the page reads (a chunk is at most 2,400 characters). */
  evidenceExcerptCharacters: 20_000,
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

/**
 * The groups of a note's relations: the shown ones (applied, suggested or kept), the ones an
 * automatic veto withdrew (the owner keeps or removes them) and, apart, the applied ones to an
 * earlier version of a note (D9's fifth predicate).
 */
export const noteRelationGroups = ["shown", "withdrawn", "earlier"] as const;
export const NoteRelationGroupSchema = z.enum(noteRelationGroups);
export type NoteRelationGroup = z.infer<typeof NoteRelationGroupSchema>;

export const NoteRelationsInputSchema = z
  .object({
    noteId: z.string().uuid(),
    /** Which group is paged; the main list by default. */
    group: NoteRelationGroupSchema.default("shown"),
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

/** True when `value` has at most `max` characters, counted as code points like PostgreSQL does. */
export function withinCharacters(value: string, max: number): boolean {
  return value.length <= max || Array.from(value).length <= max;
}

/** `value` cut to `max` characters (code points), never inside a surrogate pair. */
export function clipCharacters(value: string, max: number): string {
  return value.length <= max ? value : Array.from(value).slice(0, max).join("");
}

/**
 * A string bounded in characters, the unit `left()`, `char_length` and the checks of the database
 * count. Zod's `max` counts UTF-16 units, so one emoji at the bound would fail a page that the
 * database cut correctly: every bound that SQL cuts or checks uses this.
 */
const boundedCharacters = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .refine((value) => withinCharacters(value, max));

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
    excerpt: boundedCharacters(notePageLimits.evidenceExcerptCharacters),
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
    text: boundedCharacters(notePageLimits.explanationCharacters, 1),
    /** The model that wrote the text; null when nobody known wrote it. */
    writtenBy: z.string().min(1).nullable()
  })
  .strict();
export type NotePageRelationExplanation = z.infer<typeof NotePageRelationExplanationSchema>;

/**
 * What a relation is now (D9, D42). F3 applies no relation automatically (plan decision 29): an
 * automatic relation is suggested until the owner keeps or removes it, and the owner's Keep makes it
 * kept. Applied remains for the rows an apply band or the legacy matcher wrote.
 */
export const NotePageRelationStateSchema = z.enum(["applied", "suggested", "withdrawn", "kept"]);
export type NotePageRelationState = z.infer<typeof NotePageRelationStateSchema>;

/** Whether the decider's band was calibrated when it decided (frozen or provisional) or not. */
export const NoteRelationCalibrationSchema = z.enum(["frozen", "provisional", "uncalibrated"]);
export type NoteRelationCalibration = z.infer<typeof NoteRelationCalibrationSchema>;

/**
 * Who did one step of a relation (decided it, typed it, wrote its explanation): the model and where
 * it ran. `kind` is null when the run behind the step is no longer known: unknown stays unknown.
 */
export const NotePageActorSchema = z
  .object({
    model: z.string().min(1),
    kind: z.enum(["local", "remote"]).nullable()
  })
  .strict();
export type NotePageActor = z.infer<typeof NotePageActorSchema>;

export const NotePageRelationSchema = z
  .object({
    id: z.string().uuid(),
    /** The stored type; later phases add values, so renderers map unknown ones safely. */
    type: z.string().min(1).max(40),
    /**
     * Read from the direction the relation may be shown in, never from the stored column order
     * (decision 31b): `unknown` is a relation that is only linked, with no subject and no arrow.
     */
    direction: z.enum(["outgoing", "incoming", "unknown"]),
    /**
     * Who gave a shown direction: the owner on Keep, or the Decisions decider's clear asymmetry;
     * null when the relation has none to show or is a legacy row, which reads as it was decided.
     */
    directionSource: z.enum(["decider", "owner"]).nullable(),
    /**
     * Suggested, withdrawn by an automatic veto, kept by the owner, or applied (a legacy row or one
     * an apply band wrote). A relation the owner removed is listed nowhere.
     */
    state: NotePageRelationStateSchema,
    /** Automation's band; null on a legacy row. Nothing assumes an apply band exists. */
    band: NoteRelationBandSchema.nullable(),
    /** The calibration the band was decided under; null when the row records none. */
    calibration: NoteRelationCalibrationSchema.nullable(),
    /**
     * The calibrated probability; null on legacy rows and while the decider is not calibrated. It
     * orders the list and is kept for diagnostics: it is never shown as a percentage.
     */
    probability: z.number().min(0).max(1).nullable(),
    /** Who withdrew the relation, for a withdrawn one. */
    vetoSource: NoteRelationVetoSourceSchema.nullable(),
    /** The decider model; null for an acceptance without a decider. */
    decidedBy: NotePageActorSchema.nullable(),
    /** The model that typed the pair (relations v2); null for an untyped or legacy relation. */
    typedBy: NotePageActorSchema.nullable(),
    /** The model that wrote the explanation, when the relation has one. */
    explainedBy: NotePageActorSchema.nullable(),
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
        /**
         * The source the note was generated from; null when that source was deleted. A knowledge-owned
         * note outlives its home source, and its relations are still listed.
         */
        sourceItemId: z.string().uuid().nullable(),
        /** Empty when the home source is gone. */
        sourceTitle: z.string(),
        /** The other note's primary passage; null when its chunk is gone. */
        passage: z
          .object({
            chunkId: z.string().uuid(),
            sourceSpanId: z.string().uuid().nullable(),
            chunkIndex: z.number().int().nonnegative(),
            excerpt: boundedCharacters(notePageLimits.excerptCharacters),
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
    /** The shown relations: applied, suggested and kept ones (D9). */
    relations: NotePageRelationsSchema,
    /** The relations an automatic veto withdrew; the owner keeps or removes them (D15). */
    withdrawn: NotePageRelationsSchema,
    /**
     * Applied relations to an earlier (superseded) version of a note, as F1b listed them (R29):
     * never counted among the shown ones, drawn or promoted.
     */
    earlierVersions: NotePageRelationsSchema
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
    text: clipCharacters(input.text, notePageLimits.explanationCharacters),
    writtenBy: input.decisionSource === "model" ? knownModel(input.matchingModel) : null
  };
}

/** The word an automatic confidence is shown as (D42); never a percentage. */
export type NoteRelationBandWord = "strong" | "possible" | "uncalibrated";

/**
 * The word of each band. F3 applies no relation automatically (plan decision 29): every automatic
 * relation is a suggestion until the owner keeps or removes it, so a library holds "possible" and
 * "uncalibrated" relations, the owner's kept ones and withdrawn ones, and "strong" only on rows an
 * apply band wrote. A later tier (typed suggestions the strict typer confirms) adds its word here
 * and its two lines of copy (`notePage.band.<word>`): a test fails for a band without a word.
 */
export const noteRelationBandWords: Readonly<Record<NoteRelationBand, NoteRelationBandWord>> = {
  apply: "strong",
  suggest: "possible"
};

/**
 * The band word of a relation, for what automation said about it: the word of its band, or
 * "uncalibrated" when the decider had no calibration (it only ever suggests, D18). A relation the
 * owner decided (kept) or an automatic veto withdrew says its state instead, and a legacy row (no
 * band) says nothing. Nothing assumes an apply band, or an automatic "applied" state, exists.
 */
export function relationBandWord(relation: {
  band: NoteRelationBand | null;
  calibration: NoteRelationCalibration | null;
  state?: NotePageRelationState | undefined;
}): NoteRelationBandWord | null {
  if (relation.state === "kept" || relation.state === "withdrawn") return null;
  if (relation.band === null) return null;
  if (relation.calibration === "uncalibrated") return "uncalibrated";
  return noteRelationBandWords[relation.band];
}

/** The calibration state a relation row records in its metadata; null on a legacy row. */
export function noteRelationCalibration(metadata: unknown): NoteRelationCalibration | null {
  const value =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).calibration
      : undefined;
  const parsed = NoteRelationCalibrationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `relations.review` (F3 D15): the owner's verdict on a suggested or withdrawn relation. A verdict
 * is final in both directions (I-R2, I-R3): automation never changes a kept relation or creates a
 * removed pair again, and a second review changes nothing.
 */
export const RelationReviewInputSchema = z
  .object({
    relationId: z.string().uuid(),
    verdict: z.enum(["keep", "remove"]),
    /**
     * Keep only (decision 31b): the owner's direction for a relation of a directed type, as the note
     * that is its subject ("this note extends the other"), or null for "no direction". Left out, the
     * relation keeps the direction it has. It has no meaning for a relation that reads both ways.
     */
    subjectNoteId: z.string().uuid().nullable().optional()
  })
  .strict();
export type RelationReviewInput = z.infer<typeof RelationReviewInputSchema>;

export const RelationReviewResultSchema = z
  .object({
    relationId: z.string().uuid(),
    /** The relation's verdict now: the one just written, or the earlier one, which stays. */
    outcome: z.enum(["kept", "removed"]),
    /** False when the relation already had a human verdict: nothing was written. */
    changed: z.boolean()
  })
  .strict();
export type RelationReviewResult = z.infer<typeof RelationReviewResultSchema>;
