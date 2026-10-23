import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { AppEventSchema, type AppEvent } from "../../shared/app-events.js";
import { ipcChannels } from "../../shared/ipc.js";
import { AppEventBus } from "./app-events.js";
import { registerConsultationIpc } from "./consultation-ipc.js";
import type { ConsultationService } from "./consultation-service.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const service = { ask: vi.fn(async () => "answer"), cancel: vi.fn(() => null) };
  registerConsultationIpc(ipc as unknown as IpcMain, service as unknown as ConsultationService, {
    publish: vi.fn()
  });
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

describe("what a running Ask tells the windows (F4 D26)", () => {
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
    const sent: AppEvent[] = [];
    const invalid: Error[] = [];
    const bus = new AppEventBus({
      send: (event) => sent.push(event),
      onInvalid: (error) => invalid.push(error)
    });
    registerConsultationIpc(
      ipc as unknown as IpcMain,
      service as unknown as ConsultationService,
      bus
    );
    const ask = (requestId: string) =>
      handlers.get(ipcChannels.consultationAsk)!({}, { requestId, question: "A question" });
    return { ask, bus, sent, invalid, channels: [...handlers.keys()] };
  }

  it("publishes the status on the bus, tagged with the request, and opens no channel of its own", async () => {
    const { ask, bus, sent, invalid, channels } = asking(["waitingForProvider"]);
    const requestId = randomUUID();
    await expect(ask(requestId)).resolves.toBe("answer");
    bus.flush();
    expect(sent).toEqual([
      { type: "consultation.status", requestId, status: "waitingForProvider" }
    ]);
    expect(invalid).toEqual([]);
    for (const event of sent) expect(AppEventSchema.parse(event)).toEqual(event);
    expect(channels.sort()).toEqual(
      [ipcChannels.consultationAsk, ipcChannels.consultationCancel].sort()
    );
    expect(Object.keys(ipcChannels)).not.toContain("consultationStatus");
    bus.dispose();
  });

  it("keeps the newest status of each request apart from another request's", async () => {
    const { ask, bus, sent } = asking(["waitingForProvider", "answering"]);
    const first = randomUUID();
    const second = randomUUID();
    await ask(first);
    await ask(second);
    bus.flush();
    expect(sent).toEqual([
      { type: "consultation.status", requestId: first, status: "answering" },
      { type: "consultation.status", requestId: second, status: "answering" }
    ]);
    bus.dispose();
  });

  it("sends a status the contract does not know to no window", async () => {
    const { ask, bus, sent, invalid } = asking(["thinking"]);
    await expect(ask(randomUUID())).resolves.toBe("answer");
    bus.flush();
    expect(sent).toEqual([]);
    expect(invalid).toHaveLength(1);
    const requestId = randomUUID();
    expect(
      AppEventSchema.safeParse({
        type: "consultation.status",
        requestId,
        status: "answering",
        detail: "x"
      }).success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "consultation.status", requestId: "r", status: "answering" })
        .success
    ).toBe(false);
    bus.dispose();
  });
});
