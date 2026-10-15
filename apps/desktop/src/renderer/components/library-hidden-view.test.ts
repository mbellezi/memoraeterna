import { describe, expect, it } from "vitest";

import {
  createLibraryHistoryState,
  editorClaimsClose,
  libraryBackLabelKey,
  libraryClosesSource,
  libraryHistoryEntryForOpening,
  libraryHistoryEntryFromState,
  libraryPopStateAction,
  noteBackLabelKey,
  targetOpeningSource,
  type LibraryExternalTarget
} from "./LibraryView";

const sourceA = "00000000-0000-4000-8000-0000000000a1";
const sourceB = "00000000-0000-4000-8000-0000000000b1";
const noteA = "00000000-0000-4000-8000-0000000000c1";

const target = (overrides: Partial<LibraryExternalTarget> = {}): LibraryExternalTarget => ({
  sourceItemId: sourceA,
  origin: "knowledgeGraph",
  token: 1,
  ...overrides
});

describe("a Library that is hidden", () => {
  it("ignores history changes, so it cannot leave its view or reset another view's scroll", () => {
    for (const entry of [
      { view: "wiki" as const },
      { view: "search" as const },
      { view: "knowledgeGraph" as const },
      { view: "library" as const, path: [sourceA], fromSearch: true },
      null
    ])
      expect(libraryPopStateAction(false, entry)).toEqual({ type: "ignore" });
  });

  it("follows history changes while it is shown", () => {
    expect(libraryPopStateAction(true, { view: "wiki" })).toEqual({ type: "exit", view: "wiki" });
    expect(libraryPopStateAction(true, { view: "search" })).toEqual({
      type: "exit",
      view: "search"
    });
    expect(libraryPopStateAction(true, { view: "knowledgeGraph" })).toEqual({
      type: "exit",
      view: "knowledgeGraph"
    });
    expect(
      libraryPopStateAction(true, { view: "library", path: [sourceA], fromSearch: true })
    ).toEqual({ type: "path", path: [sourceA], fromSearch: true, noteId: null });
    // An entry with an open note brings the Note page back.
    expect(
      libraryPopStateAction(true, {
        view: "library",
        path: [sourceA],
        fromSearch: false,
        noteId: noteA
      })
    ).toEqual({ type: "path", path: [sourceA], fromSearch: false, noteId: noteA });
    // A foreign entry returns to the Library root.
    expect(libraryPopStateAction(true, null)).toEqual({
      type: "path",
      path: [],
      fromSearch: false,
      noteId: null
    });
  });
});

describe("what a Library target applies to", () => {
  it("applies only to the source it opened", () => {
    expect(targetOpeningSource(target(), sourceA)).toEqual(target());
    expect(targetOpeningSource(target(), sourceB)).toBeNull();
    expect(targetOpeningSource(target(), null)).toBeNull();
    expect(targetOpeningSource(null, sourceA)).toBeNull();
  });

  it("labels Back with the origin only for the source that was opened from it", () => {
    const fromGraph = target();
    expect(
      libraryBackLabelKey({ stack: [sourceA], openedTarget: fromGraph, fromSearch: false })
    ).toBe("knowledgeGraph.backToGraph");
    expect(
      libraryBackLabelKey({
        stack: [sourceA],
        openedTarget: target({ origin: "wiki" }),
        fromSearch: false
      })
    ).toBe("wiki.backToWiki");
  });

  it("does not relabel Back for a source opened later from the list", () => {
    // The graph opened source A once; the reader later opens B from the Library list.
    const stale = target({ atomicNoteId: noteA });
    expect(libraryBackLabelKey({ stack: [sourceB], openedTarget: stale, fromSearch: false })).toBe(
      "library.back"
    );
    expect(libraryBackLabelKey({ stack: [], openedTarget: stale, fromSearch: false })).toBe(
      "library.back"
    );
    // Nor does it label a nested source, whose Back leads to its parent.
    expect(
      libraryBackLabelKey({ stack: [sourceA, sourceB], openedTarget: stale, fromSearch: false })
    ).toBe("library.back");
  });

  it("keeps the search and import labels", () => {
    expect(libraryBackLabelKey({ stack: [sourceA], openedTarget: null, fromSearch: true })).toBe(
      "library.detail.backToSearch"
    );
    expect(
      libraryBackLabelKey({
        stack: [sourceA],
        openedTarget: target({ origin: "import" }),
        fromSearch: false
      })
    ).toBe("library.back");
  });
});

describe("a note open as a page in the Library history", () => {
  it("round-trips with and without the note", () => {
    const withNote = { view: "library" as const, path: [sourceA], fromSearch: true, noteId: noteA };
    expect(libraryHistoryEntryFromState(createLibraryHistoryState(withNote))).toEqual(withNote);
    const without = { view: "library" as const, path: [sourceA], fromSearch: false };
    expect(libraryHistoryEntryFromState(createLibraryHistoryState(without))).toEqual(without);
  });

  it("drops a note that is not an ID and keeps the path", () => {
    for (const noteId of ["memora://note/x", 42, "", null])
      expect(
        libraryHistoryEntryFromState({
          memoraEternaLibrary: {
            version: 1,
            view: "library",
            path: [sourceA],
            fromSearch: false,
            noteId
          }
        })
      ).toEqual({ view: "library", path: [sourceA], fromSearch: false });
  });

  it("opens note targets with the same Back as before", () => {
    expect(libraryHistoryEntryForOpening("knowledgeGraph", null)).toEqual({
      view: "knowledgeGraph"
    });
    expect(
      libraryHistoryEntryForOpening("recents", { view: "library", path: [], fromSearch: false })
    ).toBeNull();
  });

  it("labels Back with the origin of the target that opened the note, else plain Back", () => {
    const opened = (origin?: NonNullable<LibraryExternalTarget["origin"]>) => ({
      openedTarget: {
        sourceItemId: sourceA,
        atomicNoteId: noteA,
        token: 1,
        ...(origin ? { origin } : {})
      } satisfies LibraryExternalTarget,
      openNoteId: noteA,
      stack: [sourceA],
      fromSearch: false
    });
    expect(noteBackLabelKey(opened("knowledgeGraph"))).toBe("knowledgeGraph.backToGraph");
    expect(noteBackLabelKey(opened("wiki"))).toBe("wiki.backToWiki");
    expect(noteBackLabelKey({ ...opened(), fromSearch: true })).toBe("library.detail.backToSearch");
    expect(noteBackLabelKey(opened("recents"))).toBe("library.back");
    expect(noteBackLabelKey(opened("import"))).toBe("library.back");
    // Another note opened inside the Library (a relation, a card) just goes back.
    expect(noteBackLabelKey({ ...opened("knowledgeGraph"), openNoteId: sourceB })).toBe(
      "notePage.back"
    );
    expect(noteBackLabelKey({ ...opened("knowledgeGraph"), stack: [sourceB] })).toBe(
      "notePage.back"
    );
    expect(
      noteBackLabelKey({
        openedTarget: null,
        openNoteId: noteA,
        stack: [sourceA],
        fromSearch: true
      })
    ).toBe("notePage.back");
  });
});

describe("Cmd-W in a Library that is hidden or covered", () => {
  it("lets an open source editor keep Cmd-W only while the Library is shown", () => {
    expect(editorClaimsClose(true, "edit")).toBe(true);
    expect(editorClaimsClose(true, "child")).toBe(true);
    expect(editorClaimsClose(false, "edit")).toBe(false);
    expect(editorClaimsClose(true, null)).toBe(false);
    expect(libraryClosesSource(false, sourceA)).toBe(false);
  });
});
