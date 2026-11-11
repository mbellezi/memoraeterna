import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../shared/ipc.js";
import { objectsIpcChannels } from "../shared/ipc-objects.js";
import { createObjectsApi } from "./objects-api.js";

const note = "memora://note/00000000-0000-4000-8000-000000000001";
const summary = {
  address: note,
  kind: "note",
  title: "A note",
  status: "current",
  preview: "Plain text.",
  updatedAt: "2026-11-11T10:00:00.000Z"
};

describe("objects area channels", () => {
  it("are named by the area and collide with no other channel", () => {
    expect(objectsIpcChannels).toEqual({
      objectsGet: "app:objects:get",
      objectsResolveMany: "app:objects:resolve-many",
      objectsBacklinks: "app:objects:backlinks"
    });
    // `ipcChannels` holds the area's channels (F5 T170): each once, and no value twice.
    const all = Object.values(ipcChannels);
    for (const channel of Object.values(objectsIpcChannels))
      expect(all.filter((value) => value === channel)).toHaveLength(1);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("createObjectsApi", () => {
  const api = (answer: unknown) => {
    const invoke = vi.fn(async () => answer);
    return { api: createObjectsApi({ invoke }), invoke };
  };

  it("validates a request before it leaves and a response before the page sees it", async () => {
    const get = api(summary);
    expect(await get.api.get({ address: note })).toEqual(summary);
    expect(get.invoke).toHaveBeenCalledWith(objectsIpcChannels.objectsGet, { address: note });
    await expect(get.api.get({ address: "nope" })).rejects.toThrow();
    expect(get.invoke).toHaveBeenCalledTimes(1);
    await expect(
      api({ ...summary, preview: "x".repeat(281) }).api.get({ address: note })
    ).rejects.toThrow();
  });

  it("resolves many and pages backlinks through their channels", async () => {
    const many = api({ items: { [note]: summary }, missing: [] });
    expect(await many.api.resolveMany({ addresses: [note], include: { path: true } })).toEqual({
      items: { [note]: summary },
      missing: []
    });
    expect(many.invoke).toHaveBeenCalledWith(objectsIpcChannels.objectsResolveMany, {
      addresses: [note],
      include: { path: true }
    });
    await expect(many.api.resolveMany({ addresses: [note, note] })).rejects.toThrow();

    const links = api({ items: [{ from: note, via: "mention" }], next: "abc" });
    expect(await links.api.backlinks({ address: note })).toEqual({
      items: [{ from: note, via: "mention" }],
      next: "abc"
    });
    expect(links.invoke).toHaveBeenCalledWith(objectsIpcChannels.objectsBacklinks, {
      address: note,
      limit: 50
    });
    await expect(links.api.backlinks({ address: note, limit: 51 })).rejects.toThrow();
    await expect(
      api({ items: [{ from: note, via: "other" }] }).api.backlinks({ address: note })
    ).rejects.toThrow();
  });
});
