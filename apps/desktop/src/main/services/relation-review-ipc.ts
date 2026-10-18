import type { IpcMain } from "electron";

import { RelationReviewInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { RelationReviewService } from "./relation-review-service.js";

/** The request is validated here and again by the service; the preload validated it first. */
export function registerRelationReviewIpc(ipc: IpcMain, service: RelationReviewService) {
  ipc.handle(ipcChannels.relationsReview, (_event, payload: unknown) =>
    service.review(RelationReviewInputSchema.parse(payload))
  );
}
