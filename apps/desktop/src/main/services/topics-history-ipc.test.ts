import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import type { PgPool } from "@app/db";
import { topicReadLimits } from "@app/domain";

import { ipcChannels } from "../../shared/ipc.js";
import { topicsHistoryChannels } from "../../shared/ipc-topics-history.js";
import {
  createTopicsHistoryService,
  registerTopicsHistoryIpc,
  type TopicsHistoryService
} from "./topics-history-ipc.js";

const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;

/** A pool that answers the two statements of the read: the days of the window, then the arrivals. */
function fakePool(
  arrivals: Array<{ topicId: string; day: string; arrivals: number }>,
  days = [day(9), day(10), day(11)]
) {
  const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(
    async (sql) =>
      sql.includes("generate_series")
        ? { rows: days.map((value) => ({ day: value })) }
        : { rows: arrivals }
  );
  return { pool: { query } as unknown as PgPool, query };
}

function register(service: TopicsHistoryService) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  registerTopicsHistoryIpc(ipc as unknown as IpcMain, service);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, channels: [...handlers.keys()] };
}

describe("the topic history area over IPC", () => {
  it("registers its one channel, which no other channel uses", () => {
    const { channels } = register({ history: vi.fn() });
    expect(channels).toEqual([topicsHistoryChannels.topicsHistory]);
    expect(topicsHistoryChannels.topicsHistory).toBe("app:topics:history");
    expect(Object.values(ipcChannels)).not.toContain(topicsHistoryChannels.topicsHistory);
  });

  it("validates a request before the service sees it: 200 topics, 90 days, UUIDs only", async () => {
    const history = vi.fn(async () => []);
    const { call } = register({ history });
    const channel = topicsHistoryChannels.topicsHistory;
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    for (const bad of [
      undefined,
      {},
      { topicIds: ["nope"], days: 7 },
      { topicIds: ids(201), days: 7 },
      { topicIds: ids(1), days: 91 },
      { topicIds: ids(1), days: 0 },
      { topicIds: ids(1), days: 7, extra: true }
    ]) {
      await expect(call(channel, bad)).rejects.toThrow();
    }
    expect(history).not.toHaveBeenCalled();
    const ok = { topicIds: ids(topicReadLimits.historyTopicsMax), days: 90 };
    await call(channel, ok);
    expect(history).toHaveBeenCalledWith(ok);
  });
});

describe("createTopicsHistoryService", () => {
  const topicId = randomUUID();
  const quiet = randomUUID();

  it("answers a series per topic with the days of the window and refuses a request out of bounds", async () => {
    const { pool, query } = fakePool([{ topicId, day: day(10), arrivals: 3 }]);
    const service = createTopicsHistoryService({
      getPool: () => pool,
      now: () => new Date("2026-11-11T12:00:00.000Z"),
      timeZone: () => "UTC"
    });
    expect(await service.history({ topicIds: [topicId, quiet], days: 3 })).toEqual([
      {
        topicId,
        daily: [
          { day: day(9), arrivals: 0 },
          { day: day(10), arrivals: 3 },
          { day: day(11), arrivals: 0 }
        ]
      },
      {
        topicId: quiet,
        daily: [
          { day: day(9), arrivals: 0 },
          { day: day(10), arrivals: 0 },
          { day: day(11), arrivals: 0 }
        ]
      }
    ]);
    // The clock and the zone reach the statements.
    const arrivalsCall = query.mock.calls.find(([sql]) => !sql.includes("generate_series"))!;
    expect(arrivalsCall[1]).toEqual([
      [topicId, quiet],
      new Date("2026-11-11T12:00:00.000Z"),
      "UTC",
      3
    ]);
    const calls = query.mock.calls.length;
    await expect(service.history({ topicIds: [topicId], days: 91 })).rejects.toThrow();
    expect(query.mock.calls).toHaveLength(calls);
  });

  it("answers topics.unavailable while the database is not ready", async () => {
    const service = createTopicsHistoryService({ getPool: () => null });
    await expect(service.history({ topicIds: [topicId], days: 7 })).rejects.toThrow(
      "topics.errors.unavailable"
    );
  });

  it("refuses an answer that is not a history", async () => {
    // A window without a day is not a series.
    const { pool } = fakePool([], []);
    const service = createTopicsHistoryService({ getPool: () => pool });
    await expect(service.history({ topicIds: [topicId], days: 7 })).rejects.toThrow();
  });
});
