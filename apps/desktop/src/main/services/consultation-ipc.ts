import type { IpcMain } from "electron";
import { z } from "zod";
import { ConsultationInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { AppEventBus } from "./app-events.js";
import type { ConsultationService } from "./consultation-service.js";

/**
 * An Ask also reports what it is doing besides answering (it waits out the provider's rate limit,
 * then answers again) as a `consultation.status` event on the bus (F4 D26), tagged with the
 * request's id.
 */
export function registerConsultationIpc(
  ipc: IpcMain,
  service: ConsultationService,
  events: Pick<AppEventBus, "publish">
) {
  ipc.handle(ipcChannels.consultationAsk, (_event, input: unknown) => {
    const parsed = ConsultationInputSchema.parse(input);
    return service.ask(parsed, {
      onStatus: (status) =>
        events.publish({
          type: "consultation.status",
          requestId: parsed.requestId,
          stage: status
        })
    });
  });
  ipc.handle(ipcChannels.consultationCancel, (_event, id: unknown) =>
    service.cancel(z.string().uuid().parse(id))
  );
}
