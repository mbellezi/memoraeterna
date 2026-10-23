import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ConsultationStatusEventSchema, ipcChannels } from "../../shared/ipc.js";
import { registerConsultationIpc } from "./consultation-ipc.js";
import type { ConsultationService } from "./consultation-service.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const service = { ask: vi.fn(async () => "answer"), cancel: vi.fn(() => null) };
  registerConsultationIpc(ipc as unknown as IpcMain, service as unknown as ConsultationService);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, service, channels: [...handlers.keys()] };
}

describe("Ask over IPC", () => {
  it("registers only asking and canceling: saving, following and the followed questions are gone", () => {
    const { channels } = register();
    expect(channels.sort()).toEqual(
      [ipcChannels.consultationAsk, ipcChannels.consultationCancel].sort()
    );
  });
  it("validates a question before asking and cancels by request id", async () => {
    const { call, service } = register();
    const requestId = randomUUID();
    await expect(call(ipcChannels.consultationAsk, { requestId, question: "x" })).rejects.toThrow();
    await expect(
      call(ipcChannels.consultationAsk, { requestId, question: "A question", pageId: randomUUID() })
    ).rejects.toThrow();
    expect(service.ask).not.toHaveBeenCalled();
    await call(ipcChannels.consultationAsk, { requestId, question: "A question" });
    expect(service.ask).toHaveBeenCalledOnce();
    await call(ipcChannels.consultationCancel, requestId);
    expect(service.cancel).toHaveBeenCalledWith(requestId);
  });
});

describe("what a running Ask tells the window that asked", () => {
  /** Registers the handlers over a service whose Ask reports the given statuses as it runs. */
  function asking(statuses: string[]) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = {
      ask: vi.fn(async (_input: unknown, hooks: { onStatus?: (status: string) => void }) => {
        for (const status of statuses) hooks.onStatus?.(status);
        return "answer";
      }),
      cancel: vi.fn(async () => null)
    };
    registerConsultationIpc(ipc as unknown as IpcMain, service as unknown as ConsultationService);
    return (sender: unknown, requestId: string) =>
      handlers.get(ipcChannels.consultationAsk)!({ sender }, { requestId, question: "A question" });
  }
  const sender = (destroyed = false) => ({ isDestroyed: () => destroyed, send: vi.fn() });

  it("pushes the status, tagged with the request, to the window that asked", async () => {
    const window = sender();
    const requestId = randomUUID();
    await asking(["waitingForProvider", "answering"])(window, requestId);
    expect(window.send.mock.calls).toEqual([
      [ipcChannels.consultationStatus, { requestId, status: "waitingForProvider" }],
      [ipcChannels.consultationStatus, { requestId, status: "answering" }]
    ]);
    for (const [, payload] of window.send.mock.calls)
      expect(ConsultationStatusEventSchema.parse(payload)).toEqual(payload);
  });
  it("sends nothing to a window that closed, and accepts nothing it does not know", async () => {
    const closed = sender(true);
    await asking(["waitingForProvider"])(closed, randomUUID());
    expect(closed.send).not.toHaveBeenCalled();
    const requestId = randomUUID();
    expect(() => ConsultationStatusEventSchema.parse({ requestId, status: "thinking" })).toThrow();
    expect(() =>
      ConsultationStatusEventSchema.parse({ requestId, status: "answering", detail: "x" })
    ).toThrow();
    await expect(asking([])(undefined, randomUUID())).resolves.toBe("answer");
  });
});
