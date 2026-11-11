// The questions area of the IPC (F5 D14, D30): what the renderer may ask of the main process about
// Ask. This card carries asking and canceling; reading, listing, deleting, asking again and clearing
// join it with the questions reads (T129). The area is wired into `DesktopApi`, the preload and
// `registerIpcHandlers` by the wave's wiring card (T170); until then these are its own channels and
// its own typed surface, so the schemas, the main handlers and the preload bridge agree on one source.
import { AskScopeSchema, QuestionModeSchema, QuestionPrivacySchema } from "@app/domain";
import { z } from "zod";

/** The channels of the area, `app:questions:*`; T170 spreads them into `ipcChannels`. */
export const questionsChannels = {
  ask: "app:questions:ask",
  cancel: "app:questions:cancel"
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

/** `window.app.questions` as this area defines it. */
export interface QuestionsApi {
  ask: (input: QuestionsAskInput) => Promise<QuestionsAskResult>;
  /**
   * Ends the Ask of `requestId`: its paragraphs so far are stored as a canceled version. Answers
   * null, also when the Ask already ended.
   */
  cancel: (input: QuestionsCancelInput) => Promise<null>;
}
