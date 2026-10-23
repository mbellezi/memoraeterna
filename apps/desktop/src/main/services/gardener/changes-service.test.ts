import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ChangesUndoResultSchema, changeSetReadLimits } from "@app/domain";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerChangesIpc, type ChangesPort } from "./changes-ipc.js";
import { ChangesService, relationBlockers, topicBlockers } from "./changes-service.js";
import {
  gardenerRetentionJobType,
  retentionJobExecutor,
  runRetention,
  scheduleRetention,
  type RetentionStores
} from "./retention.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Handler = (event: unknown, payload?: unknown) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  const call = async (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload);
  return { ipc: ipc as unknown as IpcMain, handlers, call };
}

describe("the changes IPC (F4 D10)", () => {
  const port = (): { [K in keyof ChangesPort]: ReturnType<typeof vi.fn> } => ({
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    pendingCounts: vi.fn(async () => ({
      total: 0,
      byKind: { topic: 0, relation: 0, overview: 0 },
      byRisk: { low: 0, medium: 0, high: 0 }
    })),
    undo: vi.fn(async () => ({ status: "undone", kind: "topic", id: id(1) })),
    review: vi.fn(async () => ({ status: "applied" })),
    diff: vi.fn(async () => null)
  });

  it("registers one channel per verb and hands every store's change-set to the same undo", async () => {
    const { ipc, handlers, call } = fakeIpc();
    const service = port();
    registerChangesIpc(ipc, service as unknown as ChangesPort);
    expect([...handlers.keys()].sort()).toEqual(
      [
        ipcChannels.changesDiff,
        ipcChannels.changesList,
        ipcChannels.changesPendingCounts,
        ipcChannels.changesReview,
        ipcChannels.changesUndo
      ].sort()
    );
    for (const kind of ["topic", "relation", "overview"] as const)
      await call(ipcChannels.changesUndo, { kind, id: id(2) });
    expect(service.undo.mock.calls.map(([input]) => (input as { kind: string }).kind)).toEqual([
      "topic",
      "relation",
      "overview"
    ]);
    await call(ipcChannels.changesList);
    expect(service.list).toHaveBeenCalledWith({ limit: changeSetReadLimits.pageDefault });
  });

  it("refuses a malformed request before the service sees it", async () => {
    const { ipc, call } = fakeIpc();
    const service = port();
    registerChangesIpc(ipc, service as unknown as ChangesPort);
    await expect(call(ipcChannels.changesUndo, { kind: "wiki", id: id(1) })).rejects.toThrow();
    await expect(call(ipcChannels.changesUndo, { kind: "topic", id: "x" })).rejects.toThrow();
    await expect(
      call(ipcChannels.changesReview, { kind: "topic", id: id(1), verdict: "maybe" })
    ).rejects.toThrow();
    await expect(call(ipcChannels.changesList, { limit: 51 })).rejects.toThrow();
    await expect(
      call(ipcChannels.changesDiff, { kind: "overview", id: id(1), x: 1 })
    ).rejects.toThrow();
    expect(service.undo).not.toHaveBeenCalled();
    expect(service.review).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.diff).not.toHaveBeenCalled();
  });

  it("answers unavailable without a database", async () => {
    const service = new ChangesService({ getPool: () => null });
    await expect(service.list({})).rejects.toThrow("changes.errors.unavailable");
    await expect(service.undo({ kind: "topic", id: id(1) })).rejects.toThrow(
      "changes.errors.unavailable"
    );
  });
});

describe("undo blockers as the interface words them", () => {
  it("maps the topic engine's blockers", () => {
    expect(
      topicBlockers([
        { kind: "changeSet", changeSetId: id(3), objects: ["topic:x"] },
        { kind: "itemDeleted", item: "note:x" },
        { kind: "notApplied", status: "undone" },
        { kind: "conflict", code: "notUndoable", topicId: null, item: null, reason: "" },
        { kind: "conflict", code: "parentRetired", topicId: id(4), item: null, reason: "" }
      ])
    ).toEqual([
      { code: "later_change", changeSet: { kind: "topic", id: id(3) } },
      { code: "item_deleted", changeSet: null },
      { code: "not_applied", changeSet: null },
      { code: "not_undoable", changeSet: null },
      { code: "conflict", changeSet: null }
    ]);
  });

  it("maps a revert's blockers; a later human verdict names no change-set", () => {
    const item = { relationKind: "note" as const, relationId: id(5), pairKey: "p", eventId: id(6) };
    const later = (runKind: string) => ({
      code: "later_run" as const,
      runId: id(7),
      runKind,
      startedAt: new Date(),
      eventKind: "kept" as const,
      ...item
    });
    expect(
      relationBlockers([
        { code: "run_open", runId: id(7) },
        later("link"),
        later("review"),
        { code: "row_missing", reason: "", ...item },
        { code: "restore_refused", reason: "", ...item }
      ])
    ).toEqual([
      { code: "run_open", changeSet: null },
      { code: "later_change", changeSet: { kind: "relation", id: id(7) } },
      { code: "changed_since", changeSet: null },
      { code: "item_deleted", changeSet: null },
      { code: "changed_since", changeSet: null }
    ]);
    // The result contract holds at least one blocker and counts the rest.
    expect(() =>
      ChangesUndoResultSchema.parse({ status: "blocked", blockers: [], more: 0 })
    ).toThrow();
  });
});

describe("the retention pass (D10)", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");
  const stores = (sizes: Partial<Record<keyof RetentionStores, number[]>>) => {
    const calls: Array<{ store: string; before: string; limit: number }> = [];
    const store =
      (name: keyof RetentionStores) => async (input: { before: Date; limit: number }) => {
        calls.push({ store: name, before: input.before.toISOString(), limit: input.limit });
        return sizes[name]?.shift() ?? 0;
      };
    return {
      calls,
      stores: {
        topic: store("topic"),
        relation: store("relation"),
        overview: store("overview"),
        jobs: store("jobs")
      } satisfies RetentionStores
    };
  };

  it("prunes change-sets past 90 days and jobs past 30, each store until it has nothing left", async () => {
    const { calls, stores: writers } = stores({ topic: [500, 3], jobs: [2] });
    const report = await runRetention(writers, { now });
    expect(report).toEqual({
      pruned: { topic: 503, relation: 0, overview: 0, jobs: 2 },
      changeSetsBefore: "2026-07-25T12:00:00.000Z",
      jobsBefore: "2026-09-23T12:00:00.000Z",
      complete: true
    });
    expect(calls.map((call) => call.store)).toEqual([
      "topic",
      "topic",
      "topic",
      "relation",
      "overview",
      "jobs",
      "jobs"
    ]);
    expect(new Set(calls.map((call) => call.limit))).toEqual(new Set([500]));
  });

  it("stops a store at its batch limit and says the pass is not complete", async () => {
    const { stores: writers } = stores({ relation: [5, 5, 5, 5] });
    const report = await runRetention(writers, {
      now,
      config: { changeSetDays: 90, jobDays: 30, batchSize: 5, maxBatches: 2 }
    });
    expect(report.pruned.relation).toBe(10);
    expect(report.complete).toBe(false);
  });

  it("stops between batches when its job is canceled", async () => {
    const controller = new AbortController();
    const { stores: writers } = stores({ topic: [1, 1, 1] });
    const first = writers.topic;
    writers.topic = async (input) => {
      controller.abort();
      return first(input);
    };
    await expect(runRetention(writers, { now, signal: controller.signal })).rejects.toThrow();
  });

  it("queues the next pass under one dedupe key, and needs a database to run", async () => {
    const enqueued: Array<{ type: string; dedupeKey: string; delay: number }> = [];
    const jobs = {
      enqueueDeduped: vi.fn(
        async (input: { type: string; dedupeKey: string; debounce?: { delayMs: number } }) => {
          enqueued.push({
            type: input.type,
            dedupeKey: input.dedupeKey,
            delay: input.debounce?.delayMs ?? -1
          });
          return { job: { id: id(9) } as never, created: true };
        }
      )
    };
    await scheduleRetention(jobs as never, 600_000);
    expect(enqueued).toEqual([
      { type: gardenerRetentionJobType, dedupeKey: gardenerRetentionJobType, delay: 600_000 }
    ]);
    const executor = retentionJobExecutor({ getPool: () => null });
    expect(executor.needsModel).toBe(false);
    await expect(executor.execute({} as never, new AbortController().signal)).rejects.toThrow(
      "database_unavailable"
    );
  });
});
