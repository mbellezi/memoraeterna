import {
  RelationsBranchAnswerSchema,
  RelationsBranchInputSchema,
  relationsBranchChannels,
  type RelationsBranchApi
} from "../shared/ipc-relations-branch.js";

/** The slice of `ipcRenderer` the area needs, so tests can stand in for it. */
export interface RelationsBranchInvoker {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

/**
 * `window.app.relations.branch`: the request is validated before it leaves the renderer's process
 * and the answer before the page sees it.
 */
export function createRelationsBranchApi(ipc: RelationsBranchInvoker): RelationsBranchApi {
  return {
    branch: async (input) =>
      RelationsBranchAnswerSchema.parse(
        await ipc.invoke(relationsBranchChannels.branch, RelationsBranchInputSchema.parse(input))
      )
  };
}
