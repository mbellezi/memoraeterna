// The questions area of the IPC (F5 D14, D30): what the renderer may ask of the main process about
// Ask: asking and canceling (T121), then reading one Question, listing, deleting, asking again and
// clearing (T129). The area is wired into `DesktopApi`, the preload and `registerIpcHandlers` by the
// wave's wiring card (T170); these are its own channels and its own typed surface, so the schemas,
// the main handlers and the preload bridge agree on one source.
import {
  AskQuestionStatusSchema,
  AskScopeSchema,
  ObjectAddressTextSchema,
  QuestionAnchorSchema,
  QuestionAnswerStatusSchema,
  QuestionModeSchema,
  QuestionPrivacySchema,
  QuestionProvenanceSchema
} from "@app/domain";
import { z } from "zod";

/** The channels of the area, `app:questions:*`; T170 spreads them into `ipcChannels`. */
export const questionsChannels = {
  ask: "app:questions:ask",
  cancel: "app:questions:cancel",
  get: "app:questions:get",
  list: "app:questions:list",
  delete: "app:questions:delete",
  askAgain: "app:questions:ask-again",
  clear: "app:questions:clear"
} as const;
export type QuestionsChannel = (typeof questionsChannels)[keyof typeof questionsChannels];

/**
 * The bounds of a question's words. The answer is written by the consultation pipeline, whose
 * input takes 3 to 1000 characters after trimming, so a longer text is refused here (before a row is
 * stored for it) rather than failing later. The table itself holds up to 2000.
 */
export const questionAskTextLimits = { min: 3, max: 1000 } as const;

/**
 * `questions.ask`: the words, and optionally what to ask about (the whole library by default, one
 * topic, or up to 50 chosen sources), the privacy (offline only by default) and the retrieval mode
 * (text by default).
 */
export const QuestionsAskInputSchema = z
  .object({
    text: z.string().trim().min(questionAskTextLimits.min).max(questionAskTextLimits.max),
    scope: AskScopeSchema.optional(),
    privacy: QuestionPrivacySchema.optional(),
    mode: QuestionModeSchema.optional()
  })
  .strict();
export type QuestionsAskInput = z.infer<typeof QuestionsAskInputSchema>;

/**
 * What `questions.ask` answers as soon as the Question exists: `memora://question/<questionId>` is
 * valid from here on. The answer itself arrives as `consultation.delta` and `consultation.status`
 * events carrying `requestId`.
 */
export const QuestionsAskResultSchema = z
  .object({ questionId: z.string().uuid(), requestId: z.string().uuid() })
  .strict();
export type QuestionsAskResult = z.infer<typeof QuestionsAskResultSchema>;

export const QuestionsCancelInputSchema = z.object({ requestId: z.string().uuid() }).strict();
export type QuestionsCancelInput = z.infer<typeof QuestionsCancelInputSchema>;

/** The most questions one page of `questions.list` holds (the repository's own bound). */
export const questionListMaxLimit = 50;

export const QuestionsIdInputSchema = z.object({ id: z.string().uuid() }).strict();
export type QuestionsIdInput = z.infer<typeof QuestionsIdInputSchema>;

/**
 * `questions.list`: newest first, keyset-paged. `cursor` is the opaque `next` of the page before;
 * `query` matches the question's own words (accents and case folded).
 */
export const QuestionsListInputSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(questionListMaxLimit).optional(),
    query: z.string().max(200).optional()
  })
  .strict();
export type QuestionsListInput = z.infer<typeof QuestionsListInputSchema>;

/**
 * A question as a list shows it: no answer text. `status` is what the Question is now: a Question
 * that the store still holds as running but that no Ask of this session is writing reads `failed`
 * (the app quit while it ran).
 */
export const QuestionListItemViewSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string(),
    language: z.string(),
    scope: AskScopeSchema,
    status: AskQuestionStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    answerCount: z.number().int().nonnegative()
  })
  .strict();
export type QuestionListItemView = z.infer<typeof QuestionListItemViewSchema>;

export const QuestionsListResultSchema = z
  .object({
    items: z.array(QuestionListItemViewSchema).max(questionListMaxLimit),
    next: z.string().optional()
  })
  .strict();
export type QuestionsListResult = z.infer<typeof QuestionsListResultSchema>;

/**
 * One citation of a stored paragraph. `address` is the object the passage is read in (a source
 * for a passage) and is null when that object is gone; `unavailable` says the target no longer
 * exists and `stale` that it changed (or is gone) since the answer was stored.
 */
export const QuestionCitationViewSchema = z
  .object({
    ordinal: z.number().int().min(1),
    address: ObjectAddressTextSchema.nullable(),
    anchor: QuestionAnchorSchema.optional(),
    unavailable: z.boolean(),
    stale: z.boolean()
  })
  .strict();
export type QuestionCitationView = z.infer<typeof QuestionCitationViewSchema>;

export const QuestionParagraphViewSchema = z
  .object({ markdown: z.string(), citations: z.array(QuestionCitationViewSchema) })
  .strict();
export type QuestionParagraphView = z.infer<typeof QuestionParagraphViewSchema>;

/**
 * One answer version. A canceled version holds the paragraphs written before the cancel. `stale`:
 * some cited target changed since the answer was stored, or is gone ("May be outdated").
 */
export const QuestionAnswerViewSchema = z
  .object({
    version: z.number().int().min(1),
    status: QuestionAnswerStatusSchema,
    paragraphs: z.array(QuestionParagraphViewSchema),
    model: QuestionProvenanceSchema,
    completedAt: z.string().optional(),
    stale: z.boolean()
  })
  .strict();
export type QuestionAnswerView = z.infer<typeof QuestionAnswerViewSchema>;

/**
 * A Question with its answer versions, oldest first (`questions.get`). `errorKey` is the message
 * key of the failure when `status` is `failed`.
 */
export const QuestionViewSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string(),
    language: z.string(),
    scope: AskScopeSchema,
    privacy: QuestionPrivacySchema,
    mode: QuestionModeSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    status: AskQuestionStatusSchema,
    errorKey: z.string().optional(),
    answers: z.array(QuestionAnswerViewSchema)
  })
  .strict();
export type QuestionView = z.infer<typeof QuestionViewSchema>;

export const QuestionsDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export type QuestionsDeleteResult = z.infer<typeof QuestionsDeleteResultSchema>;

/** `questions.askAgain`: the request of the new answer version; its Question is the same. */
export const QuestionsAskAgainResultSchema = z.object({ requestId: z.string().uuid() }).strict();
export type QuestionsAskAgainResult = z.infer<typeof QuestionsAskAgainResultSchema>;

export const QuestionsClearResultSchema = z
  .object({ deleted: z.number().int().nonnegative() })
  .strict();
export type QuestionsClearResult = z.infer<typeof QuestionsClearResultSchema>;

/** `window.app.questions` as this area defines it. */
export interface QuestionsApi {
  ask: (input: QuestionsAskInput) => Promise<QuestionsAskResult>;
  /**
   * Ends the Ask of `requestId`: its paragraphs so far are stored as a canceled version. Answers
   * null, also when the Ask already ended.
   */
  cancel: (input: QuestionsCancelInput) => Promise<null>;
  /** One Question with its answer versions and their staleness; null when there is no such Question. */
  get: (input: QuestionsIdInput) => Promise<QuestionView | null>;
  list: (input?: QuestionsListInput) => Promise<QuestionsListResult>;
  /** Deletes the Question with its answers; an Ask still writing it is canceled. */
  delete: (input: QuestionsIdInput) => Promise<QuestionsDeleteResult>;
  /** Writes a new answer version for the same Question; refused while an Ask is writing it. */
  askAgain: (input: QuestionsIdInput) => Promise<QuestionsAskAgainResult>;
  /** Deletes every Question in one transaction (Privacy > Clear questions). */
  clear: () => Promise<QuestionsClearResult>;
}
