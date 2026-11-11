import type { IpcMain } from "electron";

import {
  QuestionsAskInputSchema,
  QuestionsCancelInputSchema,
  QuestionsIdInputSchema,
  QuestionsListInputSchema,
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
  service: Pick<
    QuestionsService,
    "ask" | "cancel" | "get" | "list" | "delete" | "askAgain" | "clear"
  >
) {
  ipc.handle(questionsChannels.ask, (_event, payload: unknown) =>
    service.ask(QuestionsAskInputSchema.parse(payload))
  );
  ipc.handle(questionsChannels.cancel, (_event, payload: unknown) =>
    service.cancel(QuestionsCancelInputSchema.parse(payload))
  );
  ipc.handle(questionsChannels.get, (_event, payload: unknown) =>
    service.get(QuestionsIdInputSchema.parse(payload))
  );
  ipc.handle(questionsChannels.list, (_event, payload: unknown) =>
    service.list(QuestionsListInputSchema.parse(payload ?? {}))
  );
  ipc.handle(questionsChannels.delete, (_event, payload: unknown) =>
    service.delete(QuestionsIdInputSchema.parse(payload))
  );
  ipc.handle(questionsChannels.askAgain, (_event, payload: unknown) =>
    service.askAgain(QuestionsIdInputSchema.parse(payload))
  );
  ipc.handle(questionsChannels.clear, () => service.clear());
}
