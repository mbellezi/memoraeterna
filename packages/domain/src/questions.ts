import { z } from "zod";

import { objectAnchorKeys } from "./object-address.js";

/**
 * Questions: what Ask stores (F5 D14). A Question is the owner's own words, its scope, and one or
 * more answer versions whose paragraphs cite notes, sources, topics and passages by identity. The
 * stored shapes below are the ones the questions tables hold; the live stream and the IPC views
 * (`S/ipc-questions.ts`) are built from them.
 */

/** The longest question and the most sources a scope names; the table and the IPC share them. */
export const questionTextMaxLength = 2000;
export const questionScopeMaxSources = 50;

/** Answer shape bounds: Ask writes at most six paragraphs; a little room keeps older shapes valid. */
export const questionAnswerMaxParagraphs = 12;
export const questionParagraphMaxLength = 6000;
export const questionParagraphMaxCitations = 12;
export const questionAnswerMaxCitations = 60;

export const askQuestionStatuses = ["running", "complete", "canceled", "failed"] as const;
export const AskQuestionStatusSchema = z.enum(askQuestionStatuses);
export type AskQuestionStatus = z.infer<typeof AskQuestionStatusSchema>;

/** An answer version never runs: it is stored when its attempt ends. */
export const questionAnswerStatuses = ["complete", "canceled", "failed"] as const;
export const QuestionAnswerStatusSchema = z.enum(questionAnswerStatuses);
export type QuestionAnswerStatus = z.infer<typeof QuestionAnswerStatusSchema>;

export const questionPrivacies = ["offline_only", "allow_remote"] as const;
export const QuestionPrivacySchema = z.enum(questionPrivacies);
export type QuestionPrivacy = z.infer<typeof QuestionPrivacySchema>;

export const questionModes = ["text", "hybrid"] as const;
export const QuestionModeSchema = z.enum(questionModes);
export type QuestionMode = z.infer<typeof QuestionModeSchema>;

/** What a question asks about: the whole library (the default), one topic, or chosen sources. */
export const AskScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }).strict(),
  z.object({ kind: z.literal("topic"), topicId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal("sources"),
      sourceIds: z.array(z.string().uuid()).min(1).max(questionScopeMaxSources)
    })
    .strict()
]);
export type AskScope = z.infer<typeof AskScopeSchema>;

/** The kinds of target an answer cites. A passage is cited as a chunk, under its source. */
export const questionCitationKinds = ["note", "source", "topic", "chunk"] as const;
export const QuestionCitationKindSchema = z.enum(questionCitationKinds);
export type QuestionCitationKind = z.infer<typeof QuestionCitationKindSchema>;

/** An anchor inside the cited object: the same keys the address grammar names. */
export const QuestionAnchorSchema = z
  .object(
    Object.fromEntries(
      objectAnchorKeys.map((key) => [key, z.string().uuid().optional()])
    ) as Record<(typeof objectAnchorKeys)[number], z.ZodOptional<z.ZodString>>
  )
  .strict();

/** One citation as it is stored: its ordinal (the marker in the paragraphs) and its target. */
export const QuestionCitationInputSchema = z
  .object({
    ordinal: z.number().int().min(1),
    kind: QuestionCitationKindSchema,
    targetId: z.string().uuid(),
    anchor: QuestionAnchorSchema.optional()
  })
  .strict();
export type QuestionCitationInput = z.infer<typeof QuestionCitationInputSchema>;

/** One stored paragraph: Markdown and the ordinals of the citations it rests on. */
export const QuestionParagraphSchema = z
  .object({
    markdown: z.string().max(questionParagraphMaxLength),
    citations: z
      .array(z.number().int().min(1))
      .max(questionParagraphMaxCitations)
      .refine((ordinals) => new Set(ordinals).size === ordinals.length, {
        message: "A paragraph names each citation once."
      })
  })
  .strict();
export type QuestionParagraph = z.infer<typeof QuestionParagraphSchema>;

/** One citation as a reader sees it: the address of its object and an optional anchor inside it. */
export const QuestionCitationSchema = z
  .object({
    ordinal: z.number().int().min(1),
    /** Null when the target is gone and the address cannot be rebuilt (a deleted passage). */
    address: z.string().nullable(),
    anchor: QuestionAnchorSchema.optional(),
    /** The target no longer exists: the citation reads "unavailable". */
    unavailable: z.boolean(),
    /** The target changed since the answer was stored (or is gone). */
    stale: z.boolean()
  })
  .strict();
export type QuestionCitation = z.infer<typeof QuestionCitationSchema>;

/** The route, provider, model, lane and prompt revision behind an answer; extra keys are kept. */
export const QuestionProvenanceSchema = z
  .object({
    route: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    runtime: z.string().optional(),
    lane: z.string().optional(),
    promptRevisionId: z.string().optional()
  })
  .passthrough();
export type QuestionProvenance = z.infer<typeof QuestionProvenanceSchema>;

/**
 * The words of a new question. The row is inserted before retrieval starts, so this is all the
 * repository needs to make `memora://question/<id>` valid.
 */
export const QuestionCreateSchema = z
  .object({
    id: z.string().uuid().optional(),
    text: z.string().min(1).max(questionTextMaxLength),
    language: z.string().min(1).max(16).default("und"),
    scope: AskScopeSchema.default({ kind: "library" }),
    privacy: QuestionPrivacySchema,
    mode: QuestionModeSchema.default("text")
  })
  .strict();
export type QuestionCreate = z.input<typeof QuestionCreateSchema>;

/** One answer version to store with its citations (one transaction, hashes taken from the data). */
export const QuestionAnswerInputSchema = z
  .object({
    paragraphs: z.array(QuestionParagraphSchema).max(questionAnswerMaxParagraphs),
    citations: z.array(QuestionCitationInputSchema).max(questionAnswerMaxCitations),
    provenance: QuestionProvenanceSchema,
    status: QuestionAnswerStatusSchema,
    startedAt: z.date(),
    completedAt: z.date().optional(),
    /** The message key of the failure, kept on the question when the answer failed. */
    errorKey: z.string().min(1).max(200).optional()
  })
  .strict()
  .superRefine((answer, context) => {
    const declared = new Set<number>();
    for (const citation of answer.citations) {
      if (declared.has(citation.ordinal))
        context.addIssue({
          code: "custom",
          path: ["citations"],
          message: `Citation ${citation.ordinal} appears twice.`
        });
      declared.add(citation.ordinal);
    }
    answer.paragraphs.forEach((paragraph, index) => {
      for (const ordinal of paragraph.citations)
        if (!declared.has(ordinal))
          context.addIssue({
            code: "custom",
            path: ["paragraphs", index, "citations"],
            message: `Citation ${ordinal} is not stored with the answer.`
          });
    });
  });
export type QuestionAnswerInput = z.input<typeof QuestionAnswerInputSchema>;
