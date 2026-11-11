import {
  TopicsHistoryInputSchema,
  TopicsHistorySchema,
  topicsHistoryChannels,
  type TopicsHistoryApi
} from "../shared/ipc-topics-history.js";

/** The one call the bridge needs from Electron; `ipcRenderer.invoke` fits it. */
export type TopicsHistoryInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * `window.app.topics.history` (F5 D20): the request is validated before it leaves the renderer's
 * process and the answer before it reaches the page. The preload index spreads it into `topics`.
 */
export function createTopicsHistoryApi(invoke: TopicsHistoryInvoke): TopicsHistoryApi {
  return {
    history: async (input) =>
      TopicsHistorySchema.parse(
        await invoke(topicsHistoryChannels.topicsHistory, TopicsHistoryInputSchema.parse(input))
      )
  };
}
