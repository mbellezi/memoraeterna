import type { IpcMain } from "electron";

import { createTopicHistoryRepository, type PgPool } from "@app/db";

import {
  TopicsHistoryInputSchema,
  TopicsHistorySchema,
  topicsHistoryChannels,
  type TopicsHistory
} from "../../shared/ipc-topics-history.js";

export interface TopicsHistoryService {
  history(input: unknown): Promise<TopicsHistory>;
}

export interface TopicsHistoryServiceOptions {
  getPool: () => PgPool | null;
  /** The clock of "today" (default now). */
  now?: () => Date;
  /** The zone of the day boundaries (default the process's own zone). */
  timeZone?: () => string | undefined;
}

/**
 * Validates a request and an answer around the history read. It only reads: nothing here writes,
 * calls AI or touches the filesystem.
 */
export function createTopicsHistoryService(
  options: TopicsHistoryServiceOptions
): TopicsHistoryService {
  return {
    async history(input) {
      const parsed = TopicsHistoryInputSchema.parse(input);
      const pool = options.getPool();
      if (!pool) throw new Error("topics.errors.unavailable");
      const timeZone = options.timeZone?.();
      return TopicsHistorySchema.parse(
        await createTopicHistoryRepository(pool).readHistory(parsed, {
          now: options.now?.() ?? new Date(),
          ...(timeZone ? { timeZone } : {})
        })
      );
    }
  };
}

/** The request is validated here and again by the service; the preload validated it first. */
export function registerTopicsHistoryIpc(ipc: IpcMain, service: TopicsHistoryService) {
  ipc.handle(topicsHistoryChannels.topicsHistory, (_event, payload: unknown) =>
    service.history(TopicsHistoryInputSchema.parse(payload))
  );
}
