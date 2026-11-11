import {
  entitiesChannels,
  EntitiesPageInputSchema,
  EntityPageSchema,
  type EntitiesApi
} from "../shared/ipc-entities.js";

/** The slice of `ipcRenderer` the area needs, so tests can stand in for it. */
export interface EntitiesInvoker {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

/**
 * `window.app.entities.page`: the request is validated before it leaves the renderer's process
 * and the response before the page sees it.
 */
export function createEntitiesApi(ipc: EntitiesInvoker): EntitiesApi {
  return {
    page: async (input) =>
      EntityPageSchema.nullable().parse(
        await ipc.invoke(entitiesChannels.page, EntitiesPageInputSchema.parse(input))
      )
  };
}
