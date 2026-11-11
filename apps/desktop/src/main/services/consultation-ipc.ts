import type { IpcMain } from "electron";
import { z } from "zod";
import { ConsultationInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { AppEventBus } from "./app-events.js";
import { askErrorKey, isAskCanceled, type ConsultationService } from "./consultation-service.js";

/**
 * An Ask reports where it is as `consultation.status` events on the bus (F4 D26, F5 D14), tagged
 * with the request's id: retrieving, answering, waiting for the provider's rate limit, and how it
 * ended (done, failed with the message key, or canceled). This Ask stores no Question, so the events
 * carry no `questionId`; the one that does is `questions.ask` (`questions-service.ts`).
 */
export function registerConsultationIpc(
  ipc: IpcMain,
  service: ConsultationService,
  events: Pick<AppEventBus, "publish">
) {
  ipc.handle(ipcChannels.consultationAsk, async (_event, input: unknown) => {
    const parsed = ConsultationInputSchema.parse(input);
    const stage = (
      value: "retrieving" | "answering" | "waitingForProvider" | "done" | "failed" | "canceled",
      error?: string
    ) =>
      events.publish({
        type: "consultation.status",
        requestId: parsed.requestId,
        stage: value,
        ...(error === undefined ? {} : { error })
      });
    try {
      const result = await service.ask(parsed, { onStatus: (status) => stage(status) });
      stage("done");
      return result;
    } catch (error) {
      if (isAskCanceled(error)) stage("canceled");
      else stage("failed", askErrorKey(error));
      throw error;
    }
  });
  ipc.handle(ipcChannels.consultationCancel, (_event, id: unknown) =>
    service.cancel(z.string().uuid().parse(id))
  );
}
