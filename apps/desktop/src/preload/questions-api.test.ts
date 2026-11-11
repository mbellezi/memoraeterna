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

  it("cancels on its own channel and answers null", async () => {
    const invoke = vi.fn(async () => null);
    const requestId = randomUUID();
    await expect(createQuestionsApi(invoke).cancel({ requestId })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith(questionsChannels.cancel, { requestId });
  });
});
