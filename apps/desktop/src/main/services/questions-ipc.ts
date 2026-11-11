import type { IpcMain } from "electron";

import {
  QuestionsAskInputSchema,
  QuestionsCancelInputSchema,
  questionsChannels
} from "../../shared/ipc-questions.js";
import type { QuestionsService } from "./questions-service.js";

/**
 * The handlers of the questions area. A request is validated here and again by the service; the
 * preload validated it first. Progress and the answer travel on the bus, never on a channel of
 * this area.
 */
export function registerQuestionsIpc(
  ipc: IpcMain,
  service: Pick<QuestionsService, "ask" | "cancel">
) {
  ipc.handle(questionsChannels.ask, (_event, payload: unknown) =>
    service.ask(QuestionsAskInputSchema.parse(payload))
  );
  ipc.handle(questionsChannels.cancel, (_event, payload: unknown) =>
    service.cancel(QuestionsCancelInputSchema.parse(payload))
  );
}
