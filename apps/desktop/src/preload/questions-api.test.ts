import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { questionsChannels } from "../shared/ipc-questions.js";
import { createQuestionsApi } from "./questions-api.js";

describe("window.app.questions", () => {
  it("sends a validated request on its channel and returns a validated answer", async () => {
    const answer = { questionId: randomUUID(), requestId: randomUUID() };
    const invoke = vi.fn(async () => answer);
    const api = createQuestionsApi(invoke);
    await expect(api.ask({ text: "A question", scope: { kind: "library" } })).resolves.toEqual(
      answer
    );
    expect(invoke).toHaveBeenCalledWith(questionsChannels.ask, {
      text: "A question",
      scope: { kind: "library" }
    });
  });

  it("refuses a request that does not match before it leaves", async () => {
    const invoke = vi.fn(async () => null);
    const api = createQuestionsApi(invoke);
    await expect(api.ask({ text: "" })).rejects.toThrow();
    await expect(api.ask({ text: "A question", extra: true } as never)).rejects.toThrow();
    await expect(api.cancel({ requestId: "nope" })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an answer that does not match what the area promises", async () => {
    await expect(
      createQuestionsApi(async () => ({ questionId: "x", requestId: randomUUID() })).ask({
        text: "A question"
      })
    ).rejects.toThrow();
    await expect(
      createQuestionsApi(async () => "ok").cancel({ requestId: randomUUID() })
    ).rejects.toThrow();
  });

  const address = (kind: string, id = randomUUID()) => `memora://${kind}/${id}`;
  const questionView = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    text: "What helps memory?",
    language: "en",
    scope: { kind: "library" },
    privacy: "offline_only",
    mode: "text",
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:05.000Z",
    status: "complete",
    answers: [
      {
        version: 1,
        status: "complete",
        paragraphs: [
          {
            markdown: "Retrieval practice helps [e1].",
            citations: [
              {
                ordinal: 1,
                address: address("source"),
                anchor: { passage: randomUUID() },
                unavailable: false,
                stale: false
              }
            ]
          }
        ],
        model: { route: "class:answer", model: "m" },
        completedAt: "2026-11-11T10:00:05.000Z",
        stale: false
      }
    ],
    ...overrides
  });

  it("reads one question on its channel, validated both ways, null when there is none", async () => {
    const view = questionView();
    const id = view.id;
    const invoke = vi.fn(async () => view);
    const api = createQuestionsApi(invoke);
    await expect(api.get({ id })).resolves.toEqual(view);
    expect(invoke).toHaveBeenCalledWith(questionsChannels.get, { id });
    await expect(createQuestionsApi(async () => null).get({ id })).resolves.toBeNull();
    await expect(api.get({ id: "nope" })).rejects.toThrow();
    await expect(
      createQuestionsApi(async () => ({ ...view, status: "stuck" })).get({ id })
    ).rejects.toThrow();
    await expect(
      createQuestionsApi(async () => ({ ...view, surprise: 1 })).get({ id })
    ).rejects.toThrow();
  });

  it("lists with an optional request and refuses a page out of bounds", async () => {
    const page = {
      items: [
        {
          id: randomUUID(),
          text: "What helps memory?",
          language: "en",
          scope: { kind: "library" },
          status: "running",
          createdAt: "2026-11-11T10:00:00.000Z",
          updatedAt: "2026-11-11T10:00:00.000Z",
          answerCount: 0
        }
      ],
      next: "cursor"
    };
    const invoke = vi.fn(async () => page);
    const api = createQuestionsApi(invoke);
    await expect(api.list()).resolves.toEqual(page);
    expect(invoke).toHaveBeenLastCalledWith(questionsChannels.list, {});
    await api.list({ cursor: "c", limit: 50, query: "memory" });
    expect(invoke).toHaveBeenLastCalledWith(questionsChannels.list, {
      cursor: "c",
      limit: 50,
      query: "memory"
    });
    await expect(api.list({ limit: 51 })).rejects.toThrow();
    await expect(
      createQuestionsApi(async () => ({ items: [{ id: "x" }] })).list()
    ).rejects.toThrow();
  });

  it("deletes, asks again and clears on their own channels", async () => {
    const id = randomUUID();
    const requestId = randomUUID();
    const invoke = vi.fn(async (channel: string) =>
      channel === questionsChannels.delete
        ? { deleted: true }
        : channel === questionsChannels.askAgain
          ? { requestId }
          : { deleted: 4 }
    );
    const api = createQuestionsApi(invoke);
    await expect(api.delete({ id })).resolves.toEqual({ deleted: true });
    await expect(api.askAgain({ id })).resolves.toEqual({ requestId });
    await expect(api.clear()).resolves.toEqual({ deleted: 4 });
    expect(invoke.mock.calls).toEqual([
      [questionsChannels.delete, { id }],
      [questionsChannels.askAgain, { id }],
      [questionsChannels.clear]
    ]);
    await expect(createQuestionsApi(async () => ({ deleted: -1 })).clear()).rejects.toThrow();
  });

  it("cancels on its own channel and answers null", async () => {
    const invoke = vi.fn(async () => null);
    const requestId = randomUUID();
    await expect(createQuestionsApi(invoke).cancel({ requestId })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith(questionsChannels.cancel, { requestId });
  });
});
