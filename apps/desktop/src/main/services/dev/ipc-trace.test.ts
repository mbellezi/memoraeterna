import { describe, expect, it } from "vitest";

import {
  installIpcTrace,
  ipcTraceCapacity,
  ipcTraceGlobalKey,
  IpcTraceRing,
  type IpcTraceTarget
} from "./ipc-trace.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const target: IpcTraceTarget = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    handleOnce: (channel, listener) => void handlers.set(channel, listener)
  };
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { target, invoke };
}

describe("IpcTraceRing", () => {
  it("keeps entries oldest first until it is full", () => {
    const ring = new IpcTraceRing(3);
    ring.record("a", 1);
    ring.record("b", 2);
    expect(ring.entries()).toEqual([
      { channel: "a", at: 1 },
      { channel: "b", at: 2 }
    ]);
    expect(ring.size).toBe(2);
    expect(ring.dropped).toBe(0);
  });

  it("drops the oldest entry once full and counts it", () => {
    const ring = new IpcTraceRing(3);
    for (let at = 1; at <= 5; at += 1) ring.record(`c${at}`, at);
    expect(ring.entries().map((entry) => entry.at)).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.dropped).toBe(2);
  });

  it("clears", () => {
    const ring = new IpcTraceRing(2);
    ring.record("a", 1);
    ring.record("b", 2);
    ring.record("c", 3);
    ring.clear();
    expect(ring.entries()).toEqual([]);
    expect(ring.dropped).toBe(0);
    ring.record("d", 4);
    expect(ring.entries()).toEqual([{ channel: "d", at: 4 }]);
  });

  it("holds 10,000 entries by default and refuses a capacity that is not positive", () => {
    expect(new IpcTraceRing().capacity).toBe(ipcTraceCapacity);
    expect(ipcTraceCapacity).toBe(10_000);
    expect(() => new IpcTraceRing(0)).toThrow();
    expect(() => new IpcTraceRing(1.5)).toThrow();
  });
});

describe("installIpcTrace", () => {
  it("records each invocation's channel and time before the handler runs, never its arguments", async () => {
    const { target, invoke } = fakeIpcMain();
    const scope: Record<string, unknown> = {};
    let clock = 100;
    const ring = installIpcTrace(target, {
      isPackaged: false,
      env: { MEMORA_IPC_TRACE: "1" },
      now: () => clock,
      scope
    });
    expect(ring).not.toBeNull();
    expect(scope[ipcTraceGlobalKey]).toBe(ring);
    target.handle("app:notes:get", (_event, id) => `note ${String(id)}`);
    target.handleOnce!("app:once", () => ring!.size);
    expect(await invoke("app:notes:get", "secret-id")).toBe("note secret-id");
    clock = 250;
    expect(await invoke("app:once")).toBe(2);
    expect(ring!.entries()).toEqual([
      { channel: "app:notes:get", at: 100 },
      { channel: "app:once", at: 250 }
    ]);
    expect(JSON.stringify(ring!.entries())).not.toContain("secret-id");
  });

  it.each([
    ["the knob is unset", false, {}],
    ["the knob is not 1", false, { MEMORA_IPC_TRACE: "true" }],
    ["the build is packaged", true, { MEMORA_IPC_TRACE: "1" }]
  ])("installs nothing when %s", (_case, isPackaged, env) => {
    const { target, invoke } = fakeIpcMain();
    const handle = target.handle;
    const scope: Record<string, unknown> = {};
    expect(installIpcTrace(target, { isPackaged, env, scope })).toBeNull();
    expect(target.handle).toBe(handle);
    expect(scope).toEqual({});
    target.handle("x", () => 1);
    expect(invoke("x")).toBe(1);
  });

  it("wraps once when installed twice", () => {
    const { target, invoke } = fakeIpcMain();
    const options = { isPackaged: false, env: { MEMORA_IPC_TRACE: "1" }, scope: {} };
    const first = installIpcTrace(target, options);
    const second = installIpcTrace(target, options);
    expect(second).toBe(first);
    target.handle("x", () => 1);
    invoke("x");
    expect(first!.size).toBe(1);
  });
});
