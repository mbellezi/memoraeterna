import type { IpcMain } from "electron";

import { createChangeSetRepository, type PgPool } from "@app/db";

import {
  changesForObjectLimits,
  changesObjectChannels,
  ChangesForObjectInputSchema,
  ChangesForObjectSchema,
  type ChangesForObject
} from "../../shared/ipc-changes-object.js";

export interface ChangesObjectService {
  forObject(input: unknown): Promise<ChangesForObject>;
}

export interface ChangesObjectServiceOptions {
  getPool: () => PgPool | null;
}

/**
 * Validates a request and an answer around the change-sets of one object. It only reads: nothing
 * here writes, undoes, calls AI or touches the filesystem (the undo stays `changes.undo`).
 */
export function createChangesObjectService(
  options: ChangesObjectServiceOptions
): ChangesObjectService {
  return {
    async forObject(input) {
      const parsed = ChangesForObjectInputSchema.parse(input);
      const pool = options.getPool();
      if (!pool) throw new Error("changes.errors.unavailable");
      const items = await createChangeSetRepository(pool).forObject({
        kind: parsed.kind,
        id: parsed.id,
        limit: parsed.limit ?? changesForObjectLimits.max
      });
      return ChangesForObjectSchema.parse({ items });
    }
  };
}

/** The request is validated here and again by the service; the preload validated it first. */
export function registerChangesObjectIpc(ipc: IpcMain, service: ChangesObjectService) {
  ipc.handle(changesObjectChannels.forObject, (_event, payload: unknown) =>
    service.forObject(ChangesForObjectInputSchema.parse(payload))
  );
}
