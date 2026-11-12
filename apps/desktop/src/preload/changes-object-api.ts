import {
  ChangesForObjectInputSchema,
  ChangesForObjectSchema,
  changesObjectChannels,
  type ChangesObjectApi
} from "../shared/ipc-changes-object.js";

/** The one call the bridge needs from Electron; `ipcRenderer.invoke` fits it. */
export type ChangesObjectInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * `window.app.changes.forObject` (F5 D31): the request is validated before it leaves the renderer's
 * process and the answer before it reaches the page. The preload index spreads it into `changes`.
 */
export function createChangesObjectApi(invoke: ChangesObjectInvoke): ChangesObjectApi {
  return {
    forObject: async (input) =>
      ChangesForObjectSchema.parse(
        await invoke(changesObjectChannels.forObject, ChangesForObjectInputSchema.parse(input))
      )
  };
}
