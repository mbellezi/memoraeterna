import type { IpcMain } from "electron";

import { RelationExplainInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import { appEventPort } from "./app-events.js";
import type { RelationExplanationService } from "./relation-explanation-service.js";

/**
 * The request is validated here and again by the service; the preload validated it first. A request
 * with a `requestId` also receives the text as it is written (F3 D22), as `explanation.delta` on the
 * bus (F5 D16): the whole text so far, with the id of the request, so a card that closed and opened
 * again ignores the pieces of the request it canceled.
 */
export function registerRelationExplanationIpc(ipc: IpcMain, service: RelationExplanationService) {
  ipc.handle(ipcChannels.relationsExplain, (_event, payload: unknown) => {
    const input = RelationExplainInputSchema.parse(payload);
    const { relationId, requestId } = input;
    return service.explain(
      input,
      requestId
        ? (text) => appEventPort.publish({ type: "explanation.delta", requestId, relationId, text })
        : undefined
    );
  });
  ipc.handle(ipcChannels.relationsCancelExplain, (_event, payload: unknown) =>
    service.cancel(RelationExplainInputSchema.parse(payload))
  );
}
