import { describe, expect, it } from "vitest";

import {
  libraryBackLabelKey,
  libraryPopStateAction,
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
    ).toEqual({ type: "path", path: [sourceA], fromSearch: true });
    // A foreign entry returns to the Library root.
    expect(libraryPopStateAction(true, null)).toEqual({
      type: "path",
      path: [],
      fromSearch: false
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
