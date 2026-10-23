import type { IpcMain } from "electron";
import { z } from "zod";
import { ConsultationInputSchema } from "@app/domain";
import { ConsultationStatusEventSchema, ipcChannels } from "../../shared/ipc.js";
import type { ConsultationService } from "./consultation-service.js";

/**
 * An Ask also reports what it is doing besides answering (it waits out the provider's rate limit,
 * then answers again) on the status channel of the window that asked, tagged with the request's id.
 */
export function registerConsultationIpc(ipc: IpcMain, service: ConsultationService) {
  ipc.handle(ipcChannels.consultationAsk, (event, input: unknown) => {
    const parsed = ConsultationInputSchema.parse(input);
    const sender = event?.sender;
    return service.ask(parsed, {
      onStatus: (status) => {
        if (!sender || sender.isDestroyed()) return;
        sender.send(
          ipcChannels.consultationStatus,
          ConsultationStatusEventSchema.parse({ requestId: parsed.requestId, status })
        );
      }
    });
  });
  ipc.handle(ipcChannels.consultationCancel, (_event, id: unknown) =>
    service.cancel(z.string().uuid().parse(id))
  );
}
