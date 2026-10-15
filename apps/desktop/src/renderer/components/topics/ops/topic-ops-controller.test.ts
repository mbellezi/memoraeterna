import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopicMutation, TopicMutationResult, TopicUndoResult } from "@app/domain";

import { noticeVisibleMs } from "./topic-ops";
import { TopicOpsController, type OpsApi } from "./topic-ops-controller";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const topic = (overrides: Partial<{ title: string | null; updatedAt: string }> = {}) => ({
  id: id(1),
  title: "Memory" as string | null,
  updatedAt: "2026-10-15T10:00:00.000Z",
  ...overrides
});

function fakeApi(
  overrides: {
    mutate?: (input: TopicMutation) => Promise<TopicMutationResult>;
    undo?: (input: { changeSetId: string }) => Promise<TopicUndoResult>;
  } = {}
) {
  const calls: TopicMutation[] = [];
  const undone: string[] = [];
  const api: OpsApi = {
    mutate: async (input) => {
      calls.push(input);
      return overrides.mutate
        ? overrides.mutate(input)
        : { changeSetId: id(100 + calls.length), generation: calls.length };
    },
    undo: async (input) => {
      undone.push(input.changeSetId);
      return overrides.undo
        ? overrides.undo(input)
        : { status: "undone", changeSetId: id(900), generation: 9 };
    }
  };
  return { api, calls, undone };
}

const ipcError = (key: string) =>
  new Error(`Error invoking remote method 'app:topics:mutate': Error: ${key}`);

describe("the human operations of a view", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renames a topic from the stamp it was shown with, and offers Undo", async () => {
    const { api, calls } = fakeApi();
    const ops = new TopicOpsController(() => api);
    await expect(ops.rename(topic(), "  Memory   and learning ")).resolves.toBe(true);
    expect(calls).toEqual([
      {
        op: "rename",
        id: id(1),
        title: "Memory and learning",
        expectedUpdatedAt: "2026-10-15T10:00:00.000Z"
      }
    ]);
    expect(ops.getSnapshot()).toMatchObject({
      busy: false,
      error: null,
      notice: {
        key: "topics.ops.toast.renamed",
        title: "Memory and learning",
        changeSetId: id(101),
        state: "idle"
      }
    });
  });

  it("checks a name before calling and says nothing changed for the same name", async () => {
    const { api, calls } = fakeApi();
    const ops = new TopicOpsController(() => api);
    await expect(ops.rename(topic(), "   ")).resolves.toBe(false);
    expect(ops.getSnapshot().error).toBe("topics.ops.rename.empty");
    await expect(ops.rename(topic(), "x".repeat(121))).resolves.toBe(false);
    expect(ops.getSnapshot().error).toBe("topics.ops.rename.tooLong");
    await expect(ops.create({ id: id(2), title: null }, "")).resolves.toBe(false);
    // The same name is already so: no call, no notice, and the earlier refusal is gone.
    await expect(ops.rename(topic(), "Memory")).resolves.toBe(true);
    expect(calls).toEqual([]);
    expect(ops.getSnapshot()).toMatchObject({ error: null, notice: null });
  });

  it("reports a refusal by its message and keeps no notice", async () => {
    const refusals: Array<[string, string]> = [
      ["topics.errors.stale", "topics.errors.stale"],
      ["topics.errors.duplicateTitle", "topics.errors.duplicateTitle"],
      ["topics.errors.cycle", "topics.errors.cycle"],
      ["topics.errors.depthCap", "topics.errors.depthCap"],
      ["errors.viewHistory.pinLimit", "viewHistory.pinLimit"]
    ];
    for (const [thrown, shown] of refusals) {
      const { api } = fakeApi({
        mutate: async () => {
          throw ipcError(thrown);
        }
      });
      const ops = new TopicOpsController(() => api);
      await expect(ops.pin(topic(), true)).resolves.toBe(false);
      expect(ops.getSnapshot()).toMatchObject({ error: shown, notice: null, busy: false });
    }
    const { api } = fakeApi({
      mutate: async () => {
        throw new Error("something odd");
      }
    });
    const ops = new TopicOpsController(() => api);
    await ops.move(topic(), { id: id(2), title: "Other" });
    expect(ops.getSnapshot().error).toBe("topics.ops.errors.failed");
  });

  it("treats the same place again as done, not as a failure", async () => {
    const { api } = fakeApi({
      mutate: async () => {
        throw ipcError("topics.errors.unchanged");
      }
    });
    const ops = new TopicOpsController(() => api);
    await expect(
      ops.place(
        { kind: "note", id: id(5), title: "A note" },
        { id: id(2), title: "Topic" },
        "primary"
      )
    ).resolves.toBe(true);
    expect(ops.getSnapshot()).toMatchObject({ error: null, notice: null });
  });

  it("runs one operation at a time", async () => {
    let release: (result: TopicMutationResult) => void = () => undefined;
    const { api, calls } = fakeApi({
      mutate: () => new Promise<TopicMutationResult>((resolve) => (release = resolve))
    });
    const ops = new TopicOpsController(() => api);
    const first = ops.pin(topic(), true);
    expect(ops.getSnapshot().busy).toBe(true);
    await expect(ops.pin(topic(), false)).resolves.toBe(false);
    release({ changeSetId: id(7), generation: 1 });
    await expect(first).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(ops.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.pinned",
      changeSetId: id(7)
    });
  });

  it("names what each operation did", async () => {
    const { api, calls } = fakeApi();
    const ops = new TopicOpsController(() => api);
    await ops.move(topic(), { id: id(2), title: null });
    expect(calls.at(-1)).toMatchObject({ op: "move", id: id(1), parentId: id(2) });
    expect(ops.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.moved",
      title: "Memory",
      parent: null
    });
    await ops.create({ id: id(2), title: "Area" }, " Decay ");
    expect(calls.at(-1)).toEqual({ op: "create", parentId: id(2), title: "Decay" });
    expect(ops.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.created",
      title: "Decay",
      parent: "Area"
    });
    await ops.pin(topic(), false);
    expect(calls.at(-1)).toEqual({ op: "unpin", id: id(1) });
    expect(ops.getSnapshot().notice?.key).toBe("topics.ops.toast.unpinned");
    await ops.place(
      { kind: "note", id: id(5), title: "A note" },
      { id: id(2), title: "Area" },
      "secondary"
    );
    expect(calls.at(-1)).toEqual({
      op: "placeItem",
      item: { kind: "note", id: id(5) },
      topicId: id(2),
      role: "secondary"
    });
    expect(ops.getSnapshot().notice?.key).toBe("topics.ops.toast.alsoPlaced");
  });

  it("keeps the notice long enough to reach, and waits while it is hovered or focused", async () => {
    const { api } = fakeApi();
    const ops = new TopicOpsController(() => api);
    await ops.pin(topic(), true);
    vi.advanceTimersByTime(noticeVisibleMs - 1);
    expect(ops.getSnapshot().notice).not.toBeNull();
    ops.hold(true);
    vi.advanceTimersByTime(10 * noticeVisibleMs);
    expect(ops.getSnapshot().notice).not.toBeNull();
    ops.hold(false);
    vi.advanceTimersByTime(noticeVisibleMs - 1);
    expect(ops.getSnapshot().notice).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(ops.getSnapshot().notice).toBeNull();
    expect(noticeVisibleMs).toBeGreaterThanOrEqual(10_000);
  });

  it("undoes the change the notice names and then only tells that it did", async () => {
    const { api, undone } = fakeApi();
    const ops = new TopicOpsController(() => api);
    await ops.rename(topic(), "Memory and learning");
    const changeSetId = ops.getSnapshot().notice?.changeSetId;
    const pending = ops.undo();
    expect(ops.getSnapshot().notice?.state).toBe("pending");
    await pending;
    expect(undone).toEqual([changeSetId]);
    expect(ops.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.undone",
      changeSetId: null,
      state: "none"
    });
    // There is nothing left to undo, and a second request does nothing.
    await ops.undo();
    expect(undone).toHaveLength(1);
  });

  it("says when an undo is blocked or failed, and lets it be tried again", async () => {
    let mode: "blocked" | "fail" | "ok" = "blocked";
    const { api, undone } = fakeApi({
      undo: async () => {
        if (mode === "fail") throw new Error("boom");
        return mode === "blocked"
          ? { status: "blocked", blockers: [] }
          : { status: "undone", changeSetId: id(900), generation: 9 };
      }
    });
    const ops = new TopicOpsController(() => api);
    await ops.pin(topic(), true);
    await ops.undo();
    expect(ops.getSnapshot().notice?.state).toBe("blocked");
    mode = "fail";
    await ops.undo();
    expect(ops.getSnapshot().notice?.state).toBe("failed");
    mode = "ok";
    await ops.undo();
    expect(ops.getSnapshot().notice?.state).toBe("none");
    expect(undone).toHaveLength(3);
  });

  it("opens and closes one dialog, and an old refusal does not follow it", async () => {
    const { api } = fakeApi({
      mutate: async () => {
        throw ipcError("topics.errors.notFound");
      }
    });
    const ops = new TopicOpsController(() => api);
    await ops.pin(topic(), true);
    expect(ops.getSnapshot().error).not.toBeNull();
    ops.openDialog({ kind: "create", parent: { id: id(2), title: "Area" }, top: false });
    expect(ops.getSnapshot()).toMatchObject({ error: null, dialog: { kind: "create" } });
    await ops.create({ id: id(2), title: "Area" }, "");
    expect(ops.getSnapshot().error).toBe("topics.ops.rename.empty");
    ops.closeDialog();
    expect(ops.getSnapshot()).toMatchObject({ dialog: null, error: null });
  });

  it("drops the dialog, the notice and the refusal when its view is hidden", async () => {
    const { api } = fakeApi();
    const ops = new TopicOpsController(() => api);
    await ops.pin(topic(), true);
    ops.openDialog({ kind: "move", topic: topic() });
    ops.reset();
    expect(ops.getSnapshot()).toMatchObject({ notice: null, error: null, dialog: null });
    vi.advanceTimersByTime(noticeVisibleMs);
    expect(ops.getSnapshot().notice).toBeNull();
  });

  it("tells the views through subscriptions, and clears a refusal on request", async () => {
    const { api } = fakeApi({
      mutate: async () => {
        throw ipcError("topics.errors.notFound");
      }
    });
    const ops = new TopicOpsController(() => api);
    const seen = vi.fn();
    const off = ops.subscribe(seen);
    await ops.pin(topic(), true);
    expect(seen).toHaveBeenCalled();
    expect(ops.getSnapshot().error).toBe("topics.errors.notFound");
    ops.clearError();
    expect(ops.getSnapshot().error).toBeNull();
    off();
    seen.mockClear();
    ops.clearError();
    await ops.pin(topic(), true);
    expect(seen).not.toHaveBeenCalled();
  });
});
