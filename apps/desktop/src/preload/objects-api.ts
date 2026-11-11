import {
  ObjectBacklinksInputSchema,
  ObjectBacklinksResultSchema,
  ObjectGetInputSchema,
  ObjectGetResultSchema,
  ObjectResolveManyInputSchema,
  ObjectResolveManyResultSchema
} from "@app/domain";

import { objectsIpcChannels, type ObjectsApi } from "../shared/ipc-objects.js";

/** The slice of `ipcRenderer` the area needs, so tests can stand in for it. */
export interface ObjectsInvoker {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

/**
 * `window.app.objects` get, resolveMany and backlinks: the request is validated before it leaves
 * the renderer's process and the response before the page sees it.
 */
export function createObjectsApi(ipc: ObjectsInvoker): ObjectsApi {
  return {
    get: async (input) =>
      ObjectGetResultSchema.parse(
        await ipc.invoke(objectsIpcChannels.objectsGet, ObjectGetInputSchema.parse(input))
      ),
    resolveMany: async (input) =>
      ObjectResolveManyResultSchema.parse(
        await ipc.invoke(
          objectsIpcChannels.objectsResolveMany,
          ObjectResolveManyInputSchema.parse(input)
        )
      ),
    backlinks: async (input) =>
      ObjectBacklinksResultSchema.parse(
        await ipc.invoke(
          objectsIpcChannels.objectsBacklinks,
          ObjectBacklinksInputSchema.parse(input)
        )
      )
  };
}
