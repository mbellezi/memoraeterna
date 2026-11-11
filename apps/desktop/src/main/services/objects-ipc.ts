import type { IpcMain } from "electron";

import {
  ObjectBacklinksInputSchema,
  ObjectGetInputSchema,
  ObjectLocateInputSchema,
  ObjectNeighborhoodInputSchema,
  ObjectResolveManyInputSchema
} from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import { objectsIpcChannels } from "../../shared/ipc-objects.js";
import type { ObjectsService } from "./objects-service.js";

/** The request is validated here and again by the service; the preload validated it first. */
export function registerObjectsIpc(ipc: IpcMain, service: ObjectsService) {
  ipc.handle(ipcChannels.objectsLocate, (_event, payload: unknown) =>
    service.locate(ObjectLocateInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.objectsNeighborhood, (_event, payload: unknown) =>
    service.neighborhood(ObjectNeighborhoodInputSchema.parse(payload))
  );
  ipc.handle(objectsIpcChannels.objectsGet, (_event, payload: unknown) =>
    service.get(ObjectGetInputSchema.parse(payload))
  );
  ipc.handle(objectsIpcChannels.objectsResolveMany, (_event, payload: unknown) =>
    service.resolveMany(ObjectResolveManyInputSchema.parse(payload))
  );
  ipc.handle(objectsIpcChannels.objectsBacklinks, (_event, payload: unknown) =>
    service.backlinks(ObjectBacklinksInputSchema.parse(payload))
  );
}
