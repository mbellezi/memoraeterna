import {
  QuestionsAskInputSchema,
  QuestionsAskResultSchema,
  QuestionsCancelInputSchema,
  questionsChannels,
  type QuestionsApi
} from "../shared/ipc-questions.js";
import { z } from "zod";

/** The one call the bridge needs from Electron; `ipcRenderer.invoke` fits it. */
export type QuestionsInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * `window.app.questions` (F5 D14): each request is validated before it leaves the renderer's
 * process and each answer before it reaches the page. The preload index spreads it into the API.
 */
export function createQuestionsApi(invoke: QuestionsInvoke): QuestionsApi {
  return {
    ask: async (input) =>
      QuestionsAskResultSchema.parse(
        await invoke(questionsChannels.ask, QuestionsAskInputSchema.parse(input))
      ),
    cancel: async (input) =>
      z
        .null()
        .parse(await invoke(questionsChannels.cancel, QuestionsCancelInputSchema.parse(input)))
  };
}
