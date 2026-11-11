import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../shared/ipc.js";
import { homeChannels } from "../shared/ipc-home.js";
import { createHomeApi } from "./home-api.js";

const empty = {
  since: "2026-11-04T11:00:00.000Z",
  firstRun: true,
  continue: [],
  new: {
    sources: { total: 0, items: [] },
    notes: { total: 0, placed: 0, unplaced: 0, items: [] }
  },
  inbox: { total: 0, top: [] },
  questions: [],
  growth: [],
  shape: {
    hasTree: false,
    notes: 0,
    topics: 0,
    depth: 0,
    violations: { hard: 0, soft: 0 },
    outOfBounds: 0,
    arrivalsThisWeek: 0,
    roots: []
  },
  gardener: { count: 0, top: [] }
};

describe("home area channels", () => {
  it("are named by the area and held once by ipcChannels (F5 T171)", () => {
    expect(homeChannels).toEqual({ digest: "app:home:digest" });
    expect(
      Object.values(ipcChannels).filter((value) => value === homeChannels.digest)
    ).toHaveLength(1);
  });
});

describe("createHomeApi", () => {
  it("validates the request before it leaves and the digest before the page sees it", async () => {
    const invoke = vi.fn(async () => empty);
    const api = createHomeApi(invoke);
    const since = "2026-11-10T22:40:00.000Z";
    expect(await api.digest({ since })).toEqual(empty);
    expect(invoke).toHaveBeenLastCalledWith(homeChannels.digest, { since });
    await api.digest();
    expect(invoke).toHaveBeenLastCalledWith(homeChannels.digest, {});
    await api.digest({ since: null });
    expect(invoke).toHaveBeenLastCalledWith(homeChannels.digest, { since: null });
    const calls = invoke.mock.calls.length;
    await expect(api.digest({ since: "yesterday" })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(calls);
    await expect(
      createHomeApi(async () => ({ ...empty, firstRun: "yes" })).digest()
    ).rejects.toThrow();
    await expect(createHomeApi(async () => ({ ...empty, extra: 1 })).digest()).rejects.toThrow();
  });
});
