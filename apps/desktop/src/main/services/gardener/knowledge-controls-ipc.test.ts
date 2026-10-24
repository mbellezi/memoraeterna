import { defaultKnowledgeControls, type KnowledgeControls } from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { KnowledgeControlsService } from "./knowledge-controls.js";
import { registerKnowledgeControlsIpc } from "./knowledge-controls-ipc.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function setup(options: { present?: boolean; stored?: unknown } = {}) {
  const handlers = new Map<string, Handler>();
  let row: unknown = options.stored ?? null;
  const written: KnowledgeControls[] = [];
  const service = new KnowledgeControlsService({
    store: {
      read: async () => row,
      write: async (controls) => {
        row = controls;
        written.push(controls);
      }
    }
  });
  const shapeChanged = vi.fn();
  registerKnowledgeControlsIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
    () => (options.present === false ? null : service),
    { treeShapeChanged: shapeChanged }
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, service, shapeChanged, written };
}

describe("the Knowledge controls IPC (F4 D13, T98)", () => {
  it("answers the stored controls, every field with its default", async () => {
    const { call } = setup();
    expect(await call(ipcChannels.knowledgeControlsGet)).toEqual(defaultKnowledgeControls);
    const stored = setup({ stored: { autonomy: "suggest", monthlyCapUsd: 12, bogus: 1 } });
    expect(await stored.call(ipcChannels.knowledgeControlsGet)).toEqual({
      ...defaultKnowledgeControls,
      autonomy: "suggest",
      monthlyCapUsd: 12
    });
  });

  it("changes any subset, stores it and answers the controls after it", async () => {
    const { call, written, service } = setup();
    expect(
      await call(ipcChannels.knowledgeControlsUpdate, { paused: true, onlyOnAc: true })
    ).toEqual({
      ...defaultKnowledgeControls,
      paused: true,
      onlyOnAc: true
    });
    expect(written).toHaveLength(1);
    expect(service.current()).toMatchObject({ paused: true, onlyOnAc: true });
    // The next change keeps the earlier ones.
    expect(await call(ipcChannels.knowledgeControlsUpdate, { autonomy: "off" })).toMatchObject({
      paused: true,
      autonomy: "off"
    });
  });

  it("refuses what is not a control or is out of range, storing nothing", async () => {
    const { call, written } = setup();
    for (const change of [
      { autonomy: "reckless" },
      { monthlyCapUsd: -1 },
      { monthlyCapUsd: 1_000_000 },
      { treeShape: "wide" },
      { paused: "yes" },
      { unknown: true },
      null,
      "paused"
    ])
      await expect(
        call(ipcChannels.knowledgeControlsUpdate, change),
        JSON.stringify(change)
      ).rejects.toThrow();
    await expect(call(ipcChannels.knowledgeControlsGet, "extra")).rejects.toThrow();
    expect(written).toEqual([]);
  });

  it("hands a tree shape the person changed to the build, and nothing else", async () => {
    const { call, shapeChanged } = setup();
    await call(ipcChannels.knowledgeControlsUpdate, { autonomy: "suggest", onlyIdle: true });
    expect(shapeChanged).not.toHaveBeenCalled();
    await call(ipcChannels.knowledgeControlsUpdate, { treeShape: "deep" });
    expect(shapeChanged).toHaveBeenCalledTimes(1);
    // The same shape again is no change.
    await call(ipcChannels.knowledgeControlsUpdate, { treeShape: "deep" });
    expect(shapeChanged).toHaveBeenCalledTimes(1);
    await call(ipcChannels.knowledgeControlsUpdate, { treeShape: "broad" });
    expect(shapeChanged).toHaveBeenCalledTimes(2);
  });

  it("does not hand the shape on when the change could not be stored", async () => {
    const shapeChanged = vi.fn();
    const handlers = new Map<string, Handler>();
    const service = new KnowledgeControlsService({
      store: {
        read: async () => null,
        write: async () => {
          throw new Error("errors.database.notReady");
        }
      }
    });
    registerKnowledgeControlsIpc(
      { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
      () => service,
      { treeShapeChanged: shapeChanged }
    );
    await expect(
      handlers.get(ipcChannels.knowledgeControlsUpdate)!({}, { treeShape: "deep" })
    ).rejects.toThrow("errors.database.notReady");
    expect(shapeChanged).not.toHaveBeenCalled();
  });

  it("says so when there is no background policy to keep the controls", async () => {
    const { call } = setup({ present: false });
    await expect(call(ipcChannels.knowledgeControlsGet)).rejects.toThrow(
      "errors.common.missingConfiguration"
    );
    await expect(call(ipcChannels.knowledgeControlsUpdate, { paused: true })).rejects.toThrow(
      "errors.common.missingConfiguration"
    );
  });
});
