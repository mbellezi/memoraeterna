import type { IpcMain } from "electron";

import { ObjectLocateInputSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { ObjectsService } from "./objects-service.js";

/** The request is validated here and again by the service; the preload validated it first. */
export function registerObjectsIpc(ipc: IpcMain, service: ObjectsService) {
  ipc.handle(ipcChannels.objectsLocate, (_event, payload: unknown) =>
    service.locate(ObjectLocateInputSchema.parse(payload))
  );
}
