import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../shared/ipc";

import { searchResultOpener } from "./SearchView";

const ids = {
  source: "00000000-0000-4000-8000-000000000001",
  note: "00000000-0000-4000-8000-000000000002",
  chunk: "00000000-0000-4000-8000-000000000003",
  span: "00000000-0000-4000-8000-000000000004"
};

const result = (overrides: Record<string, unknown>) =>
  ({ sourceItemId: ids.source, ...overrides }) as unknown as SearchResult;

describe("where a search result leads", () => {
  it("opens a note result as its Note page", () => {
    const onOpenSource = vi.fn();
    const onOpenNote = vi.fn();
    searchResultOpener(
      result({ kind: "atomic_note", noteId: ids.note }),
      onOpenSource,
      onOpenNote
    )?.();
    expect(onOpenNote).toHaveBeenCalledWith(ids.source, ids.note);
    expect(onOpenSource).not.toHaveBeenCalled();
  });

  it("opens a passage at its chunk and anything else at its source", () => {
    const onOpenSource = vi.fn();
    searchResultOpener(
      result({ kind: "chunk", chunkId: ids.chunk, sourceSpanId: ids.span }),
      onOpenSource,
      undefined
    )?.();
    expect(onOpenSource).toHaveBeenCalledWith(ids.source, {
      chunkId: ids.chunk,
      sourceSpanId: ids.span,
      documentId: null
    });
    searchResultOpener(result({ kind: "entity" }), onOpenSource, undefined)?.();
    expect(onOpenSource).toHaveBeenLastCalledWith(ids.source);
    // Without a Note page, a note result still opens its source.
    searchResultOpener(
      result({ kind: "atomic_note", noteId: ids.note }),
      onOpenSource,
      undefined
    )?.();
    expect(onOpenSource).toHaveBeenLastCalledWith(ids.source);
    expect(searchResultOpener(result({ kind: "entity" }), undefined, undefined)).toBeUndefined();
  });
});
