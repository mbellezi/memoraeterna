import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ipcChannels } from "../../shared/ipc.js";
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
