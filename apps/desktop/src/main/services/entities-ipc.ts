import type { IpcMain } from "electron";

import { createEntityPageRepository, type EntityPageRepository, type PgPool } from "@app/db";
import {
  entitiesChannels,
  EntitiesPageInputSchema,
  EntityPageSchema
} from "../../shared/ipc-entities.js";

/**
 * `entities.page` (F5 T132): a read, so the handler is the whole service. The request is
 * validated here after the preload validated it, and the answer before it crosses. A database that
 * is not ready fails with `objects.errors.unavailable`, the key the objects area already uses.
 */
export function registerEntitiesIpc(
  ipc: IpcMain,
  getPool: () => PgPool | null,
  repositoryFor: (pool: PgPool) => Pick<EntityPageRepository, "page"> = createEntityPageRepository
) {
  ipc.handle(entitiesChannels.page, async (_event, payload: unknown) => {
    const input = EntitiesPageInputSchema.parse(payload);
    const pool = getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    return EntityPageSchema.nullable().parse(await repositoryFor(pool).page(input));
  });
}
