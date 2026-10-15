import type { IpcMain } from "electron";

import { RelationExplainInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { RelationExplanationService } from "./relation-explanation-service.js";

/** The request is validated here and again by the service; the preload validated it first. */
export function registerRelationExplanationIpc(ipc: IpcMain, service: RelationExplanationService) {
  ipc.handle(ipcChannels.relationsExplain, (_event, payload: unknown) =>
    service.explain(RelationExplainInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.relationsCancelExplain, (_event, payload: unknown) =>
    service.cancel(RelationExplainInputSchema.parse(payload))
  );
}
