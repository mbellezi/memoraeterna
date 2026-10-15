import {
  createViewHistoryRepository,
  type PgPool,
  type ViewHistoryEntry as StoredEntry
} from "@app/db";
import type { z } from "zod";
import {
  viewHistoryEntrySchema,
  type ViewHistoryEntry,
  type viewHistoryListInputSchema,
  type viewHistoryRecordInputSchema
} from "../../shared/view-history.js";

export interface ViewHistoryServiceOptions {
  getPool: () => PgPool | null;
  /** Called after a change is committed, so the renderer can reload what it shows. */
  onChanged?: () => void;
}

function toEntry(stored: StoredEntry): ViewHistoryEntry {
  return viewHistoryEntrySchema.parse({
    address: stored.address,
    kind: stored.kind,
    id: stored.objectId,
    title: stored.title,
    parentAddress: stored.parentAddress,
    openedAt: stored.openedAt.toISOString(),
    openCount: stored.openCount,
    pinned: stored.pinned
  });
}

/**
 * The local view history (recents and pins). It only reads and writes the local database: nothing
 * is sent anywhere, and a library reset clears it with every other cleared table.
 */
export class ViewHistoryService {
  constructor(private readonly options: ViewHistoryServiceOptions) {}

  private repository() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.common.unknown");
    return createViewHistoryRepository(pool);
  }

  async record(input: z.output<typeof viewHistoryRecordInputSchema>): Promise<ViewHistoryEntry> {
    const stored = await this.repository().record({
      kind: input.kind,
      objectId: input.id,
      title: input.title,
      parentAddress: input.parentAddress ?? null
    });
    this.options.onChanged?.();
    return toEntry(stored);
  }

  async list(input: z.output<typeof viewHistoryListInputSchema>): Promise<ViewHistoryEntry[]> {
    return (await this.repository().list(input)).map(toEntry);
  }

  async setPinned(address: string, pinned: boolean): Promise<ViewHistoryEntry | null> {
    const stored = await this.repository().setPinned(address, pinned);
    if (!stored) return null;
    this.options.onChanged?.();
    return toEntry(stored);
  }

  /** Forgets every unpinned entry; pins stay. */
  async clear(): Promise<number> {
    const removed = await this.repository().clear();
    if (removed > 0) this.options.onChanged?.();
    return removed;
  }
}
