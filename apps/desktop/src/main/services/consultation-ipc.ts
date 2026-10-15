import type { InvestigationService } from "./investigation-service.js";
import type { IpcMain } from "electron";
import { z } from "zod";
import { ConsultationInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { ConsultationService } from "./consultation-service.js";

/** Saving an answer as a page and following a question were removed with the legacy wiki. */
const retired = () => {
  throw new Error("consultation.errors.retired");
};
export function registerConsultationIpc(
  ipc: IpcMain,
  service: ConsultationService,
  investigations: InvestigationService
) {
  ipc.handle(ipcChannels.investigationList, () => investigations.list());
  ipc.handle(ipcChannels.investigationGet, (_event, id: unknown) =>
    investigations.get(z.string().uuid().parse(id))
  );
  ipc.handle(ipcChannels.investigationFollow, retired);
  ipc.handle(ipcChannels.investigationState, retired);
  ipc.handle(ipcChannels.consultationAsk, (_event, input: unknown) =>
    service.ask(ConsultationInputSchema.parse(input))
  );
  ipc.handle(ipcChannels.consultationCancel, (_event, id: unknown) =>
    service.cancel(z.string().uuid().parse(id))
  );
  ipc.handle(ipcChannels.consultationSave, retired);
}
