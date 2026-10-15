import type { IpcMain } from "electron";
import type { PgPool } from "@app/db";
import { viewHistoryKinds, viewHistoryLimits } from "@app/db";
import { describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../shared/ipc.js";
import { objectKinds, viewHistoryBounds } from "../../shared/view-history.js";
import { registerViewHistoryIpc } from "./view-history-ipc.js";
import { ViewHistoryService } from "./view-history-service.js";

const sourceId = "00000000-0000-4000-8000-000000000001";
const noteId = "00000000-0000-4000-8000-000000000002";

const storedRow = (overrides: Record<string, unknown> = {}) => ({
  address: `memora://source/${sourceId}`,
  kind: "source",
  objectId: sourceId,
  title: "A source",
  parentAddress: null,
  openedAt: new Date("2026-10-15T10:00:00.000Z"),
  openCount: 2,
  pinned: false,
  ...overrides
});

function setup(rows: unknown[] = [storedRow()], rowCount = rows.length) {
  const query = vi.fn(async () => ({ rows, rowCount }));
  const onChanged = vi.fn();
  const pool = { query } as unknown as PgPool;
  const service = new ViewHistoryService({ getPool: () => pool, onChanged });
  return { service, query, onChanged };
}

function register(service: ViewHistoryService) {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  registerViewHistoryIpc(
    {
      handle: (channel: string, handler: never) => handlers.set(channel, handler)
    } as never as IpcMain,
    service
  );
  return (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload);
}

describe("view history service", () => {
  it("shares its kinds and bounds with the database layer", () => {
    expect([...objectKinds]).toEqual([...viewHistoryKinds]);
    expect(viewHistoryBounds.titleCharacters).toBe(viewHistoryLimits.titleCharacters);
    expect(viewHistoryBounds.listDefault).toBe(viewHistoryLimits.listDefault);
    expect(viewHistoryBounds.listMax).toBe(viewHistoryLimits.listMax);
  });

  it("records an open, answers with the stored entry and tells the renderer once", async () => {
    const { service, onChanged, query } = setup();
    const entry = await service.record({
      kind: "source",
      id: sourceId,
      title: "A source"
    });
    expect(entry).toEqual({
      address: `memora://source/${sourceId}`,
      kind: "source",
      id: sourceId,
      title: "A source",
      parentAddress: null,
      openedAt: "2026-10-15T10:00:00.000Z",
      openCount: 2,
      pinned: false
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalled();
  });

  it("does not announce a change that failed", async () => {
    const { service, onChanged, query } = setup();
    query.mockRejectedValueOnce(new Error("database error"));
    await expect(service.record({ kind: "source", id: sourceId, title: "x" })).rejects.toThrow(
      "database error"
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reports an unavailable database as a user-facing error key", async () => {
    const service = new ViewHistoryService({ getPool: () => null });
    await expect(service.list({})).rejects.toThrow("errors.common.unknown");
    await expect(service.clear()).rejects.toThrow("errors.common.unknown");
  });

  it("lists entries with ISO times, and announces only what actually changed", async () => {
    const { service, onChanged } = setup([storedRow({ pinned: true })]);
    expect((await service.list({ limit: 5 }))[0]).toMatchObject({
      pinned: true,
      openedAt: "2026-10-15T10:00:00.000Z"
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect((await service.setPinned(`memora://source/${sourceId}`, true))?.pinned).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);

    const missing = setup([]);
    expect(await missing.service.setPinned(`memora://source/${sourceId}`, true)).toBeNull();
    expect(missing.onChanged).not.toHaveBeenCalled();

    const cleared = setup([], 3);
    expect(await cleared.service.clear()).toBe(3);
    expect(cleared.onChanged).toHaveBeenCalledTimes(1);
    const nothing = setup([], 0);
    expect(await nothing.service.clear()).toBe(0);
    expect(nothing.onChanged).not.toHaveBeenCalled();
  });
});

describe("view history requests", () => {
  it("validates every request before the service sees it", async () => {
    const { service, query } = setup();
    const call = register(service);
    for (const payload of [
      null,
      {},
      { kind: "page", id: sourceId, title: "x" },
      { kind: "source", id: "not-a-uuid", title: "x" },
      { kind: "source", id: sourceId, title: "   " },
      { kind: "source", id: sourceId, title: "x", extra: true },
      { kind: "source", id: sourceId, title: "x", parentAddress: "https://example.com" },
      { kind: "source", id: sourceId, title: "x", parentAddress: `memora://source/${sourceId}` }
    ])
      await expect(
        Promise.resolve().then(() => call(ipcChannels.viewHistoryRecord, payload))
      ).rejects.toThrow();
    for (const payload of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { kinds: ["page"] },
      { x: 1 }
    ])
      await expect(
        Promise.resolve().then(() => call(ipcChannels.viewHistoryList, payload))
      ).rejects.toThrow();
    for (const payload of [
      undefined,
      { address: "memora://source/nope", pinned: true },
      { address: `memora://source/${sourceId}` },
      { address: `memora://source/${sourceId}`, pinned: "yes" }
    ])
      await expect(
        Promise.resolve().then(() => call(ipcChannels.viewHistoryPin, payload))
      ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("cuts a long title to the stored bound, keeps one line and records a note with its host", async () => {
    const { service, query } = setup([
      storedRow({
        kind: "note",
        objectId: noteId,
        address: `memora://note/${noteId}`,
        parentAddress: `memora://source/${sourceId}`
      })
    ]);
    const call = register(service);
    const entry = (await call(ipcChannels.viewHistoryRecord, {
      kind: "note",
      id: noteId,
      title: `  A\nvery ${"long ".repeat(100)}`,
      parentAddress: `MEMORA://Source/${sourceId}`
    })) as { parentAddress: string };
    expect(entry.parentAddress).toBe(`memora://source/${sourceId}`);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    const title = calls[0]![1][3] as string;
    expect(title.startsWith("A very long")).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(viewHistoryBounds.titleCharacters);
    expect(title).not.toMatch(/\n/u);
    expect(calls[0]![1][4]).toBe(`memora://source/${sourceId}`);
  });

  it("lists with defaults, pins by address and clears", async () => {
    const { service, query } = setup([storedRow({ pinned: true })]);
    const call = register(service);
    expect(await call(ipcChannels.viewHistoryList, undefined)).toHaveLength(1);
    expect(
      await call(ipcChannels.viewHistoryList, { limit: 10, kinds: ["source", "note"] })
    ).toHaveLength(1);
    expect(
      await call(ipcChannels.viewHistoryPin, {
        address: `memora://source/${sourceId}`,
        pinned: true
      })
    ).toMatchObject({ pinned: true });
    expect(await call(ipcChannels.viewHistoryClear)).toBe(1);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0]![1]).toEqual([null, viewHistoryLimits.listDefault]);
    expect(calls[1]![1]).toEqual([["source", "note"], 10]);
    expect(calls[2]![1]).toEqual([`memora://source/${sourceId}`, true]);
  });
});
