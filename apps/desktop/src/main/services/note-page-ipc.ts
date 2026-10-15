import type { IpcMain } from "electron";

import { NotePageInputSchema, NoteRelationsInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { NotePageService } from "./note-page-service.js";

/** The request is validated here and again by the service; the preload validated it first. */
export function registerNotePageIpc(ipc: IpcMain, service: NotePageService) {
  ipc.handle(ipcChannels.notesPage, (_event, payload: unknown) =>
    service.page(NotePageInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.notesRelations, (_event, payload: unknown) =>
    service.relations(NoteRelationsInputSchema.parse(payload))
  );
}
