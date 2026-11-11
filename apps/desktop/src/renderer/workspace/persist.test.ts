import { describe, expect, it } from "vitest";

import {
  createWorkspaceSaver,
  loadWorkspace,
  readPersistedWorkspace,
  saveWorkspace,
  workspaceSaveDelayMs,
  workspaceStorageKey,
  type WorkspaceStorage
} from "./persist";
import { defaultWorkspace, reduce } from "./state";

const now = new Date("2026-11-11T09:00:00Z");
const london = { timeZone: "Europe/London" };
const fresh = defaultWorkspace("2026-11-11");

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  const storage: WorkspaceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(value);
      values.set(key, value);
    }
  };
  return { storage, values, writes };
}

const throwing: WorkspaceStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  }
};

describe("loadWorkspace", () => {
  it("round-trips a saved state under the Home rule", () => {
    const state = reduce(fresh, { type: "go", destination: "library" });
    const { storage, values } = memoryStorage();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(workspaceStorageKey)).toBe(true);
    expect(workspaceStorageKey).toBe("memora.workspace.v1");
    expect(loadWorkspace(now, storage, london)).toEqual(state);
  });

  it("falls back to the defaults on a missing value, invalid JSON or an old version", () => {
    expect(loadWorkspace(now, memoryStorage().storage, london)).toEqual(fresh);
    const invalid = memoryStorage({ [workspaceStorageKey]: "{not json" });
    expect(readPersistedWorkspace(invalid.storage)).toBeNull();
    expect(loadWorkspace(now, invalid.storage, london)).toEqual(fresh);
    const old = memoryStorage({
      [workspaceStorageKey]: JSON.stringify({ ...fresh, version: 0, destination: "library" })
    });
    expect(loadWorkspace(now, old.storage, london)).toEqual(fresh);
  });

  it("round-trips the S1 view state", () => {
    const state = [
      { type: "firstSource", address: `memora://source/${"00000000-0000-4000-8000-000000000001"}` },
      { type: "scroll", panel: 0, top: 480 },
      { type: "setContextTab", kind: "question", tab: "ask" },
      { type: "hoist", topicId: "00000000-0000-4000-8000-000000000002" },
      { type: "setDensity", density: "compact" }
    ].reduce((current, action) => reduce(current, action as Parameters<typeof reduce>[1]), fresh);
    const { storage } = memoryStorage();
    saveWorkspace(state, storage);
    expect(state.stacks.explore.panels[0]?.scroll).toBe(480);
    expect(loadWorkspace(now, storage, london)).toEqual(state);
  });

  it("gives a state saved without an S1 field that field's default, keeping the rest", () => {
    const saved = reduce(fresh, { type: "go", destination: "library" });
    for (const field of ["contextTab", "hoist", "density"] as const) {
      const rest: Record<string, unknown> = { ...saved };
      delete rest[field];
      const { storage } = memoryStorage({ [workspaceStorageKey]: JSON.stringify(rest) });
      const loaded = loadWorkspace(now, storage, london);
      expect(loaded, field).toEqual(saved);
      expect(loaded.destination).toBe("library");
    }
  });

  it("falls back to the defaults on an invalid S1 field", () => {
    for (const patch of [
      { density: "dense" },
      { hoist: "not-an-id" },
      { contextTab: { note: "activity" } },
      { contextTab: { wiki: "ask" } }
    ]) {
      const { storage } = memoryStorage({
        [workspaceStorageKey]: JSON.stringify({ ...fresh, destination: "library", ...patch })
      });
      expect(loadWorkspace(now, storage, london), JSON.stringify(patch)).toEqual(fresh);
    }
  });

  it("falls back to the defaults when the storage throws or is missing", () => {
    expect(readPersistedWorkspace(throwing)).toBeNull();
    expect(loadWorkspace(now, throwing, london)).toEqual(fresh);
    expect(loadWorkspace(now, null, london)).toEqual(fresh);
  });
});

describe("saveWorkspace", () => {
  it("reports a refused write instead of throwing", () => {
    expect(saveWorkspace(fresh, throwing)).toBe(false);
    expect(saveWorkspace(fresh, null)).toBe(false);
  });
});

describe("createWorkspaceSaver", () => {
  function fakeTimers() {
    const timers = new Map<number, () => void>();
    let next = 0;
    return {
      timers,
      setTimer: (callback: () => void, ms: number) => {
        expect(ms).toBe(workspaceSaveDelayMs);
        next += 1;
        timers.set(next, callback);
        return next;
      },
      clearTimer: (handle: unknown) => {
        timers.delete(handle as number);
      },
      fire() {
        const pending = [...timers.values()];
        timers.clear();
        for (const callback of pending) callback();
      }
    };
  }

  it("writes at most once per delay, always the latest state", () => {
    const { storage, writes } = memoryStorage();
    const clock = fakeTimers();
    const saver = createWorkspaceSaver({ storage, ...clock });
    const first = reduce(fresh, { type: "go", destination: "explore" });
    const second = reduce(first, { type: "toggleContext" });
    saver.save(first);
    saver.save(second);
    expect(clock.timers.size).toBe(1);
    expect(writes).toEqual([]);
    clock.fire();
    expect(writes.map((value) => JSON.parse(value) as unknown)).toEqual([second]);
    clock.fire();
    expect(writes).toHaveLength(1);
  });

  it("flushes the pending state now and cancels a pending write", () => {
    const { storage, writes } = memoryStorage();
    const clock = fakeTimers();
    const saver = createWorkspaceSaver({ storage, ...clock });
    saver.save(fresh);
    saver.flush();
    expect(writes).toHaveLength(1);
    expect(clock.timers.size).toBe(0);
    saver.flush();
    expect(writes).toHaveLength(1);
    saver.save(fresh);
    saver.cancel();
    clock.fire();
    expect(writes).toHaveLength(1);
  });

  it("survives a storage that throws", () => {
    const clock = fakeTimers();
    const saver = createWorkspaceSaver({ storage: throwing, ...clock });
    saver.save(fresh);
    expect(() => clock.fire()).not.toThrow();
  });
});
