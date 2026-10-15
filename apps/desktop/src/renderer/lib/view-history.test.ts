import { formatObjectAddress } from "@app/domain";
import { describe, expect, it, vi } from "vitest";
import { viewHistoryBounds, type ViewHistoryEntry } from "../../shared/view-history";
import {
  applyRecentsFocus,
  groupRecents,
  openedLibraryObjects,
  recentKinds,
  recentOpenTarget,
  recordView,
  viewsToRecord,
  type Focusable,
  type OpenedObject,
  type RecentsFocus
} from "./view-history";

const sourceId = "00000000-0000-4000-8000-0000000000a1";
const otherSourceId = "00000000-0000-4000-8000-0000000000a2";
const noteId = "00000000-0000-4000-8000-0000000000b1";

const source: OpenedObject = { kind: "source", id: sourceId, title: "A source" };
const note: OpenedObject = {
  kind: "note",
  id: noteId,
  title: "A note",
  parentAddress: formatObjectAddress({ kind: "source", id: sourceId })
};

describe("which opens are recorded", () => {
  it("records a source when it opens, and not again while it stays open", () => {
    const first = viewsToRecord([source], new Set());
    expect(first.record).toEqual([source]);
    const again = viewsToRecord([source], first.recorded);
    expect(again.record).toEqual([]);
    expect([...again.recorded]).toEqual([`memora://source/${sourceId}`]);
  });

  it("records a note focused inside an open source, and the next source when it changes", () => {
    const opened = viewsToRecord([source], new Set());
    const focused = viewsToRecord([source, note], opened.recorded);
    expect(focused.record).toEqual([note]);
    const next = viewsToRecord(
      [{ ...source, id: otherSourceId, title: "Other" }],
      focused.recorded
    );
    expect(next.record.map((object) => object.id)).toEqual([otherSourceId]);
    expect([...next.recorded]).toEqual([`memora://source/${otherSourceId}`]);
  });

  it("counts closing a source and opening it again as another open", () => {
    const opened = viewsToRecord([source], new Set());
    const closed = viewsToRecord([], opened.recorded);
    expect(closed.record).toEqual([]);
    expect(viewsToRecord([source], closed.recorded).record).toEqual([source]);
  });

  it("counts nothing while the view is hidden, and a source shown again is the same open", () => {
    const opened = viewsToRecord([source], new Set());
    const hidden = viewsToRecord(null, opened.recorded);
    expect(hidden).toEqual({ record: [], recorded: opened.recorded });
    expect(viewsToRecord([source], hidden.recorded).record).toEqual([]);
  });
});

describe("what the Library shows for an open source", () => {
  const detail = {
    id: sourceId,
    title: "A source",
    atomicNotes: [{ id: noteId, title: "A note" }]
  };

  it("is the source, and the focused note with its source as host", () => {
    expect(openedLibraryObjects(detail, null)).toEqual([source]);
    expect(openedLibraryObjects(detail, noteId)).toEqual([source, note]);
    // A note that is not in this source cannot be recorded against it.
    expect(openedLibraryObjects(detail, "00000000-0000-4000-8000-0000000000b2")).toEqual([source]);
    expect(openedLibraryObjects(null, noteId)).toEqual([]);
  });
});

describe("where a recent entry leads", () => {
  it("opens a source, and a note inside its host source", () => {
    expect(recentOpenTarget({ kind: "source", id: sourceId, parentAddress: null })).toEqual({
      sourceItemId: sourceId
    });
    expect(
      recentOpenTarget({
        kind: "note",
        id: noteId,
        parentAddress: formatObjectAddress({ kind: "source", id: sourceId })
      })
    ).toEqual({ sourceItemId: sourceId, atomicNoteId: noteId });
  });

  it("opens nothing it cannot open", () => {
    expect(recentOpenTarget({ kind: "note", id: noteId, parentAddress: null })).toBeNull();
    expect(
      recentOpenTarget({
        kind: "note",
        id: noteId,
        parentAddress: formatObjectAddress({ kind: "entity", id: sourceId })
      })
    ).toBeNull();
    for (const kind of ["topic", "question", "entity"] as const)
      expect(recentOpenTarget({ kind, id: sourceId, parentAddress: null })).toBeNull();
    // The list only asks for what the Library can open.
    expect([...recentKinds]).toEqual(["source", "note"]);
  });
});

describe("recording an open", () => {
  it("never fails the view that was opened", async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    vi.stubGlobal("window", { app: { viewHistory: { record } } });
    try {
      expect(() => recordView({ kind: "source", id: sourceId, title: "A source" })).not.toThrow();
      await Promise.resolve();
      expect(record).toHaveBeenCalledWith({ kind: "source", id: sourceId, title: "A source" });
      // Even a missing preload API is absorbed.
      vi.stubGlobal("window", {});
      expect(() => recordView({ kind: "source", id: sourceId, title: "A source" })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the Recents list in two groups", () => {
  const entry = (index: number, pinned: boolean): ViewHistoryEntry => ({
    address: `memora://source/00000000-0000-4000-8000-00000000${String(index).padStart(4, "0")}`,
    kind: "source",
    id: `00000000-0000-4000-8000-00000000${String(index).padStart(4, "0")}`,
    title: `Source ${index}`,
    parentAddress: null,
    openedAt: "2026-10-15T10:00:00.000Z",
    openCount: 1,
    pinned
  });

  it("separates the pins from the recents and keeps the order inside each group", () => {
    const groups = groupRecents([entry(1, true), entry(2, true), entry(3, false), entry(4, false)]);
    expect(groups.pinned.map((item) => item.title)).toEqual(["Source 1", "Source 2"]);
    expect(groups.recent.map((item) => item.title)).toEqual(["Source 3", "Source 4"]);
    expect(groups.pinsFull).toBe(false);
  });

  it("says when every pin slot is taken, while the recents stay on the list", () => {
    const pins = Array.from({ length: viewHistoryBounds.pinMax }, (_, index) => entry(index, true));
    const groups = groupRecents([...pins, entry(99, false)]);
    expect(groups.pinsFull).toBe(true);
    expect(groups.recent.map((item) => item.title)).toEqual(["Source 99"]);
    expect(groupRecents(pins.slice(1)).pinsFull).toBe(false);
    expect(groupRecents([])).toEqual({ pinned: [], recent: [], pinsFull: false });
  });
});

describe("moving focus in the Recents list", () => {
  function controls(present: Array<RecentsFocus["target"]>, address = "memora://source/a") {
    const focused: string[] = [];
    const element = (name: string): Focusable => ({ focus: () => void focused.push(name) });
    const find = (request: RecentsFocus) =>
      present.includes(request.target) && (request.target !== "pin" || request.address === address)
        ? element(request.target)
        : null;
    return { find, focused };
  }

  it("moves into the confirmation when it opens, and to the title when it is confirmed", () => {
    const all = controls(["clear-confirmation", "clear-button", "title", "pin"]);
    expect(applyRecentsFocus({ target: "clear-confirmation" }, all.find)).toBe(true);
    expect(applyRecentsFocus({ target: "title" }, all.find)).toBe(true);
    expect(all.focused).toEqual(["clear-confirmation", "title"]);
  });

  it("returns to the Clear button when the confirmation is cancelled", () => {
    const all = controls(["clear-button", "title"]);
    expect(applyRecentsFocus({ target: "clear-button" }, all.find)).toBe(true);
    expect(all.focused).toEqual(["clear-button"]);
  });

  it("falls back to the title when the control is gone, instead of leaving focus on the page", () => {
    const noButton = controls(["title"]);
    expect(applyRecentsFocus({ target: "clear-button" }, noButton.find)).toBe(true);
    expect(noButton.focused).toEqual(["title"]);
    const noPin = controls(["title"]);
    expect(applyRecentsFocus({ target: "pin", address: "memora://source/a" }, noPin.find)).toBe(
      true
    );
    expect(noPin.focused).toEqual(["title"]);
  });

  it("follows a pin to its new place by address, not to a pin of another entry", () => {
    const list = controls(["pin", "title"], "memora://source/a");
    expect(applyRecentsFocus({ target: "pin", address: "memora://source/a" }, list.find)).toBe(
      true
    );
    expect(list.focused).toEqual(["pin"]);
    const other = controls(["pin", "title"], "memora://source/b");
    applyRecentsFocus({ target: "pin", address: "memora://source/a" }, other.find);
    expect(other.focused).toEqual(["title"]);
  });

  it("does nothing, and says so, when there is nowhere to move focus", () => {
    const empty = controls([]);
    expect(applyRecentsFocus({ target: "clear-confirmation" }, empty.find)).toBe(false);
    expect(applyRecentsFocus({ target: "clear-button" }, empty.find)).toBe(false);
    expect(empty.focused).toEqual([]);
  });
});
