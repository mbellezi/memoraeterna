import {
  HomeDigestInputSchema,
  HomeDigestSchema,
  homeChannels,
  type HomeApi
} from "../shared/ipc-home.js";

/** The one call the bridge needs from Electron; `ipcRenderer.invoke` fits it. */
export type HomeInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * `window.app.home` (F5 D9): the request is validated before it leaves the renderer's process and
 * the digest before it reaches the page. The preload index spreads it into the API.
 */
export function createHomeApi(invoke: HomeInvoke): HomeApi {
  return {
    digest: async (input) =>
      HomeDigestSchema.parse(
        await invoke(homeChannels.digest, HomeDigestInputSchema.parse(input ?? {}))
      )
  };
}
