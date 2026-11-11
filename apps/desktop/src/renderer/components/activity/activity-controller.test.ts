import type { AppEventHandler, AppEventOf, AppEventType } from "../../../shared/app-events";
import {
  defaultKnowledgeControls,
  type ChangesList,
  type ChangesUndoResult,
  type KnowledgeControls
} from "@app/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ActivityController,
  undoFailureMessage,
  type ActivityApi,
  type ActivityControllerDeps
} from "./activity-controller";
import { undoKey } from "./activity-model";
import {
  budgetSnapshot,
  changeSet,
  fixtureNow,
  idleStatus,
  inboxChanged,
  inboxCounts,
  jobProgress,
  money80Status,
  pausedStatus,
  runningStatus,
  signInStatus
} from "./activity-fixtures";

type Handlers = Map<AppEventType, Set<(event: never) => void>>;

/** A deferred answer, so a test decides when and in which order the reads come back. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const list = (...items: ReturnType<typeof changeSet>[]): ChangesList => ({
  items,
  nextCursor: null
});

function setup(overrides: Partial<ActivityApi> = {}, deps: Partial<ActivityControllerDeps> = {}) {
  const handlers: Handlers = new Map();
  const api = {
    gardener: {
      status: vi.fn(async () => idleStatus)
    },
    knowledgeControls: {
      update: vi.fn(async () => ({ ...defaultKnowledgeControls, paused: false }))
    },
    budget: {
      snapshot: vi.fn(async () => budgetSnapshot()),
      continue: vi.fn(async () => budgetSnapshot({ continued: true }))
    },
    changes: {
      list: vi.fn(async () => list()),
      undo: vi.fn(
        async () => ({ status: "undone", kind: "topic", id: changeSet(1).id }) as ChangesUndoResult
      )
    },
    inbox: {
      counts: vi.fn(async () => inboxCounts(0))
    },
    onAppEvent: vi.fn(<T extends AppEventType>(type: T, handler: AppEventHandler<T>) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler as (event: never) => void);
      handlers.set(type, set);
      return () => set.delete(handler as (event: never) => void);
    }),
    ...overrides
  } as unknown as ActivityApi & {
    gardener: { status: ReturnType<typeof vi.fn> };
    knowledgeControls: { update: ReturnType<typeof vi.fn> };
    budget: { snapshot: ReturnType<typeof vi.fn>; continue: ReturnType<typeof vi.fn> };
    changes: {
      list: ReturnType<typeof vi.fn>;
      undo: ReturnType<typeof vi.fn>;
    };
    inbox: { counts: ReturnType<typeof vi.fn> };
  };
  const navigate = vi.fn();
  const controller = new ActivityController({
    api: () => api,
    navigate,
    now: () => fixtureNow,
    ...deps
  });
  const emit = <T extends AppEventType>(event: AppEventOf<T>) => {
    for (const handler of handlers.get(event.type) ?? []) handler(event as never);
  };
  const listening = (type: AppEventType) => handlers.get(type)?.size ?? 0;
  const listeners = () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
  const embedding = (state: "loading" | "ready" | "released" | "failed", modelId = "embedder") =>
    emit({ type: "model.loading", modelId, state });
  return { controller, api, navigate, emit, listening, listeners, embedding };
}

/** Lets the promises that are already settled run their continuations. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the pill's status", () => {
  it("is loading, then the status that was read", async () => {
    const { controller, api } = setup();
    expect(controller.getSnapshot().status).toEqual({ status: "loading" });
    controller.start();
    expect(api.gardener.status).toHaveBeenCalledOnce();
    await flush();
    expect(controller.getSnapshot().status).toEqual({ status: "ready", value: idleStatus });
  });

  it("stays visible and retryable when the read fails", async () => {
    const { controller, api } = setup();
    api.gardener.status.mockRejectedValueOnce(new Error("offline"));
    controller.start();
    await flush();
    expect(controller.getSnapshot().status).toEqual({ status: "error" });
    controller.retry();
    await flush();
    expect(controller.getSnapshot().status.status).toBe("ready");
    expect(api.gardener.status).toHaveBeenCalledTimes(2);
  });

  it("follows the pushed status and drops a read that came back older", async () => {
    const read = deferred<typeof idleStatus>();
    const { controller, api, emit } = setup();
    api.gardener.status.mockReturnValueOnce(read.promise);
    controller.start();
    emit({ type: "gardener.status", status: runningStatus });
    read.resolve(idleStatus);
    await flush();
    expect(controller.getSnapshot().status).toEqual({ status: "ready", value: runningStatus });
  });

  it("keeps a pushed status when the first read fails after it", async () => {
    const read = deferred<typeof idleStatus>();
    const { controller, api, emit } = setup();
    api.gardener.status.mockReturnValueOnce(read.promise);
    controller.start();
    emit({ type: "gardener.status", status: runningStatus });
    read.reject(new Error("busy"));
    await flush();
    expect(controller.getSnapshot().status).toEqual({ status: "ready", value: runningStatus });
  });

  it("notifies its listeners and stops notifying the one that unsubscribed", async () => {
    const { controller, emit } = setup();
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    controller.start();
    emit({ type: "gardener.status", status: runningStatus });
    const calls = listener.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    off();
    emit({ type: "gardener.status", status: pausedStatus });
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("starts once however often it is asked, and stop leaves nothing listening", () => {
    const { controller, api, listeners } = setup();
    controller.start();
    controller.start();
    // The Gardener status, the Inbox count and the embedder (`model.loading`).
    expect(api.onAppEvent).toHaveBeenCalledTimes(3);
    expect(listeners()).toBe(3);
    controller.stop();
    expect(listeners()).toBe(0);
  });
});

describe("what needs attention is announced", () => {
  it("announces when the Gardener starts to need the person, once per need", async () => {
    const { controller, emit } = setup();
    controller.start();
    emit({ type: "gardener.status", status: runningStatus });
    expect(controller.getSnapshot().announcement).toBeNull();
    emit({ type: "gardener.status", status: signInStatus });
    expect(controller.getSnapshot().announcement).toMatchObject({ kind: "attention" });
    const first = controller.getSnapshot().announcement!.id;
    emit({ type: "gardener.status", status: { ...signInStatus, eta: undefined } });
    expect(controller.getSnapshot().announcement!.id).toBe(first);
    emit({ type: "gardener.status", status: money80Status });
    expect(controller.getSnapshot().announcement!.id).toBeGreaterThan(first);
  });

  it("does not announce a hold that does not need the person", () => {
    const { controller, emit } = setup();
    controller.start();
    emit({ type: "gardener.status", status: pausedStatus });
    expect(controller.getSnapshot().announcement).toBeNull();
  });
});

describe("the embedder loading", () => {
  it("is on while a model loads and off when that model is done", () => {
    const { controller, embedding } = setup();
    controller.start();
    embedding("loading", "a");
    expect(controller.getSnapshot().embedderLoading).toBe(true);
    embedding("ready", "b");
    expect(controller.getSnapshot().embedderLoading).toBe(true);
    embedding("ready", "a");
    expect(controller.getSnapshot().embedderLoading).toBe(false);
    embedding("loading", "a");
    embedding("failed", "a");
    expect(controller.getSnapshot().embedderLoading).toBe(false);
  });

  it("is off when a model that was loading is released", () => {
    const { controller, embedding } = setup();
    controller.start();
    embedding("loading", "a");
    embedding("released", "a");
    expect(controller.getSnapshot().embedderLoading).toBe(false);
  });

  it("follows model.loading on the bus and on no channel of its own", () => {
    const { controller, listening } = setup();
    controller.start();
    expect(listening("model.loading")).toBe(1);
    controller.stop();
    expect(listening("model.loading")).toBe(0);
  });
});

describe("the Inbox count", () => {
  it("starts from the Inbox's own count of every kind, and is unknown until read", async () => {
    const { controller, api } = setup();
    api.inbox.counts.mockResolvedValue(inboxCounts(2));
    expect(controller.getSnapshot().inboxTotal).toBeNull();
    controller.start();
    await flush();
    expect(api.inbox.counts).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().inboxTotal).toBe(2);
  });

  it("follows the count the Inbox publishes, and stops reading it once one arrived", async () => {
    const { controller, api, emit } = setup();
    api.inbox.counts.mockResolvedValue(inboxCounts(2));
    controller.start();
    await flush();
    controller.setOpen(true);
    await flush();
    expect(api.inbox.counts).toHaveBeenCalledTimes(2);
    controller.setOpen(false);
    emit(inboxChanged(7));
    expect(controller.getSnapshot().inboxTotal).toBe(7);
    // A reviewed change-set moves the count through the Inbox's own event, never a read here.
    emit({ type: "changes.changed", kind: "topic", id: changeSet(2).id });
    controller.setOpen(true);
    await flush();
    expect(api.inbox.counts).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().inboxTotal).toBe(7);
  });

  it("drops a read that an event overtook", async () => {
    const { controller, api, emit } = setup();
    const read = deferred<ReturnType<typeof inboxCounts>>();
    api.inbox.counts.mockReturnValue(read.promise);
    controller.start();
    emit(inboxChanged(4));
    read.resolve(inboxCounts(9));
    await flush();
    expect(controller.getSnapshot().inboxTotal).toBe(4);
  });

  it("shows no count when it cannot be read", async () => {
    const { controller, api } = setup();
    api.inbox.counts.mockRejectedValue(new Error("down"));
    controller.start();
    await flush();
    expect(controller.getSnapshot().inboxTotal).toBeNull();
  });
});

describe("the drawer", () => {
  it("reads and listens only while it is open", async () => {
    const { controller, api, listening, listeners } = setup();
    controller.start();
    await flush();
    const pillListeners = listeners();
    expect(api.budget.snapshot).not.toHaveBeenCalled();
    expect(api.changes.list).not.toHaveBeenCalled();
    expect(listening("job.progress")).toBe(0);

    controller.setOpen(true);
    expect(api.budget.snapshot).toHaveBeenCalledOnce();
    expect(api.changes.list).toHaveBeenCalledWith({ status: "applied", limit: 8 });
    expect(listening("job.progress")).toBe(1);
    expect(listening("budget.changed")).toBe(1);
    for (const type of [
      "changes.changed",
      "tree.changed",
      "relation.created",
      "overview.changed"
    ] as const)
      expect(listening(type)).toBeGreaterThanOrEqual(1);

    controller.setOpen(false);
    expect(listeners()).toBe(pillListeners);
    expect(listening("job.progress")).toBe(0);
  });

  it("toggles", () => {
    const { controller } = setup();
    controller.toggle();
    expect(controller.getSnapshot().open).toBe(true);
    controller.toggle();
    expect(controller.getSnapshot().open).toBe(false);
  });

  it("goes through loading, empty and ready for the changes it lists", async () => {
    const read = deferred<ChangesList>();
    const { controller, api } = setup();
    api.changes.list.mockReturnValueOnce(read.promise);
    controller.setOpen(true);
    expect(controller.getSnapshot().done).toEqual({ status: "loading" });
    read.resolve(list());
    await flush();
    expect(controller.getSnapshot().done).toEqual({ status: "ready", value: [] });

    api.changes.list.mockResolvedValueOnce(list(changeSet(1), changeSet(2)));
    controller.setOpen(false);
    controller.setOpen(true);
    // Shown again with a good last read: refreshed in place, no loading state.
    expect(controller.getSnapshot().done.status).toBe("ready");
    await flush();
    const { done } = controller.getSnapshot();
    expect(done.status === "ready" ? done.value : []).toHaveLength(2);
  });

  it("keeps a failed list visible and retryable, and a shown list when a refresh fails", async () => {
    const { controller, api } = setup();
    api.changes.list.mockRejectedValueOnce(new Error("down"));
    controller.setOpen(true);
    await flush();
    expect(controller.getSnapshot().done).toEqual({ status: "error" });
    controller.retry();
    expect(controller.getSnapshot().done).toEqual({ status: "loading" });
    await flush();
    expect(controller.getSnapshot().done.status).toBe("ready");

    api.changes.list.mockRejectedValueOnce(new Error("down again"));
    controller.setOpen(false);
    controller.setOpen(true);
    await flush();
    expect(controller.getSnapshot().done.status).toBe("ready");
  });

  it("reads the spending meters, follows their push and retries a failure", async () => {
    const { controller, api, emit } = setup();
    api.budget.snapshot.mockRejectedValueOnce(new Error("down"));
    controller.setOpen(true);
    expect(controller.getSnapshot().budget).toEqual({ status: "loading" });
    await flush();
    expect(controller.getSnapshot().budget).toEqual({ status: "error" });
    controller.retry();
    await flush();
    expect(controller.getSnapshot().budget).toEqual({ status: "ready", value: budgetSnapshot() });
    const paused = budgetSnapshot({ state: "paused", spentUsd: 4.1 });
    emit({ type: "budget.changed", budget: paused });
    expect(controller.getSnapshot().budget).toEqual({ status: "ready", value: paused });
  });

  it("drops a read that was still in flight when the drawer closed", async () => {
    const read = deferred<ChangesList>();
    const { controller, api } = setup();
    api.changes.list.mockReturnValueOnce(read.promise);
    controller.setOpen(true);
    controller.setOpen(false);
    read.resolve(list(changeSet(1)));
    await flush();
    expect(controller.getSnapshot().done).toEqual({ status: "loading" });
  });

  it("counts running, waiting and held jobs from the push, only while open", () => {
    const { controller, emit } = setup();
    controller.setOpen(true);
    expect(controller.getSnapshot().jobs).toBeNull();
    emit(jobProgress({ running: 1, queued: 3, blocked: 1 }, { queued: 2 }));
    expect(controller.getSnapshot().jobs).toEqual({ running: 1, waiting: 5, onHold: 1 });
    controller.setOpen(false);
    expect(controller.getSnapshot().jobs).toBeNull();
  });

  it("does not draw the drawer again for counts that did not move", () => {
    const { controller, emit } = setup();
    controller.setOpen(true);
    emit(jobProgress({ running: 1, queued: 3 }));
    const shown = controller.getSnapshot();
    emit(jobProgress({ running: 1, queued: 3 }));
    expect(controller.getSnapshot()).toBe(shown);
    emit(jobProgress({ running: 0, queued: 3 }));
    expect(controller.getSnapshot()).not.toBe(shown);
  });

  it("reads the list of changes again once after a burst of changes", async () => {
    const { controller, api, emit } = setup();
    controller.setOpen(true);
    await flush();
    api.changes.list.mockClear();
    for (let i = 0; i < 5; i += 1)
      emit({
        type: "tree.changed",
        treeId: changeSet(1).id,
        generation: i,
        topicIds: null,
        changeSetId: null
      });
    emit({ type: "overview.changed", topicId: changeSet(3).id });
    expect(api.changes.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.changes.list).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.changes.list).toHaveBeenCalledOnce();
  });

  it("never reads again after it closed", async () => {
    const { controller, api, emit } = setup();
    controller.setOpen(true);
    await flush();
    api.changes.list.mockClear();
    emit({ type: "changes.changed", kind: "topic", id: changeSet(1).id });
    controller.setOpen(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.changes.list).not.toHaveBeenCalled();
  });

  it("tries the status again when it opens after a failed read", async () => {
    const { controller, api } = setup();
    api.gardener.status.mockRejectedValueOnce(new Error("offline"));
    controller.start();
    await flush();
    expect(controller.getSnapshot().status.status).toBe("error");
    controller.setOpen(true);
    await flush();
    expect(controller.getSnapshot().status.status).toBe("ready");
  });
});

describe("undo", () => {
  const ref = { kind: "topic", id: changeSet(1).id } as const;

  it("undoes a change, says so and reads the list again", async () => {
    const { controller, api } = setup();
    api.changes.list.mockResolvedValueOnce(list(changeSet(1)));
    controller.setOpen(true);
    await flush();
    api.changes.list.mockResolvedValueOnce(list());
    const undoing = controller.undo(ref);
    expect(controller.getSnapshot().undo[undoKey(ref)]).toEqual({ status: "pending" });
    await undoing;
    expect(api.changes.undo).toHaveBeenCalledWith(ref);
    expect(controller.getSnapshot().undo).toEqual({});
    expect(controller.getSnapshot().announcement).toMatchObject({
      kind: "message",
      key: "activity.done.undone"
    });
    await flush();
    expect(controller.getSnapshot().done).toEqual({ status: "ready", value: [] });
  });

  it("asks once while one undo is pending", async () => {
    const gate = deferred<ChangesUndoResult>();
    const { controller, api } = setup();
    api.changes.undo.mockReturnValueOnce(gate.promise);
    const first = controller.undo(ref);
    await controller.undo(ref);
    expect(api.changes.undo).toHaveBeenCalledOnce();
    gate.resolve({ status: "undone", kind: "topic", id: ref.id });
    await first;
  });

  it("names what blocks an undo in the person's words", async () => {
    const { controller, api } = setup();
    api.changes.undo.mockResolvedValueOnce({
      status: "blocked",
      blockers: [{ code: "later_change", changeSet: { kind: "topic", id: changeSet(2).id } }],
      more: 0
    });
    await controller.undo(ref);
    expect(controller.getSnapshot().undo[undoKey(ref)]).toEqual({
      status: "blocked",
      messageKey: "changes.blockers.later_change"
    });
    expect(controller.getSnapshot().announcement).toMatchObject({
      key: "changes.blockers.later_change"
    });
  });

  it("keeps a failure visible beside the change", async () => {
    const { controller, api } = setup();
    api.changes.undo.mockRejectedValueOnce(new Error("changes.errors.notFound"));
    await controller.undo(ref);
    expect(controller.getSnapshot().undo[undoKey(ref)]).toEqual({
      status: "failed",
      messageKey: "changes.errors.notFound"
    });
    api.changes.undo.mockRejectedValueOnce(new Error("socket closed"));
    await controller.undo(ref);
    expect(controller.getSnapshot().undo[undoKey(ref)]).toEqual({
      status: "failed",
      messageKey: "activity.done.undoFailed"
    });
  });

  it("maps a store's own report to its message", () => {
    expect(undoFailureMessage(new Error("topics.errors.stale"))).toBe("topics.errors.stale");
    expect(undoFailureMessage(new Error("changes.errors.unavailable"))).toBe(
      "changes.errors.unavailable"
    );
    expect(undoFailureMessage("anything else")).toBe("activity.done.undoFailed");
  });
});

describe("actions", () => {
  it("opens the place an action leads to and closes the drawer", async () => {
    const { controller, navigate } = setup();
    controller.setOpen(true);
    await controller.runAction("open_local_models");
    expect(navigate).toHaveBeenCalledWith({ view: "settings", scope: "models" });
    expect(controller.getSnapshot().open).toBe(false);
    await controller.runAction("sign_in");
    expect(navigate).toHaveBeenLastCalledWith({ view: "settings", scope: "intelligence" });
    // The Gardener's controls and its monthly limit are in Settings › Knowledge (T98).
    await controller.runAction("open_controls");
    expect(navigate).toHaveBeenLastCalledWith({ view: "settings", scope: "knowledge" });
    await controller.runAction("raise_budget");
    expect(navigate).toHaveBeenLastCalledWith({ view: "settings", scope: "knowledge" });
  });

  it("resumes the Gardener and lets the pushed status say the rest", async () => {
    const { controller, api } = setup();
    controller.start();
    await flush();
    api.gardener.status.mockClear();
    const running = controller.runAction("resume");
    expect(controller.getSnapshot().statusAction).toEqual({ action: "resume", status: "pending" });
    await running;
    // The pause is a Knowledge control: Resume changes that one control and nothing else.
    expect(api.knowledgeControls.update).toHaveBeenCalledExactlyOnceWith({ paused: false });
    expect(controller.getSnapshot().statusAction).toBeNull();
    expect(controller.getSnapshot().announcement).toMatchObject({
      key: "activity.actions.resumed"
    });
    // A read here would answer from before the change and undo what the push is about to say.
    expect(api.gardener.status).not.toHaveBeenCalled();
  });

  it("continues past the pause near the limit and shows the new meters", async () => {
    const { controller, api } = setup();
    controller.setOpen(true);
    await flush();
    await controller.runAction("continue_budget");
    expect(api.budget.continue).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().budget).toEqual({
      status: "ready",
      value: budgetSnapshot({ continued: true })
    });
    expect(controller.getSnapshot().announcement).toMatchObject({
      key: "activity.actions.continued"
    });
  });

  it("keeps a failed action visible, and lets it be tried again", async () => {
    const { controller, api } = setup();
    api.knowledgeControls.update.mockRejectedValueOnce(
      new Error("errors.common.missingConfiguration")
    );
    await controller.runAction("resume");
    expect(controller.getSnapshot().statusAction).toEqual({ action: "resume", status: "failed" });
    expect(controller.getSnapshot().announcement).toMatchObject({ key: "activity.actions.failed" });
    await controller.runAction("resume");
    expect(controller.getSnapshot().statusAction).toBeNull();
  });

  it("runs one action at a time", async () => {
    const gate = deferred<KnowledgeControls>();
    const { controller, api } = setup();
    api.knowledgeControls.update.mockReturnValueOnce(gate.promise);
    const first = controller.runAction("resume");
    await controller.runAction("continue_budget");
    expect(api.budget.continue).not.toHaveBeenCalled();
    gate.resolve(defaultKnowledgeControls);
    await first;
  });
});
