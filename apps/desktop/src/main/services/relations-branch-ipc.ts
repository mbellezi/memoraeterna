import type { IpcMain } from "electron";

import { createRelationBranchRepository, type PgPool, type RelationBranchRead } from "@app/db";

import {
  relationBranchStance,
  RelationsBranchAnswerSchema,
  RelationsBranchInputSchema,
  relationsBranchChannels,
  type RelationsBranchResult
} from "../../shared/ipc-relations-branch.js";

/** The read the handler answers with; a test stands in for the repository. */
export type RelationsBranchReader = (
  request: ReturnType<typeof RelationsBranchInputSchema.parse>
) => Promise<RelationBranchRead | null>;

/** The repository on the open library; fails while the database is not ready. */
export function relationsBranchReader(getPool: () => PgPool | null): RelationsBranchReader {
  return (request) => {
    const pool = getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    return createRelationBranchRepository(pool).read(request);
  };
}

/**
 * `relations.branch` (F5 D19): the request is validated here (the preload validated it first), each
 * edge gets the stance its type is drawn with, and the answer is validated before it leaves main.
 * Read-only, without AI.
 */
export async function readRelationsBranch(
  read: RelationsBranchReader,
  payload: unknown
): Promise<RelationsBranchResult | null> {
  const answer = await read(RelationsBranchInputSchema.parse(payload));
  return RelationsBranchAnswerSchema.parse(
    answer && {
      ...answer,
      edges: answer.edges.map((edge) => ({ ...edge, stance: relationBranchStance(edge.type) }))
    }
  );
}

/** The handler of the area; T171 registers it with the library's pool. */
export function registerRelationsBranchIpc(ipc: IpcMain, read: RelationsBranchReader) {
  ipc.handle(relationsBranchChannels.branch, (_event, payload: unknown) =>
    readRelationsBranch(read, payload)
  );
}
