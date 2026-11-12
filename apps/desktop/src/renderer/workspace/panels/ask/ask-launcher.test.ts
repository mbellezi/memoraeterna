import { afterEach, describe, expect, it, vi } from "vitest";

import { askFixture, recentQuestions } from "./ask-fixtures";
import { AskLauncherController } from "./ask-launcher";
import { askedQuestion, forgetAsks, requestOf } from "./ask-session";
import {
  askTextState,
  objectOfScope,
  readAskAddress,
  scopeOfView,
  type ScopeRead
} from "./ask-scope";

afterEach(() => forgetAsks());

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const library = { kind: "library" } as const;

function make(overrides: Partial<Record<"ask" | "list", ReturnType<typeof vi.fn>>> = {}) {
  const ask =
    overrides.ask ??
    vi.fn(() =>
      Promise.resolve({ questionId: askFixture.questionId, requestId: askFixture.requestId })
    );
  const list = overrides.list ?? vi.fn(() => Promise.resolve({ items: recentQuestions }));
  const onAsked = vi.fn();
  const controller = new AskLauncherController({
    api: () => ({ ask, list }) as never,
    onAsked
  });
  return { controller, ask, list, onAsked };
}

describe("the Ask launcher", () => {
  it("asks once, answers with the Question, and remembers the request that writes it", async () => {
    const { controller, ask, onAsked } = make();
    controller.ask({ text: "  Why?  ", scope: library, key: "memora://ask?q=Why%3F" });
    // A second send while one is in flight is refused: a double Enter asks once.
    controller.ask({ text: "Why?", scope: library, key: "memora://ask?q=Why%3F" });
    expect(controller.getSnapshot().send.status).toBe("asking");
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({ text: "Why?", scope: library });
    expect(onAsked).toHaveBeenCalledWith(askFixture.questionId);
    expect(requestOf(askFixture.questionId)).toBe(askFixture.requestId);
    expect(controller.getSnapshot().send.status).toBe("idle");
  });

  it("opens the Question an address already made instead of asking again (Back to it)", async () => {
    const { controller, ask, onAsked } = make();
    const key = "memora://ask?q=Why%3F";
    controller.ask({ text: "Why?", scope: library, key });
    await flush();
    expect(askedQuestion(key)).toBe(askFixture.questionId);
    controller.ask({ text: "Why?", scope: library, key });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onAsked).toHaveBeenCalledTimes(2);
  });

  it("says a failed Ask once and can send again; editing clears it", async () => {
    const ask = vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValue({
      questionId: askFixture.questionId,
      requestId: askFixture.requestId
    });
    const { controller, onAsked } = make({ ask });
    controller.ask({ text: "Why?", scope: library });
    await flush();
    expect(controller.getSnapshot().send.status).toBe("error");
    expect(onAsked).not.toHaveBeenCalled();
    controller.clearError();
    expect(controller.getSnapshot().send.status).toBe("idle");
    controller.ask({ text: "Why?", scope: library });
    await flush();
    expect(onAsked).toHaveBeenCalledTimes(1);
  });

  it("lists the recent questions once, and a failed list leaves the field usable", async () => {
    const { controller, list } = make();
    expect(controller.getSnapshot().recents.status).toBe("loading");
    controller.loadRecents();
    controller.loadRecents();
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().recents).toMatchObject({ status: "ready" });

    const failing = make({ list: vi.fn(() => Promise.reject(new Error("no"))) });
    failing.controller.loadRecents();
    await flush();
    expect(failing.controller.getSnapshot().recents).toEqual({ status: "ready", items: [] });
  });
});

describe("the scope of an Ask", () => {
  const topic = "00000000-0000-4000-8000-000000000004";
  const source = "00000000-0000-4000-8000-000000000011";
  const note = "00000000-0000-4000-8000-000000000021";

  it("maps a topic and a source to a stored scope, and refuses any other object", () => {
    expect(scopeOfView(undefined)).toEqual({ status: "ok", scope: library, object: null });
    expect(scopeOfView({ kind: "topic", id: topic })).toMatchObject({
      status: "ok",
      scope: { kind: "topic", topicId: topic }
    });
    expect(scopeOfView({ kind: "source", id: source })).toMatchObject({
      status: "ok",
      scope: { kind: "sources", sourceIds: [source] }
    });
    for (const kind of ["note", "entity", "question"] as const)
      expect(scopeOfView({ kind, id: note })).toEqual({ status: "unsupported" });
  });

  it("reads an ask address, and names the object a stored scope is about", () => {
    const read = readAskAddress(
      `memora://ask?q=Why%3F&scope=${encodeURIComponent(`memora://topic/${topic}`)}`
    );
    expect(read?.text).toBe("Why?");
    expect((read?.scope as Extract<ScopeRead, { status: "ok" }>).object).toBe(
      `memora://topic/${topic}`
    );
    expect(readAskAddress("memora://library")).toBeNull();
    expect(objectOfScope({ kind: "topic", topicId: topic })).toBe(`memora://topic/${topic}`);
    expect(objectOfScope({ kind: "sources", sourceIds: [source] })).toBe(
      `memora://source/${source}`
    );
    expect(objectOfScope({ kind: "sources", sourceIds: [source, topic] })).toBeNull();
    expect(objectOfScope(library)).toBeNull();
  });

  it("holds the words to what questions.ask takes: 3 to 1000 characters once trimmed", () => {
    expect(askTextState("  ab  ")).toBe("short");
    expect(askTextState("abc")).toBe("ok");
    expect(askTextState("a".repeat(1000))).toBe("ok");
    expect(askTextState("a".repeat(1001))).toBe("long");
  });
});
