import { afterEach, describe, expect, it, vi } from "vitest";

import { askFixture, deltaParagraphs, questionFixture } from "./ask-fixtures";
import { forgetAsks, rememberRequest } from "./ask-session";
import { shownAnswer } from "./answer-model";
import { QuestionController } from "./question-controller";
import type { QuestionView, QuestionsApi } from "../../../../shared/ipc-questions";

const id = askFixture.questionId;
const request = askFixture.requestId;

afterEach(() => forgetAsks());

type Api = Pick<QuestionsApi, "get" | "cancel" | "askAgain" | "ask">;

/** A `questions` API whose `get` answers from a queue the test controls. */
function makeApi(first: QuestionView | null = questionFixture("running")) {
  const reads: Array<{
    resolve: (value: QuestionView | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  const api = {
    get: vi.fn(
      () =>
        new Promise<QuestionView | null>((resolve, reject) => {
          reads.push({ resolve, reject });
        })
    ),
    cancel: vi.fn(() => Promise.resolve(null)),
    askAgain: vi.fn(() => Promise.resolve({ requestId: request })),
    ask: vi.fn()
  } satisfies Record<keyof Api, unknown>;
  const answer = (value: QuestionView | null = first) => reads.shift()?.resolve(value);
  const fail = () => reads.shift()?.reject(new Error("boom"));
  return { api: api as unknown as Api, spies: api, answer, fail, pending: () => reads.length };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the Question controller", () => {
  it("reads the Question once shown, and not while hidden", async () => {
    const { api, answer, spies } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, false);
    expect(spies.get).not.toHaveBeenCalled();
    controller.show(id, true);
    expect(controller.getSnapshot().load).toEqual({ status: "loading" });
    answer();
    await flush();
    expect(controller.getSnapshot().load.status).toBe("ready");
  });

  it("says a Question that is gone is missing, and a failed read can be retried", async () => {
    const gone = makeApi();
    const controller = new QuestionController({ api: () => gone.api });
    controller.show(id, true);
    gone.answer(null);
    await flush();
    expect(controller.getSnapshot().load.status).toBe("missing");

    const { api, answer, fail } = makeApi();
    const second = new QuestionController({ api: () => api });
    second.show(id, true);
    fail();
    await flush();
    expect(second.getSnapshot().load.status).toBe("error");
    second.retry();
    expect(second.getSnapshot().load.status).toBe("loading");
    answer();
    await flush();
    expect(second.getSnapshot().load.status).toBe("ready");
  });

  it("keeps the page when a read the bus asked for fails", async () => {
    const { api, answer, fail } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.reread();
    fail();
    await flush();
    expect(controller.getSnapshot().load.status).toBe("ready");
  });

  it("follows the deltas and the stages of its own Question only", async () => {
    const { api, answer } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    const other = "00000000-0000-4000-8000-0000000000aa";
    controller.applyDelta({
      type: "consultation.delta",
      requestId: request,
      questionId: other,
      paragraphs: deltaParagraphs(1),
      restart: false
    });
    expect(controller.getSnapshot().stream.paragraphs).toHaveLength(0);
    controller.applyStatus({
      type: "consultation.status",
      requestId: request,
      questionId: id,
      stage: "answering"
    });
    controller.applyDelta({
      type: "consultation.delta",
      requestId: request,
      questionId: id,
      paragraphs: deltaParagraphs(2),
      restart: false
    });
    // The same delta twice is one state.
    controller.applyDelta({
      type: "consultation.delta",
      requestId: request,
      questionId: id,
      paragraphs: deltaParagraphs(2),
      restart: false
    });
    const { load, stream } = controller.getSnapshot();
    expect(stream).toMatchObject({ requestId: request, stage: "answering" });
    expect(stream.paragraphs).toHaveLength(2);
    if (load.status !== "ready") throw new Error("ready");
    expect(shownAnswer(load.question, stream).live).toBe(true);
  });

  it("reads the stored answer when the Ask ends, keeping what is shown until it arrives", async () => {
    const { api, answer, pending } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.applyDelta({
      type: "consultation.delta",
      requestId: request,
      questionId: id,
      paragraphs: deltaParagraphs(3),
      restart: false
    });
    controller.applyStatus({
      type: "consultation.status",
      requestId: request,
      questionId: id,
      stage: "done"
    });
    expect(pending()).toBe(1);
    // Until the stored answer is read, the page still shows the stream's three paragraphs.
    const before = controller.getSnapshot();
    if (before.load.status !== "ready") throw new Error("ready");
    expect(shownAnswer(before.load.question, before.stream).paragraphs).toHaveLength(3);
    answer(questionFixture("done"));
    await flush();
    const after = controller.getSnapshot();
    if (after.load.status !== "ready") throw new Error("ready");
    expect(shownAnswer(after.load.question, after.stream)).toMatchObject({
      stage: "done",
      version: 1
    });
  });

  it("asks for one more read, not one per change, while a read is under way", async () => {
    const { api, answer, spies } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.reread();
    controller.reread();
    controller.reread();
    expect(spies.get).toHaveBeenCalledTimes(2);
    answer();
    await flush();
    expect(spies.get).toHaveBeenCalledTimes(3);
  });

  it("reads again, quietly, when a hidden panel is shown after a change", async () => {
    const { api, answer, spies } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.show(id, false);
    controller.reread();
    expect(spies.get).toHaveBeenCalledTimes(1);
    controller.show(id, true);
    expect(spies.get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().load.status).toBe("ready");
  });

  it("stops the request it knows, and says so once when the stop fails", async () => {
    const { api, answer, spies } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.stop();
    expect(spies.cancel).not.toHaveBeenCalled();
    controller.applyStatus({
      type: "consultation.status",
      requestId: request,
      questionId: id,
      stage: "answering"
    });
    controller.stop();
    expect(spies.cancel).toHaveBeenCalledWith({ requestId: request });
    expect(controller.getSnapshot().action).toBe("stopping");
    await flush();
    expect(controller.getSnapshot().action).toBe("idle");

    spies.cancel.mockRejectedValueOnce(new Error("no"));
    controller.stop();
    await flush();
    expect(controller.getSnapshot().action).toBe("failed");
  });

  it("knows the request the launcher made before the panel opened", async () => {
    rememberRequest(id, request);
    const { api, answer, spies } = makeApi();
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.stop();
    expect(spies.cancel).toHaveBeenCalledWith({ requestId: request });
  });

  it("writes a new version of the same Question on Ask again, and follows its request", async () => {
    const { api, answer, spies } = makeApi(questionFixture("done"));
    const controller = new QuestionController({ api: () => api });
    controller.show(id, true);
    answer();
    await flush();
    controller.askAgain();
    expect(controller.getSnapshot().action).toBe("asking");
    await flush();
    expect(spies.askAgain).toHaveBeenCalledWith({ id });
    expect(controller.getSnapshot().stream).toMatchObject({
      requestId: request,
      stage: "retrieving"
    });
    expect(controller.getSnapshot().action).toBe("idle");

    spies.askAgain.mockRejectedValueOnce(new Error("questions.errors.running"));
    controller.askAgain();
    await flush();
    expect(controller.getSnapshot().action).toBe("failed");
  });
});
