import type { IpcMain } from "electron";

import { RelationExplainInputSchema } from "@app/domain";
import { ipcChannels, RelationExplanationDeltaEventSchema } from "../../shared/ipc.js";
import { appEventPort } from "./app-events.js";
import type { RelationExplanationService } from "./relation-explanation-service.js";

/**
 * The request is validated here and again by the service; the preload validated it first. A request
 * with a `requestId` also receives the text as it is written, on the delta channel of the window
 * that asked (F3 D22): the whole text so far, with the id of the request, so a window that closed a
 * card and opened it again ignores the pieces of the request it canceled. The same text goes to the bus
 * as `explanation.delta` (F5 D16; the old channel keeps sending until the renderer moves, T125).
 */
export function registerRelationExplanationIpc(ipc: IpcMain, service: RelationExplanationService) {
  ipc.handle(ipcChannels.relationsExplain, (event, payload: unknown) => {
    const input = RelationExplainInputSchema.parse(payload);
    const { relationId, requestId } = input;
    const sender = event?.sender;
    return service.explain(
      input,
      requestId && sender
        ? (text) => {
            appEventPort.publish({ type: "explanation.delta", requestId, relationId, text });
            if (sender.isDestroyed()) return;
            sender.send(
              ipcChannels.relationExplanationDelta,
              RelationExplanationDeltaEventSchema.parse({ requestId, relationId, text })
            );
          }
        : undefined
    );
  });
  ipc.handle(ipcChannels.relationsCancelExplain, (_event, payload: unknown) =>
    service.cancel(RelationExplainInputSchema.parse(payload))
  );
}
