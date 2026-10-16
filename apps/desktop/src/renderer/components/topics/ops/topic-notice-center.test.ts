import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopicUndoResult } from "@app/domain";

import { isInsideDialog, isTypingTarget, isUndoKey, type UndoKeyEvent } from "./notice-key";
import {
  canUndoNotice,
  TopicNoticeCenter,
  type NoticeApi,
  type ShownNotice
} from "./topic-notice-center";
import { noticeVisibleMs, pinNotice } from "./topic-ops";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function center(undo?: (input: { changeSetId: string }) => Promise<TopicUndoResult>) {
  const undone: string[] = [];
  const api: NoticeApi = {
    undo: async (input) => {
      undone.push(input.changeSetId);
      return undo ? undo(input) : { status: "undone", changeSetId: id(900), generation: 9 };
    }
  };
  return { center: new TopicNoticeCenter(() => api), undone };
}

describe("the window's one notice", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the notice long enough to reach, and waits while it is hovered or focused", () => {
    const { center: c } = center();
    c.show(pinNotice(true, "Memory"), id(1), "idle");
    vi.advanceTimersByTime(noticeVisibleMs - 1);
    expect(c.getSnapshot().notice).not.toBeNull();
    c.hold(true);
    vi.advanceTimersByTime(10 * noticeVisibleMs);
    expect(c.getSnapshot().notice).not.toBeNull();
    c.hold(false);
    vi.advanceTimersByTime(noticeVisibleMs - 1);
    expect(c.getSnapshot().notice).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot().notice).toBeNull();
    expect(noticeVisibleMs).toBeGreaterThanOrEqual(10_000);
  });

  it("shows one notice: the newest replaces the one on screen and restarts the wait", () => {
    const { center: c } = center();
    c.show(pinNotice(true, "First"), id(1), "idle");
    vi.advanceTimersByTime(noticeVisibleMs - 1_000);
    const second = c.show(pinNotice(false, "Second"), id(2), "idle");
    expect(c.getSnapshot().notice).toMatchObject({
      id: second,
      title: "Second",
      changeSetId: id(2)
    });
    // The first notice's wait does not dismiss the second.
    vi.advanceTimersByTime(2_000);
    expect(c.getSnapshot().notice).toMatchObject({ title: "Second" });
    vi.advanceTimersByTime(noticeVisibleMs);
    expect(c.getSnapshot().notice).toBeNull();
  });

  it("undoes the change the newest notice names, and then only tells that it did", async () => {
    const { center: c, undone } = center();
    c.show(pinNotice(true, "Old"), id(1), "idle");
    c.show(pinNotice(true, "Memory"), id(2), "idle");
    const pending = c.undo();
    expect(c.getSnapshot().notice?.state).toBe("pending");
    await pending;
    expect(undone).toEqual([id(2)]);
    expect(c.getSnapshot().notice).toMatchObject({
      key: "topics.ops.toast.undone",
      changeSetId: null,
      state: "none"
    });
    // There is nothing left to undo, and a second request does nothing.
    await c.undo();
    expect(undone).toHaveLength(1);
  });

  it("asks once while an undo is in flight", async () => {
    let finish: (result: TopicUndoResult) => void = () => undefined;
    const { center: c, undone } = center(
      () => new Promise<TopicUndoResult>((resolve) => (finish = resolve))
    );
    c.show(pinNotice(true, "Memory"), id(1), "idle");
    const first = c.undo();
    await c.undo();
    expect(undone).toEqual([id(1)]);
    // The wait does not run out under the person's eyes while the undo works.
    vi.advanceTimersByTime(3 * noticeVisibleMs);
    expect(c.getSnapshot().notice?.state).toBe("pending");
    finish({ status: "undone", changeSetId: id(900), generation: 9 });
    await first;
    expect(c.getSnapshot().notice?.key).toBe("topics.ops.toast.undone");
  });

  it("says when an undo is blocked or failed, and lets it be tried again", async () => {
    let mode: "blocked" | "fail" | "ok" = "blocked";
    const { center: c, undone } = center(async () => {
      if (mode === "fail") throw new Error("boom");
      return mode === "blocked"
        ? { status: "blocked", blockers: [] }
        : { status: "undone", changeSetId: id(900), generation: 9 };
    });
    c.show(pinNotice(true, "Memory"), id(1), "idle");
    await c.undo();
    expect(c.getSnapshot().notice?.state).toBe("blocked");
    expect(canUndoNotice(c.getSnapshot().notice)).toBe(false);
    mode = "fail";
    // A blocked notice offers no Undo, so the request is still tried only from a notice that can.
    c.show(pinNotice(true, "Memory"), id(1), "idle");
    await c.undo();
    expect(c.getSnapshot().notice?.state).toBe("failed");
    expect(canUndoNotice(c.getSnapshot().notice)).toBe(true);
    mode = "ok";
    await c.undo();
    expect(c.getSnapshot().notice?.state).toBe("none");
    expect(undone).toHaveLength(3);
  });

  it("ignores the answer of an undo when a newer notice took the place meanwhile", async () => {
    let finish: (result: TopicUndoResult) => void = () => undefined;
    const { center: c } = center(
      () => new Promise<TopicUndoResult>((resolve) => (finish = resolve))
    );
    c.show(pinNotice(true, "Old"), id(1), "idle");
    const undoing = c.undo();
    c.show(pinNotice(true, "New"), id(2), "idle");
    finish({ status: "blocked", blockers: [] });
    await undoing;
    expect(c.getSnapshot().notice).toMatchObject({
      title: "New",
      state: "idle",
      changeSetId: id(2)
    });
  });

  it("forgets that it was hovered when the hovered notice is dismissed", () => {
    const { center: c } = center();
    c.show(pinNotice(true, "First"), id(1), "idle");
    c.hold(true);
    c.dismiss();
    c.show(pinNotice(true, "Second"), id(2), "idle");
    vi.advanceTimersByTime(noticeVisibleMs);
    expect(c.getSnapshot().notice).toBeNull();
  });

  it("tells its listeners about every change, and stops once they leave", () => {
    const { center: c } = center();
    const seen = vi.fn();
    const off = c.subscribe(seen);
    c.show(pinNotice(true, "Memory"), id(1), "idle");
    c.dismiss();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    c.show(pinNotice(true, "Memory"), id(1), "idle");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("releases only the notice of the view that owns it", () => {
    const { center: c } = center();
    const mine = {};
    const other = {};
    c.show(pinNotice(true, "Memory"), id(1), "idle", mine);
    c.release(other);
    expect(c.getSnapshot().notice).not.toBeNull();
    c.release(mine);
    expect(c.getSnapshot().notice).toBeNull();
  });
});

describe("the U key", () => {
  const press = (overrides: Partial<UndoKeyEvent> = {}): UndoKeyEvent => ({
    key: "u",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    repeat: false,
    target: { tagName: "DIV", closest: () => null },
    ...overrides
  });

  it("undoes from anywhere in the window, in either case", () => {
    expect(isUndoKey(press())).toBe(true);
    expect(isUndoKey(press({ key: "U" }))).toBe(true);
    expect(isUndoKey(press({ target: null }))).toBe(true);
  });

  it("is a letter, not an undo, while the person types or holds a modifier", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isUndoKey(press({ target: { tagName } })), tagName).toBe(false);
    }
    expect(isUndoKey(press({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
    expect(isUndoKey(press({ metaKey: true }))).toBe(false);
    expect(isUndoKey(press({ ctrlKey: true }))).toBe(false);
    expect(isUndoKey(press({ altKey: true }))).toBe(false);
    expect(isUndoKey(press({ shiftKey: true }))).toBe(false);
    expect(isUndoKey(press({ key: "z" }))).toBe(false);
  });

  it("leaves a key another control handled, a repeat, and anything inside a dialog", () => {
    expect(isUndoKey(press({ defaultPrevented: true }))).toBe(false);
    expect(isUndoKey(press({ repeat: true }))).toBe(false);
    const inDialog = {
      tagName: "BUTTON",
      closest: (selector: string) => (selector.includes("dialog") ? {} : null)
    };
    expect(isInsideDialog(inDialog)).toBe(true);
    expect(isUndoKey(press({ target: inDialog }))).toBe(false);
    expect(isInsideDialog({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("what a notice offers", () => {
  const notice = (overrides: Partial<ShownNotice>): ShownNotice => ({
    id: 1,
    key: "topics.ops.toast.pinned",
    title: "Memory",
    parent: null,
    changeSetId: id(1),
    state: "idle",
    ...overrides
  });

  it("offers Undo while a change-set can be reverted, and not for a notice that only tells", () => {
    expect(canUndoNotice(null)).toBe(false);
    expect(canUndoNotice(notice({}))).toBe(true);
    expect(canUndoNotice(notice({ state: "pending" }))).toBe(true);
    expect(canUndoNotice(notice({ state: "failed" }))).toBe(true);
    expect(canUndoNotice(notice({ state: "blocked" }))).toBe(false);
    expect(canUndoNotice(notice({ changeSetId: null, state: "none" }))).toBe(false);
  });
});
