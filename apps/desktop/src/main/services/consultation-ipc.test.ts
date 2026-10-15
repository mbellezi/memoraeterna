import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ipcChannels } from "../../shared/ipc.js";
import { registerConsultationIpc } from "./consultation-ipc.js";
import type { ConsultationService } from "./consultation-service.js";
import type { InvestigationService } from "./investigation-service.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const service = { ask: vi.fn(async () => "answer"), cancel: vi.fn(() => null) };
  const investigations = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    follow: vi.fn(),
    state: vi.fn()
  };
  registerConsultationIpc(
    ipc as unknown as IpcMain,
    service as unknown as ConsultationService,
    investigations as unknown as InvestigationService
  );
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, service, investigations };
}

describe("Ask over IPC", () => {
  it("answers consultation.errors.retired to saving an answer and to following a question", async () => {
    const { call, service, investigations } = register();
    for (const channel of [
      ipcChannels.consultationSave,
      ipcChannels.investigationFollow,
      ipcChannels.investigationState
    ])
      await expect(call(channel, { anything: true })).rejects.toThrow(
        "consultation.errors.retired"
      );
    expect(investigations.follow).not.toHaveBeenCalled();
    expect(investigations.state).not.toHaveBeenCalled();
    expect(service.ask).not.toHaveBeenCalled();
  });
  it("keeps the stored followed questions readable", async () => {
    const { call, investigations } = register();
    await call(ipcChannels.investigationList);
    await call(ipcChannels.investigationGet, randomUUID());
    expect(investigations.list).toHaveBeenCalledOnce();
    expect(investigations.get).toHaveBeenCalledOnce();
    await expect(call(ipcChannels.investigationGet, "not-an-id")).rejects.toThrow();
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
