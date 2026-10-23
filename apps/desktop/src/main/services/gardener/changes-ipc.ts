import type { IpcMain } from "electron";

import {
  ChangesDiffInputSchema,
  ChangesListInputSchema,
  ChangesReviewInputSchema,
  ChangesUndoInputSchema
} from "@app/domain";

import { ipcChannels } from "../../../shared/ipc.js";
import type { ChangesService } from "./changes-service.js";

/** What the handlers need of the service (tests pass a fake). */
export type ChangesPort = Pick<
  ChangesService,
  "list" | "pendingCounts" | "undo" | "review" | "diff"
>;

/**
 * `changes.*` (F4 D10, spec 3.4): every request is validated here before the service sees it, and
 * the service validates its answers before they leave; the preload validated the request first.
 */
export function registerChangesIpc(ipc: IpcMain, service: ChangesPort): void {
  ipc.handle(ipcChannels.changesList, (_event, payload: unknown) =>
    service.list(ChangesListInputSchema.parse(payload ?? {}))
  );
  ipc.handle(ipcChannels.changesPendingCounts, () => service.pendingCounts());
  ipc.handle(ipcChannels.changesUndo, (_event, payload: unknown) =>
    service.undo(ChangesUndoInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.changesReview, (_event, payload: unknown) =>
    service.review(ChangesReviewInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.changesDiff, (_event, payload: unknown) =>
    service.diff(ChangesDiffInputSchema.parse(payload))
  );
}
