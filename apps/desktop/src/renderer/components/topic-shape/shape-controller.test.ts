import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopicChangeSet, TopicShape, TopicUndoResult } from "@app/domain";
import { createTranslator } from "@app/i18n";

import type { AppEventOf } from "../../../shared/app-events";
import { createFakeAppEvents } from "../../lib/fake-app-events";
import {
  sameShapeContent,
  ShapeController,
  topicErrorMessage,
  type ShapeApi
} from "./shape-controller";
import { sample, sampleChangeSet, sampleNodes, sampleShape, shapeId } from "./shape-fixtures";

const t = createTranslator("en");
const proposalId = shapeId(sample.pendingChange);
const changeId = shapeId(sample.todayChange);

interface Harness {
  controller: ShapeController;
  api: {
    shape: ReturnType<typeof vi.fn<ShapeApi["shape"]>>;
    changeSet: ReturnType<typeof vi.fn<ShapeApi["changeSet"]>>;
    undo: ReturnType<typeof vi.fn<ShapeApi["undo"]>>;
    review: ReturnType<typeof vi.fn<ShapeApi["review"]>>;
  };
  /** `tree.changed` on the bus, a fake of `window.app.onAppEvent`. */
  events: ReturnType<typeof createFakeAppEvents>;
  emit(event: Partial<AppEventOf<"tree.changed">>): void;
  listening(): boolean;
}

function harness(
  answer: (rootId: string | null) => Promise<TopicShape | null> = () =>
    Promise.resolve(sampleShape())
): Harness {
  const events = createFakeAppEvents();
  const api = {
    shape: vi.fn<ShapeApi["shape"]>((input) => answer(input?.rootId ?? null)),
    changeSet: vi.fn<ShapeApi["changeSet"]>(() => Promise.resolve(sampleChangeSet())),
    undo: vi.fn<ShapeApi["undo"]>(() =>
      Promise.resolve({ status: "undone", changeSetId: shapeId(950), generation: 13 })
    ),
    review: vi.fn<ShapeApi["review"]>(() => Promise.resolve({ status: "applied" }))
  };
  const controller = new ShapeController({
    api: () => api,
    onTreeChanged: (listener) => events.api.onAppEvent("tree.changed", listener),
    now: () => Date.UTC(2026, 9, 15, 18, 0, 0),
    refreshDelayMs: 1_000
  });
  return {
    controller,
    api,
    events,
    emit: (event) =>
      events.emit({
        type: "tree.changed",
        treeId: shapeId(999),
        generation: 13,
        topicIds: null,
        changeSetId: null,
        ...event
      }),
    listening: () => events.listening("tree.changed") > 0
  };
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("showing the shape", () => {
  it("reads the whole tree once and asks for nothing else", async () => {
    const h = harness();
    h.controller.show(true, t);
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    expect(h.controller.getSnapshot().load.status).toBe("ready");
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    expect(h.api.shape).toHaveBeenCalledWith({ rootId: null, depth: 4, nodeLimit: 2_000 });
    expect(h.api.changeSet).not.toHaveBeenCalled();
    expect(h.api.undo).not.toHaveBeenCalled();
    expect(h.api.review).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().zoom).toEqual([{ id: null, title: null, depth: 0 }]);
    // Showing it again with the same state reads nothing more.
    h.controller.show(true, createTranslator("pt-BR"));
    await settle();
    expect(h.api.shape).toHaveBeenCalledTimes(1);
  });

  it("loads nothing and listens to nothing while hidden", async () => {
    const h = harness();
    h.controller.show(false, t);
    await settle();
    expect(h.api.shape).not.toHaveBeenCalled();
    expect(h.events.listening("tree.changed")).toBe(0);
    h.controller.show(true, t);
    await settle();
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(true);
    h.controller.show(false, t);
    expect(h.listening()).toBe(false);
  });

  it("refreshes in place when shown again after a good load", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    const before = h.controller.getSnapshot();
    h.controller.show(false, t);
    h.controller.show(true, t);
    // The shape on screen is kept while the new read is in flight.
    expect(h.controller.getSnapshot().load.status).toBe("ready");
    await settle();
    expect(h.api.shape).toHaveBeenCalledTimes(2);
    // The same content is not shown again.
    expect(h.controller.getSnapshot().load).toBe(before.load);
  });

  it("keeps a failed load visible and retryable when shown again", async () => {
    let fail = true;
    const h = harness(() =>
      fail ? Promise.reject(new Error("down")) : Promise.resolve(sampleShape())
    );
    h.controller.show(true, t);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "error" });
    h.controller.show(false, t);
    h.controller.show(true, t);
    await settle();
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().load).toEqual({ status: "error" });
    fail = false;
    h.controller.retry();
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    expect(h.controller.getSnapshot().load.status).toBe("ready");
  });

  it("shows a tree that is gone as missing", async () => {
    const h = harness(() => Promise.resolve(null));
    h.controller.show(true, t);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "missing" });
  });

  it("does not retry while hidden", async () => {
    const h = harness();
    h.controller.retry();
    await settle();
    expect(h.api.shape).not.toHaveBeenCalled();
  });
});

describe("zooming into a branch", () => {
  it("reads the branch alone, selects it and remembers the way back", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    h.controller.zoomInto(shapeId(sample.memory), "Memory and learning", 1);
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    expect(h.controller.getSnapshot().selectedKey).toBe(`topic:${shapeId(sample.memory)}`);
    await settle();
    expect(h.api.shape).toHaveBeenLastCalledWith({
      rootId: shapeId(sample.memory),
      depth: 4,
      nodeLimit: 2_000
    });
    h.controller.zoomInto(shapeId(sample.forgetting), "Forgetting curve", 1);
    await settle();
    // Levels count from the whole tree: the branch starts at level 2 and the next one 1 below it.
    expect(h.controller.getSnapshot().zoom).toEqual([
      { id: null, title: null, depth: 0 },
      { id: shapeId(sample.memory), title: "Memory and learning", depth: 1 },
      { id: shapeId(sample.forgetting), title: "Forgetting curve", depth: 2 }
    ]);
    h.controller.zoomTo(0);
    expect(h.controller.getSnapshot().zoom).toHaveLength(1);
    await settle();
    expect(h.api.shape).toHaveBeenLastCalledWith({ rootId: null, depth: 4, nodeLimit: 2_000 });
    expect(h.controller.getSnapshot().selectedKey).toBeNull();
  });

  it("ignores a zoom into where it already is, or back to where it is", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    h.controller.zoomTo(0);
    h.controller.zoomInto(shapeId(sample.memory), "Memory", 1);
    await settle();
    h.controller.zoomInto(shapeId(sample.memory), "Memory", 0);
    h.controller.zoomTo(1);
    h.controller.zoomTo(7);
    expect(h.controller.getSnapshot().zoom).toHaveLength(2);
    expect(h.api.shape).toHaveBeenCalledTimes(2);
  });

  it("drops the answer of a branch that was left", async () => {
    const slow = new Map<string | null, (shape: TopicShape | null) => void>();
    const h = harness((rootId) => new Promise((resolve) => slow.set(rootId, resolve)));
    h.controller.show(true, t);
    h.controller.zoomInto(shapeId(sample.memory), "Memory", 1);
    h.controller.zoomTo(0);
    // The branch's answer arrives after the person went back: it must not replace the tree.
    slow.get(shapeId(sample.memory))?.(sampleShape({ generation: 99 }));
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    slow.get(null)?.(sampleShape());
    await settle();
    const load = h.controller.getSnapshot().load;
    expect(load.status === "ready" && load.shape.generation).toBe(12);
  });

  it("shows a branch that vanished as missing, and the way back works", async () => {
    const h = harness((rootId) => Promise.resolve(rootId === null ? sampleShape() : null));
    h.controller.show(true, t);
    await settle();
    h.controller.zoomInto(shapeId(sample.memory), "Memory", 1);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "missing" });
    h.controller.zoomTo(0);
    await settle();
    expect(h.controller.getSnapshot().load.status).toBe("ready");
  });

  it("selects a block", () => {
    const h = harness();
    h.controller.select("unsorted");
    expect(h.controller.getSnapshot().selectedKey).toBe("unsorted");
  });
});

describe("pushed changes", () => {
  it("reads the shape again once after a quiet period, and only for a newer generation", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    h.emit({ generation: 12 });
    h.emit({ generation: 11 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    h.emit({ generation: 13 });
    h.emit({ generation: 14 });
    h.emit({ generation: 15 });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.api.shape).toHaveBeenCalledTimes(2);
  });

  it("shows the new shape when it differs and nothing new when it does not", async () => {
    let shape = sampleShape();
    const h = harness(() => Promise.resolve(shape));
    h.controller.show(true, t);
    await settle();
    const first = h.controller.getSnapshot().load;
    shape = sampleShape({ generation: 13 });
    h.emit({ generation: 13 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.getSnapshot().load).toBe(first);
    shape = sampleShape({ generation: 14, truncated: true });
    h.emit({ generation: 14 });
    await vi.advanceTimersByTimeAsync(1_000);
    const next = h.controller.getSnapshot().load;
    expect(next).not.toBe(first);
    expect(next.status === "ready" && next.shape.truncated).toBe(true);
  });

  it("keeps the shape on screen when a refresh fails", async () => {
    let fail = false;
    const h = harness(() =>
      fail ? Promise.reject(new Error("down")) : Promise.resolve(sampleShape())
    );
    h.controller.show(true, t);
    await settle();
    fail = true;
    h.emit({ generation: 13 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.getSnapshot().load.status).toBe("ready");
  });

  it("stops listening when hidden or disposed, and ignores events before the first read", async () => {
    const h = harness();
    h.emit({ generation: 20 });
    h.controller.show(true, t);
    h.emit({ generation: 20 });
    await settle();
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    h.emit({ generation: 30 });
    h.controller.show(false, t);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.api.shape).toHaveBeenCalledTimes(1);
    h.controller.show(true, t);
    expect(h.listening()).toBe(true);
    h.controller.dispose();
    expect(h.listening()).toBe(false);
  });
});

describe("applying and dismissing a proposal", () => {
  it("sends the decision, announces it and reads the shape again", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    const pending = h.controller.review(proposalId, "apply");
    expect(h.controller.getSnapshot().actions[proposalId]).toEqual({
      kind: "apply",
      status: "pending"
    });
    await pending;
    await settle();
    expect(h.api.review).toHaveBeenCalledWith({ changeSetId: proposalId, decision: "apply" });
    expect(h.controller.getSnapshot().actions[proposalId]).toBeUndefined();
    expect(h.controller.getSnapshot().announcement).toBe("Change applied.");
    expect(h.api.shape).toHaveBeenCalledTimes(2);
    // The shape stays on screen while it is read again.
    expect(h.controller.getSnapshot().load.status).toBe("ready");

    await h.controller.review(proposalId, "dismiss");
    expect(h.api.review).toHaveBeenLastCalledWith({ changeSetId: proposalId, decision: "dismiss" });
    expect(h.controller.getSnapshot().announcement).toBe("Proposal dismissed.");
  });

  it("asks once while the answer is pending", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    const first = h.controller.review(proposalId, "apply");
    await h.controller.review(proposalId, "dismiss");
    await first;
    expect(h.api.review).toHaveBeenCalledTimes(1);
  });

  it("keeps a refusal beside the proposal with the handler's own message", async () => {
    const h = harness();
    h.api.review.mockRejectedValueOnce(
      new Error("Error invoking remote method 'topics:review': Error: topics.errors.unavailable")
    );
    h.controller.show(true, t);
    await settle();
    await h.controller.review(proposalId, "apply");
    expect(h.controller.getSnapshot().actions[proposalId]).toEqual({
      kind: "apply",
      status: "failed",
      messageKey: "topics.errors.unavailable"
    });
    expect(h.controller.getSnapshot().announcement).toBe("This action is not available yet.");
    // Another try is possible, and a different failure reads generally.
    h.api.review.mockRejectedValueOnce(new Error("boom"));
    await h.controller.review(proposalId, "dismiss");
    expect(h.controller.getSnapshot().actions[proposalId]).toMatchObject({
      status: "failed",
      messageKey: "topics.shape.warnings.failed"
    });
  });
});

describe("undoing a change of today", () => {
  it("undoes it, announces it and reads the shape again", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    await h.controller.undo(changeId);
    await settle();
    expect(h.api.undo).toHaveBeenCalledWith({ changeSetId: changeId });
    expect(h.controller.getSnapshot().actions[changeId]).toBeUndefined();
    expect(h.controller.getSnapshot().announcement).toBe("Change undone.");
    expect(h.api.shape).toHaveBeenCalledTimes(2);
  });

  it("says why a change cannot be undone", async () => {
    const h = harness();
    const blocked: TopicUndoResult = {
      status: "blocked",
      blockers: [{ kind: "changeSet", changeSetId: shapeId(951), objects: [] }]
    };
    h.api.undo.mockResolvedValueOnce(blocked);
    h.controller.show(true, t);
    await settle();
    await h.controller.undo(changeId);
    expect(h.controller.getSnapshot().actions[changeId]).toEqual({
      kind: "undo",
      status: "blocked",
      messageKey: "topics.shape.changed.blocked"
    });
  });

  it("keeps a failure visible", async () => {
    const h = harness();
    h.api.undo.mockRejectedValueOnce(new Error("boom"));
    h.controller.show(true, t);
    await settle();
    await h.controller.undo(changeId);
    expect(h.controller.getSnapshot().actions[changeId]).toEqual({
      kind: "undo",
      status: "failed",
      messageKey: "topics.shape.changed.failed"
    });
    expect(h.controller.getSnapshot().announcement).toBe(
      "The change could not be undone. Try again."
    );
  });
});

describe("before and after", () => {
  it("reads a change-set when it is opened and forgets it when it is closed", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    h.controller.toggleDetails(proposalId);
    expect(h.controller.getSnapshot().details[proposalId]).toEqual({ status: "loading" });
    await settle();
    expect(h.api.changeSet).toHaveBeenCalledWith({ id: proposalId });
    expect(h.controller.getSnapshot().details[proposalId]?.status).toBe("ready");
    h.controller.toggleDetails(proposalId);
    expect(h.controller.getSnapshot().details[proposalId]).toBeUndefined();
  });

  it("drops an answer that arrives after the disclosure was closed", async () => {
    let resolve: (value: TopicChangeSet | null) => void = () => undefined;
    const h = harness();
    h.api.changeSet.mockReturnValueOnce(new Promise((next) => (resolve = next)));
    h.controller.show(true, t);
    await settle();
    h.controller.toggleDetails(proposalId);
    h.controller.toggleDetails(proposalId);
    resolve(sampleChangeSet());
    await settle();
    expect(h.controller.getSnapshot().details[proposalId]).toBeUndefined();
  });

  it("shows a missing or failed change-set, and a failure can be retried", async () => {
    const h = harness();
    h.api.changeSet.mockResolvedValueOnce(null);
    h.controller.show(true, t);
    await settle();
    h.controller.toggleDetails(proposalId);
    await settle();
    expect(h.controller.getSnapshot().details[proposalId]).toEqual({ status: "missing" });
    h.controller.toggleDetails(proposalId);
    h.api.changeSet.mockRejectedValueOnce(new Error("down"));
    h.controller.toggleDetails(proposalId);
    await settle();
    expect(h.controller.getSnapshot().details[proposalId]).toEqual({ status: "error" });
    h.controller.retryDetails(proposalId);
    await settle();
    expect(h.controller.getSnapshot().details[proposalId]?.status).toBe("ready");
  });

  it("forgets the opened change-sets when the branch changes", async () => {
    const h = harness();
    h.controller.show(true, t);
    await settle();
    h.controller.toggleDetails(proposalId);
    await settle();
    h.controller.zoomInto(shapeId(sample.memory), "Memory", 1);
    expect(h.controller.getSnapshot().details).toEqual({});
  });
});

describe("helpers", () => {
  it("finds the handler's message in whatever the bridge wraps it in", () => {
    for (const key of [
      "topics.errors.stale",
      "topics.errors.notFound",
      "topics.errors.protected",
      "topics.errors.unavailable"
    ] as const) {
      expect(topicErrorMessage(new Error(`Error invoking remote method 'x': Error: ${key}`))).toBe(
        key
      );
    }
    expect(topicErrorMessage(new Error("boom"))).toBeNull();
    expect(topicErrorMessage("nothing")).toBeNull();
  });

  it("compares shapes by content, not by generation", () => {
    expect(sameShapeContent(sampleShape(), sampleShape({ generation: 99 }))).toBe(true);
    expect(sameShapeContent(sampleShape(), sampleShape({ nodes: sampleNodes().slice(1) }))).toBe(
      false
    );
  });
});
