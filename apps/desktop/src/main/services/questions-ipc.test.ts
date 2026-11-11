import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ConsultationInputSchema } from "@app/domain";

import {
  questionAskTextLimits,
  questionsChannels,
  QuestionsAskInputSchema
} from "../../shared/ipc-questions.js";
import { registerQuestionsIpc } from "./questions-ipc.js";
import type { QuestionsService } from "./questions-service.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const service = {
    ask: vi.fn(async () => ({ questionId: randomUUID(), requestId: randomUUID() })),
    cancel: vi.fn(async () => null),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [] })),
    delete: vi.fn(async () => ({ deleted: true })),
    askAgain: vi.fn(async () => ({ requestId: randomUUID() })),
    clear: vi.fn(async () => ({ deleted: 3 }))
  };
  registerQuestionsIpc(ipc as unknown as IpcMain, service as unknown as QuestionsService);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, service, channels: [...handlers.keys()] };
}

describe("the questions area over IPC", () => {
  it("registers exactly the area's channels, all under app:questions", () => {
    const { channels } = register();
    expect(channels.sort()).toEqual(Object.values(questionsChannels).sort());
    for (const channel of channels) expect(channel).toMatch(/^app:questions:[a-z-]+$/);
  });

  it("validates a question before asking and passes the parsed input on", async () => {
    const { call, service } = register();
    await expect(call(questionsChannels.ask, { text: "hi" })).rejects.toThrow();
    await expect(
      call(questionsChannels.ask, { text: "A question", pageId: randomUUID() })
    ).rejects.toThrow();
    await expect(
      call(questionsChannels.ask, { text: "A question", scope: { kind: "sources", sourceIds: [] } })
    ).rejects.toThrow();
    expect(service.ask).not.toHaveBeenCalled();
    const result = await call(questionsChannels.ask, {
      text: "  A question  ",
      privacy: "allow_remote"
    });
    expect(service.ask).toHaveBeenCalledWith({ text: "A question", privacy: "allow_remote" });
    expect(result).toMatchObject({ questionId: expect.any(String), requestId: expect.any(String) });
  });

  it("cancels by request id only", async () => {
    const { call, service } = register();
    const requestId = randomUUID();
    await expect(call(questionsChannels.cancel, { requestId: "nope" })).rejects.toThrow();
    await expect(call(questionsChannels.cancel, requestId)).rejects.toThrow();
    expect(service.cancel).not.toHaveBeenCalled();
    await expect(call(questionsChannels.cancel, { requestId })).resolves.toBeNull();
    expect(service.cancel).toHaveBeenCalledWith({ requestId });
  });

  it("reads, lists, deletes, asks again and clears with validated requests", async () => {
    const { call, service } = register();
    const id = randomUUID();
    for (const channel of [
      questionsChannels.get,
      questionsChannels.delete,
      questionsChannels.askAgain
    ]) {
      await expect(call(channel, { id: "nope" })).rejects.toThrow();
      await expect(call(channel, { id, extra: true })).rejects.toThrow();
      await expect(call(channel, undefined)).rejects.toThrow();
    }
    await call(questionsChannels.get, { id });
    await call(questionsChannels.delete, { id });
    await call(questionsChannels.askAgain, { id });
    expect(service.get).toHaveBeenCalledWith({ id });
    expect(service.delete).toHaveBeenCalledWith({ id });
    expect(service.askAgain).toHaveBeenCalledWith({ id });
    await expect(call(questionsChannels.list, { limit: 51 })).rejects.toThrow();
    await expect(call(questionsChannels.list, { limit: 0 })).rejects.toThrow();
    await expect(call(questionsChannels.list, { cursor: "" })).rejects.toThrow();
    await call(questionsChannels.list, undefined);
    expect(service.list).toHaveBeenLastCalledWith({});
    await call(questionsChannels.list, { cursor: "abc", limit: 50, query: "memory" });
    expect(service.list).toHaveBeenLastCalledWith({ cursor: "abc", limit: 50, query: "memory" });
    await expect(call(questionsChannels.clear)).resolves.toEqual({ deleted: 3 });
  });

  it("takes the same words the consultation pipeline takes, no more and no less", () => {
    const { min, max } = questionAskTextLimits;
    for (const length of [min - 1, min, max, max + 1]) {
      const text = "q".repeat(length);
      const pipeline = ConsultationInputSchema.safeParse({
        requestId: randomUUID(),
        question: text
      });
      expect(QuestionsAskInputSchema.safeParse({ text }).success, `${length} characters`).toBe(
        pipeline.success
      );
    }
  });
});
