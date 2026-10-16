import { describe, expect, it, vi } from "vitest";
import type { TopicMutation, TopicMutationResult, TopicUndoResult } from "@app/domain";

import type { ViewHistoryEntry, ViewHistoryRecordInput } from "../../../../shared/view-history";
import { TopicNoticeCenter } from "./topic-notice-center";
import { TopicOpsController, type OpsApi, type OpsHistoryApi } from "./topic-ops-controller";

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

/** A view history that remembers pins; an address is known once it was recorded. */
function fakeHistory(known: string[] = [], failWith?: Error) {
  const pinned = new Set<string>();
  const knownSet = new Set(known);
  const log: string[] = [];
  const api: OpsHistoryApi = {
    setPinned: async (address, value) => {
      log.push(`pin ${address} ${value}`);
      if (failWith && value) throw failWith;
      if (!knownSet.has(address)) return null;
      if (value) pinned.add(address);
      else pinned.delete(address);
      return { address, pinned: value } as unknown as ViewHistoryEntry;
    },
    record: async (input: ViewHistoryRecordInput) => {
      const address = `memora://${input.kind}/${input.id}`;
      log.push(`record ${address} ${input.title} ${input.parentAddress ?? "-"}`);
      knownSet.add(address);
      return { address } as unknown as ViewHistoryEntry;
    }
  };
  return { api, log, pinned };
}

function setup(overrides: Parameters<typeof fakeApi>[0] = {}, known: string[] = []) {
  const { api, calls, undone } = fakeApi(overrides);
  const center = new TopicNoticeCenter(() => api);
  const history = fakeHistory(known);
  const ops = new TopicOpsController(() => api, { center, history: () => history.api });
  return { ops, center, calls, undone, history, api };
}

const ipcError = (key: string) =>
  new Error(`Error invoking remote method 'app:topics:mutate': Error: ${key}`);

describe("the human operations of a view", () => {
  it("renames a topic from the stamp it was shown with, and offers Undo in the window's notice", async () => {
    const { ops, center, calls } = setup();
    await expect(ops.rename(topic(), "  Memory   and learning ")).resolves.toBe(true);
    expect(calls).toEqual([
      {
        op: "rename",
        id: id(1),
        title: "Memory and learning",
        expectedUpdatedAt: "2026-10-15T10:00:00.000Z"
      }
    ]);
    expect(ops.getSnapshot()).toMatchObject({ busy: false, error: null });
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.renamed",
      title: "Memory and learning",
      changeSetId: id(101),
      state: "idle"
    });
  });

  it("checks a name before calling and says nothing changed for the same name", async () => {
    const { ops, center, calls } = setup();
    await expect(ops.rename(topic(), "   ")).resolves.toBe(false);
    expect(ops.getSnapshot().error).toBe("topics.ops.rename.empty");
    await expect(ops.rename(topic(), "x".repeat(121))).resolves.toBe(false);
    expect(ops.getSnapshot().error).toBe("topics.ops.rename.tooLong");
    await expect(ops.create({ id: id(2), title: null }, "")).resolves.toBe(false);
    // The same name is already so: no call, no notice, and the earlier refusal is gone.
    await expect(ops.rename(topic(), "Memory")).resolves.toBe(true);
    expect(calls).toEqual([]);
    expect(ops.getSnapshot().error).toBeNull();
    expect(center.getSnapshot().notice).toBeNull();
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
      const { ops, center } = setup({
        mutate: async () => {
          throw ipcError(thrown);
        }
      });
      await expect(ops.pin(topic(), true)).resolves.toBe(false);
      expect(ops.getSnapshot()).toMatchObject({ error: shown, busy: false });
      expect(center.getSnapshot().notice).toBeNull();
    }
    const { ops } = setup({
      mutate: async () => {
        throw new Error("something odd");
      }
    });
    await ops.move(topic(), { id: id(2), title: "Other" });
    expect(ops.getSnapshot().error).toBe("topics.ops.errors.failed");
  });

  it("treats the same place again as done, not as a failure", async () => {
    const { ops, center } = setup({
      mutate: async () => {
        throw ipcError("topics.errors.unchanged");
      }
    });
    await expect(
      ops.place(
        { kind: "note", id: id(5), title: "A note" },
        { id: id(2), title: "Topic" },
        "primary"
      )
    ).resolves.toBe(true);
    expect(ops.getSnapshot()).toMatchObject({ error: null });
    expect(center.getSnapshot().notice).toBeNull();
  });

  it("runs one operation at a time", async () => {
    let release: (result: TopicMutationResult) => void = () => undefined;
    const { ops, center, calls } = setup({
      mutate: () => new Promise<TopicMutationResult>((resolve) => (release = resolve))
    });
    const first = ops.pin(topic(), true);
    expect(ops.getSnapshot().busy).toBe(true);
    await expect(ops.pin(topic(), false)).resolves.toBe(false);
    release({ changeSetId: id(7), generation: 1 });
    await expect(first).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.pinned",
      changeSetId: id(7)
    });
  });

  it("names what each operation did", async () => {
    const { ops, center, calls } = setup();
    await ops.move(topic(), { id: id(2), title: null });
    expect(calls.at(-1)).toMatchObject({ op: "move", id: id(1), parentId: id(2) });
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.moved",
      title: "Memory",
      parent: null
    });
    await ops.create({ id: id(2), title: "Area" }, " Decay ");
    expect(calls.at(-1)).toEqual({ op: "create", parentId: id(2), title: "Decay" });
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.created",
      title: "Decay",
      parent: "Area"
    });
    await ops.pin(topic(), false);
    expect(calls.at(-1)).toEqual({ op: "unpin", id: id(1) });
    expect(center.getSnapshot().notice?.key).toBe("topics.ops.toast.unpinned");
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
    expect(center.getSnapshot().notice?.key).toBe("topics.ops.toast.alsoPlaced");
  });

  it("opens and closes one dialog, and an old refusal does not follow it", async () => {
    const { ops } = setup({
      mutate: async () => {
        throw ipcError("topics.errors.notFound");
      }
    });
    await ops.pin(topic(), true);
    expect(ops.getSnapshot().error).not.toBeNull();
    ops.openDialog({ kind: "create", parent: { id: id(2), title: "Area" }, top: false });
    expect(ops.getSnapshot()).toMatchObject({ error: null, dialog: { kind: "create" } });
    await ops.create({ id: id(2), title: "Area" }, "");
    expect(ops.getSnapshot().error).toBe("topics.ops.rename.empty");
    ops.closeDialog();
    expect(ops.getSnapshot()).toMatchObject({ dialog: null, error: null });
  });

  it("drops the dialog, its notice and the refusal when its view is hidden", async () => {
    const { ops, center } = setup();
    await ops.pin(topic(), true);
    expect(center.getSnapshot().notice).not.toBeNull();
    ops.openDialog({ kind: "move", topic: topic() });
    ops.reset();
    expect(ops.getSnapshot()).toMatchObject({ error: null, dialog: null });
    expect(center.getSnapshot().notice).toBeNull();
  });

  it("tells the views through subscriptions, and clears a refusal on request", async () => {
    const { ops } = setup({
      mutate: async () => {
        throw ipcError("topics.errors.notFound");
      }
    });
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

describe("two views and one notice", () => {
  it("shows the newest notice of either view, and Undo reverts that one", async () => {
    const shared = fakeApi();
    const center = new TopicNoticeCenter(() => shared.api);
    const navigator = new TopicOpsController(() => shared.api, { center });
    const page = new TopicOpsController(() => shared.api, { center });
    await navigator.rename(topic(), "From the navigator");
    await page.pin(topic({ title: "From the page" }), true);
    // One notice at the same place: the newest, the Topic page's.
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.pinned",
      title: "From the page",
      changeSetId: id(102)
    });
    await center.undo();
    expect(shared.undone).toEqual([id(102)]);
    expect(center.getSnapshot().notice).toMatchObject({ key: "topics.ops.toast.undone" });
  });

  it("hides only the notice of the view that went away", async () => {
    const shared = fakeApi();
    const center = new TopicNoticeCenter(() => shared.api);
    const navigator = new TopicOpsController(() => shared.api, { center });
    const page = new TopicOpsController(() => shared.api, { center });
    await navigator.rename(topic(), "Named");
    // The page is hidden but the notice is the navigator's: it stays.
    page.reset();
    expect(center.getSnapshot().notice).not.toBeNull();
    await page.pin(topic(), true);
    navigator.reset();
    expect(center.getSnapshot().notice).not.toBeNull();
    page.reset();
    expect(center.getSnapshot().notice).toBeNull();
  });

  it("keeps a view's 'undone' notice with the view until it is hidden", async () => {
    const shared = fakeApi();
    const center = new TopicNoticeCenter(() => shared.api);
    const view = new TopicOpsController(() => shared.api, { center });
    await view.pin(topic(), true);
    await center.undo();
    expect(center.getSnapshot().notice?.key).toBe("topics.ops.toast.undone");
    view.reset();
    expect(center.getSnapshot().notice).toBeNull();
  });
});

describe("pins that only the view history holds (D28)", () => {
  const noteAddress = `memora://note/${id(5)}`;
  const topicAddress = `memora://topic/${id(2)}`;

  it("pins a note already in the history without recording it again or touching the tree", async () => {
    const { ops, center, calls, history } = setup({}, [noteAddress]);
    const host = vi.fn(async () => `memora://source/${id(9)}`);
    await expect(
      ops.pinHistory({ kind: "note", id: id(5), title: "A note", host }, true)
    ).resolves.toBe(true);
    expect(history.log).toEqual([`pin ${noteAddress} true`]);
    expect(host).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // A history pin names no change-set: the notice only tells.
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.itemPinned",
      title: "A note",
      changeSetId: null,
      state: "none"
    });
  });

  it("records a note that was never opened with the source it opens in, then pins it", async () => {
    const { ops, history } = setup();
    const source = `memora://source/${id(9)}`;
    await expect(
      ops.pinHistory({ kind: "note", id: id(5), title: "A note", host: async () => source }, true)
    ).resolves.toBe(true);
    expect(history.log).toEqual([
      `pin ${noteAddress} true`,
      `record ${noteAddress} A note ${source}`,
      `pin ${noteAddress} true`
    ]);
    expect(history.pinned.has(noteAddress)).toBe(true);
  });

  it("records a source that was never opened without a host", async () => {
    const { ops, history } = setup();
    const address = `memora://source/${id(6)}`;
    await ops.pinHistory({ kind: "source", id: id(6), title: "A source" }, true);
    expect(history.log).toEqual([
      `pin ${address} true`,
      `record ${address} A source -`,
      `pin ${address} true`
    ]);
  });

  it("refuses to pin a note whose source cannot be found, and leaves nothing behind", async () => {
    const { ops, center, history } = setup();
    await expect(
      ops.pinHistory({ kind: "note", id: id(5), title: "A note", host: async () => null }, true)
    ).resolves.toBe(false);
    expect(ops.getSnapshot().error).toBe("topics.ops.errors.failed");
    expect(history.log).toEqual([`pin ${noteAddress} true`]);
    expect(center.getSnapshot().notice).toBeNull();
  });

  it("unpins a note or a source in the history only", async () => {
    const { ops, center, calls, history } = setup({}, [noteAddress]);
    await ops.pinHistory({ kind: "note", id: id(5), title: "A note" }, true);
    await ops.pinHistory({ kind: "note", id: id(5), title: "A note" }, false);
    expect(history.pinned.has(noteAddress)).toBe(false);
    expect(calls).toEqual([]);
    expect(center.getSnapshot().notice?.key).toBe("topics.ops.toast.itemUnpinned");
  });

  it("unpins a topic that is pinned in the history without being protected, without a change-set", async () => {
    const { ops, center, calls, history } = setup({}, [topicAddress]);
    await ops.pinHistory({ kind: "topic", id: id(2), title: null }, true);
    expect(history.pinned.has(topicAddress)).toBe(true);
    await expect(ops.pinHistory({ kind: "topic", id: id(2), title: null }, false)).resolves.toBe(
      true
    );
    expect(history.pinned.has(topicAddress)).toBe(false);
    // The tree is not touched, and there is nothing to undo.
    expect(calls).toEqual([]);
    expect(center.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.itemUnpinned",
      changeSetId: null,
      state: "none"
    });
  });

  it("tells the pin limit as the refusal it is", async () => {
    const shared = fakeApi();
    const center = new TopicNoticeCenter(() => shared.api);
    const history = fakeHistory(
      [noteAddress],
      new Error("Error invoking remote method: Error: errors.viewHistory.pinLimit")
    );
    const ops = new TopicOpsController(() => shared.api, { center, history: () => history.api });
    await expect(ops.pinHistory({ kind: "note", id: id(5), title: "A note" }, true)).resolves.toBe(
      false
    );
    expect(ops.getSnapshot().error).toBe("viewHistory.pinLimit");
    expect(center.getSnapshot().notice).toBeNull();
  });

  it("takes its turn like any other operation", async () => {
    let release: () => void = () => undefined;
    const shared = fakeApi();
    const center = new TopicNoticeCenter(() => shared.api);
    const slow: OpsHistoryApi = {
      setPinned: () =>
        new Promise((resolve) => {
          release = () => resolve({ address: noteAddress } as unknown as ViewHistoryEntry);
        }),
      record: async () => ({}) as ViewHistoryEntry
    };
    const ops = new TopicOpsController(() => shared.api, { center, history: () => slow });
    const first = ops.pinHistory({ kind: "note", id: id(5), title: "A note" }, true);
    expect(ops.getSnapshot().busy).toBe(true);
    await expect(ops.pin(topic(), true)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(shared.calls).toEqual([]);
  });
});
