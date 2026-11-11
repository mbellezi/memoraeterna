import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { PgPool } from "@app/db";

import { entitiesChannels } from "../../shared/ipc-entities.js";
import { registerEntitiesIpc } from "./entities-ipc.js";

const entityId = randomUUID();
const page = {
  entity: {
    id: entityId,
    type: "concept",
    canonicalName: "Circadian rhythm",
    aliases: [],
    description: null,
    language: "en"
  },
  counts: { notes: 0, sources: 0 },
  mentions: { items: [] }
};

function register(pool: PgPool | null = {} as PgPool, answer: unknown = page) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const repository = { page: vi.fn(async () => answer) };
  registerEntitiesIpc(
    ipc as unknown as IpcMain,
    () => pool,
    () => repository as never
  );
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, repository, channels: [...handlers.keys()] };
}

describe("the entities area over IPC", () => {
  it("registers exactly the area's channels, all under app:entities", () => {
    const { channels } = register();
    expect(channels.sort()).toEqual(Object.values(entitiesChannels).sort());
    for (const channel of channels) expect(channel).toMatch(/^app:entities:[a-z]+$/);
  });

  it("validates the request before it reads and passes the parsed input on", async () => {
    const { call, repository } = register();
    await expect(call(entitiesChannels.page, { id: "nope" })).rejects.toThrow();
    await expect(call(entitiesChannels.page, { id: entityId, extra: 1 })).rejects.toThrow();
    await expect(call(entitiesChannels.page, entityId)).rejects.toThrow();
    expect(repository.page).not.toHaveBeenCalled();
    expect(await call(entitiesChannels.page, { id: entityId, cursor: "abc" })).toEqual(page);
    expect(repository.page).toHaveBeenCalledWith({ id: entityId, cursor: "abc" });
  });

  it("answers null for an entity that does not exist", async () => {
    const { call } = register({} as PgPool, null);
    expect(await call(entitiesChannels.page, { id: entityId })).toBeNull();
  });

  it("refuses an answer that does not fit the contract", async () => {
    const { call } = register({} as PgPool, { ...page, counts: { notes: -1, sources: 0 } });
    await expect(call(entitiesChannels.page, { id: entityId })).rejects.toThrow();
  });

  it("fails with the unavailable key while the database is not ready", async () => {
    const { call, repository } = register(null);
    await expect(call(entitiesChannels.page, { id: entityId })).rejects.toThrow(
      "objects.errors.unavailable"
    );
    expect(repository.page).not.toHaveBeenCalled();
  });
});
