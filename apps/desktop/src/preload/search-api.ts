import {
  SearchOmniInputSchema,
  SearchOmniResultSchema,
  searchIpcChannels,
  type SearchApi
} from "../shared/ipc-search.js";

/** The slice of `ipcRenderer` the area needs, so tests can stand in for it. */
export interface SearchInvoker {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

/**
 * `window.app.search.omni`: the request is validated before it leaves the renderer's process and
 * the answer before the page sees it.
 */
export function createSearchApi(ipc: SearchInvoker): SearchApi {
  return {
    omni: async (input) =>
      SearchOmniResultSchema.parse(
        await ipc.invoke(searchIpcChannels.searchOmni, SearchOmniInputSchema.parse(input))
      )
  };
}
