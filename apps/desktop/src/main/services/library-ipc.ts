import type { IpcMain } from "electron";

import { createLibraryRowsRepository, type LibraryRowsRepository, type PgPool } from "@app/db";

import {
  libraryChannels,
  LibraryRowsInputSchema,
  LibraryRowsResultSchema,
  LibrarySourceProgressInputSchema,
  LibrarySourceProgressSchema,
  type LibraryRowsResult,
  type LibrarySourceProgress
} from "../../shared/ipc-library.js";

/**
 * The Library's reads (F5 T131): the table's rows and the generation strip's data. Read-only and
 * model-free: nothing here calls AI or writes.
 */
export class LibraryService {
  constructor(
    private readonly getPool: () => PgPool | null,
    private readonly repository: (
      pool: PgPool
    ) => LibraryRowsRepository = createLibraryRowsRepository
  ) {}

  /** One keyset page of the root sources; a cursor made for another sort or direction is refused. */
  async rows(input: unknown): Promise<LibraryRowsResult> {
    const parsed = LibraryRowsInputSchema.parse(input);
    const { filter, ...rest } = parsed;
    // `exactOptionalPropertyTypes`: leave out what the request left out.
    return LibraryRowsResultSchema.parse(
      await this.repository(this.pool()).rows({
        ...rest,
        ...(filter ? { filter } : {})
      })
    );
  }

  /** The generation strip's data for one source; null when the source does not exist. */
  async sourceProgress(input: unknown): Promise<LibrarySourceProgress> {
    const { sourceId } = LibrarySourceProgressInputSchema.parse(input);
    return LibrarySourceProgressSchema.parse(
      await this.repository(this.pool()).sourceProgress(sourceId)
    );
  }

  private pool(): PgPool {
    const pool = this.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

/**
 * The handlers of the library area. A request is validated here and again by the service; the
 * preload validated it first. The renderer re-reads on `job.progress` and `object.changed`; this
 * area has no push channel.
 */
export function registerLibraryIpc(
  ipc: IpcMain,
  service: Pick<LibraryService, "rows" | "sourceProgress">
) {
  ipc.handle(libraryChannels.rows, (_event, payload: unknown) =>
    service.rows(LibraryRowsInputSchema.parse(payload))
  );
  ipc.handle(libraryChannels.sourceProgress, (_event, payload: unknown) =>
    service.sourceProgress(LibrarySourceProgressInputSchema.parse(payload))
  );
}
