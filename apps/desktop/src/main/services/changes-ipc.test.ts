import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import type { PgPool } from "@app/db";

import { ipcChannels } from "../../shared/ipc.js";
import { changesObjectChannels } from "../../shared/ipc-changes-object.js";
import {
  createChangesObjectService,
  registerChangesObjectIpc,
  type ChangesObjectService
} from "./changes-ipc.js";

const summary = (id: string) => ({
  kind: "topic",
  id,
  titleKey: "topics.changeSets.place",
  titleParams: { count: 3 },
  risk: "low",
  status: "applied",
  origin: "place",
  subjectId: randomUUID(),
  jobId: null,
  at: "2026-11-11T10:00:00.000Z",
  undoneAt: null,
  undo: "unavailable"
});

/** A pool that answers the statements of the read: the view rows, nothing for the undo refinement. */
function fakePool(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("hits(") ? rows : [] }));
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query } as unknown as PgPool, query };
}

function register(service: ChangesObjectService) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  registerChangesObjectIpc(ipc as unknown as IpcMain, service);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, channels: [...handlers.keys()] };
}

describe("the change-sets of one object over IPC", () => {
  it("registers its one channel, which ipcChannels holds once", () => {
    const { channels } = register({ forObject: vi.fn() });
    expect(channels).toEqual([changesObjectChannels.forObject]);
    expect(changesObjectChannels.forObject).toBe("app:changes:for-object");
    expect(
      Object.values(ipcChannels).filter((value) => value === changesObjectChannels.forObject)
    ).toHaveLength(1);
  });

  it("validates a request before the service sees it: a kind, a UUID, at most twenty", async () => {
    const forObject = vi.fn(async () => ({ items: [] }));
    const { call } = register({ forObject });
    const channel = changesObjectChannels.forObject;
    for (const bad of [
      undefined,
      {},
      { kind: "topic" },
      { kind: "folder", id: randomUUID() },
      { kind: "topic", id: "nope" },
      { kind: "topic", id: randomUUID(), limit: 21 },
      { kind: "topic", id: randomUUID(), limit: 0 },
      { kind: "topic", id: randomUUID(), extra: true }
    ])
      await expect(call(channel, bad)).rejects.toThrow();
    expect(forObject).not.toHaveBeenCalled();
    await call(channel, { kind: "note", id: randomUUID() });
    expect(forObject).toHaveBeenCalledTimes(1);
  });

  it("reads the repository's rows and validates the answer before it leaves", async () => {
    const id = randomUUID();
    const { pool, query } = fakePool([summary(id)]);
    const service = createChangesObjectService({ getPool: () => pool });
    const result = await service.forObject({ kind: "topic", id: randomUUID() });
    expect(result.items.map((item) => item.id)).toEqual([id]);
    // The limit defaults to twenty.
    expect(
      query.mock.calls.some((call) => (call as unknown[])[1]?.toString().endsWith(",20"))
    ).toBe(true);
  });

  it("answers an entity or a question without a read, and says when the library is closed", async () => {
    const { pool, query } = fakePool([summary(randomUUID())]);
    const open = createChangesObjectService({ getPool: () => pool });
    expect(await open.forObject({ kind: "entity", id: randomUUID() })).toEqual({ items: [] });
    expect(await open.forObject({ kind: "question", id: randomUUID() })).toEqual({ items: [] });
    expect(query).not.toHaveBeenCalled();
    const closed = createChangesObjectService({ getPool: () => null });
    await expect(closed.forObject({ kind: "note", id: randomUUID() })).rejects.toThrow(
      "changes.errors.unavailable"
    );
  });

  it("refuses an answer that is not a list of change-sets", async () => {
    const { pool } = fakePool([{ ...summary(randomUUID()), risk: "enormous" }]);
    const service = createChangesObjectService({ getPool: () => pool });
    await expect(service.forObject({ kind: "topic", id: randomUUID() })).rejects.toThrow();
  });
});
