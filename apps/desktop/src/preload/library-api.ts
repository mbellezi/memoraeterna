import {
  libraryChannels,
  LibraryRowsInputSchema,
  LibraryRowsResultSchema,
  LibrarySourceProgressInputSchema,
  LibrarySourceProgressSchema,
  type LibraryApi
} from "../shared/ipc-library.js";

/** The one call the bridge needs from Electron; `ipcRenderer.invoke` fits it. */
export type LibraryInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * `window.app.library` (F5 T131): each request is validated before it leaves the renderer's
 * process and each answer before it reaches the page. The preload index spreads it into the API.
 */
export function createLibraryApi(invoke: LibraryInvoke): LibraryApi {
  return {
    rows: async (input) =>
      LibraryRowsResultSchema.parse(
        await invoke(libraryChannels.rows, LibraryRowsInputSchema.parse(input))
      ),
    sourceProgress: async (input) =>
      LibrarySourceProgressSchema.parse(
        await invoke(libraryChannels.sourceProgress, LibrarySourceProgressInputSchema.parse(input))
      )
  };
}
