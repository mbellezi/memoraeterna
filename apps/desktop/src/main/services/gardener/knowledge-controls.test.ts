import { defaultKnowledgeControls, type KnowledgeControls } from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeControlsService,
  type KnowledgeControlsChange,
  type KnowledgeControlsStore
} from "./knowledge-controls.js";

function memoryStore(initial: unknown = null) {
  const state = { value: initial, reads: 0, writes: 0 };
  const store: KnowledgeControlsStore = {
    read: async () => {
      state.reads += 1;
      return state.value;
    },
    write: async (controls: KnowledgeControls) => {
      state.writes += 1;
      state.value = { ...controls };
    }
  };
  return { state, store };
}

describe("Knowledge controls service (D13)", () => {
  it("serves the defaults until read, then the stored controls without another query", async () => {
    const { state, store } = memoryStore({ paused: true, autonomy: "suggest" });
    const service = new KnowledgeControlsService({ store });
    expect(service.current()).toEqual(defaultKnowledgeControls);
    const read = await service.get();
    expect(read).toMatchObject({ paused: true, autonomy: "suggest", monthlyCapUsd: 5 });
    await service.get();
    expect(service.current()).toBe(read);
    expect(state.reads).toBe(1);
  });

  it("reads again for another database (a restore or a reset)", async () => {
    const { state, store } = memoryStore({ paused: true });
    let pool: object = { name: "first" };
    const service = new KnowledgeControlsService({ store, pool: () => pool });
    expect((await service.get()).paused).toBe(true);
    state.value = null;
    pool = { name: "restored" };
    expect((await service.get()).paused).toBe(false);
    expect(state.reads).toBe(2);
  });

  it("validates a change, stores it, moves the generation and names what changed", async () => {
    const { state, store } = memoryStore();
    const service = new KnowledgeControlsService({ store });
    const changes: KnowledgeControlsChange[] = [];
    service.subscribe((change) => changes.push(change));
    await service.get();
    const before = service.generation();
    const after = await service.update({ paused: true, onlyIdle: true });
    expect(after).toMatchObject({ paused: true, onlyIdle: true, autonomy: "auto" });
    expect(state.value).toEqual(after);
    expect(service.current()).toEqual(after);
    expect(service.generation()).toBeGreaterThan(before);
    expect(changes.map((change) => change.changed)).toEqual([["paused", "onlyIdle"]]);
    // The same value again tells nobody.
    await service.update({ paused: true });
    expect(changes).toHaveLength(1);
  });

  it("refuses an invalid change and keeps what was stored", async () => {
    const { state, store } = memoryStore({ autonomy: "off" });
    const service = new KnowledgeControlsService({ store });
    await expect(service.update({ autonomy: "always" })).rejects.toThrow();
    await expect(service.update({ unknown: true })).rejects.toThrow();
    expect(state.writes).toBe(0);
    // A later change still applies after the refused ones.
    await expect(service.update({ paused: true })).resolves.toMatchObject({
      autonomy: "off",
      paused: true
    });
  });

  it("applies concurrent changes one after the other, none lost", async () => {
    const { state, store } = memoryStore();
    const service = new KnowledgeControlsService({ store });
    await Promise.all([
      service.update({ paused: true }),
      service.update({ onlyOnAc: true }),
      service.update({ autonomy: "suggest" })
    ]);
    expect(state.value).toMatchObject({ paused: true, onlyOnAc: true, autonomy: "suggest" });
  });

  it("keeps a listener's failure from the others", async () => {
    const { store } = memoryStore();
    const logger = { warn: vi.fn() };
    const service = new KnowledgeControlsService({ store, logger });
    const heard = vi.fn();
    service.subscribe(() => {
      throw new Error("listener");
    });
    service.subscribe(heard);
    await service.update({ paused: true });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
