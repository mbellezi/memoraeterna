import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../shared/ipc.js";
import { entitiesChannels } from "../shared/ipc-entities.js";
import { createEntitiesApi } from "./entities-api.js";

const id = randomUUID();
const page = {
  entity: {
    id,
    type: "concept",
    canonicalName: "Circadian rhythm",
    aliases: ["Body clock"],
    description: null,
    language: "en"
  },
  counts: { notes: 1, sources: 1 },
  mentions: { items: [] }
};

describe("entities area channels", () => {
  it("are named by the area and held once by ipcChannels (F5 T171)", () => {
    expect(entitiesChannels).toEqual({ page: "app:entities:page" });
    const all = Object.values(ipcChannels) as string[];
    for (const channel of Object.values(entitiesChannels))
      expect(all.filter((value) => value === channel)).toHaveLength(1);
  });
});

describe("createEntitiesApi", () => {
  const api = (answer: unknown) => {
    const invoke = vi.fn(async () => answer);
    return { api: createEntitiesApi({ invoke }), invoke };
  };

  it("validates a request before it leaves and a response before the page sees it", async () => {
    const ok = api(page);
    expect(await ok.api.page({ id })).toEqual(page);
    expect(ok.invoke).toHaveBeenCalledWith(entitiesChannels.page, { id });
    await expect(ok.api.page({ id: "nope" })).rejects.toThrow();
    expect(ok.invoke).toHaveBeenCalledTimes(1);
    await expect(api({ ...page, extra: true }).api.page({ id })).rejects.toThrow();
  });

  it("passes null through for a missing entity", async () => {
    expect(await api(null).api.page({ id, cursor: "abc" })).toBeNull();
  });
});
