import type { IpcMain } from "electron";

import { RelationExplainInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { SourceRelationExplanationService } from "./source-relation-explanation-service.js";

/** The request is validated here and again by the service; the preload validated it first. */
export function registerSourceRelationExplanationIpc(
  ipc: IpcMain,
  service: SourceRelationExplanationService
) {
  ipc.handle(ipcChannels.relationsExplainSource, (_event, payload: unknown) =>
    service.explain(RelationExplainInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.relationsCancelExplainSource, (_event, payload: unknown) =>
    service.cancel(RelationExplainInputSchema.parse(payload))
  );
}
