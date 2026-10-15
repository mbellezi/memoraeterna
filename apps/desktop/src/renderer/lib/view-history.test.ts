import { describe, expect, it, vi } from "vitest";
import { formatObjectAddress } from "../../shared/view-history";
import {
  openedLibraryObjects,
  recentKinds,
  recentOpenTarget,
  recordView,
  viewsToRecord,
  type OpenedObject
} from "./view-history";

const sourceId = "00000000-0000-4000-8000-0000000000a1";
const otherSourceId = "00000000-0000-4000-8000-0000000000a2";
const noteId = "00000000-0000-4000-8000-0000000000b1";

const source: OpenedObject = { kind: "source", id: sourceId, title: "A source" };
const note: OpenedObject = {
  kind: "note",
  id: noteId,
  title: "A note",
  parentAddress: formatObjectAddress("source", sourceId)
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
        parentAddress: formatObjectAddress("source", sourceId)
      })
    ).toEqual({ sourceItemId: sourceId, atomicNoteId: noteId });
  });

  it("opens nothing it cannot open", () => {
    expect(recentOpenTarget({ kind: "note", id: noteId, parentAddress: null })).toBeNull();
    expect(
      recentOpenTarget({
        kind: "note",
        id: noteId,
        parentAddress: formatObjectAddress("entity", sourceId)
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
