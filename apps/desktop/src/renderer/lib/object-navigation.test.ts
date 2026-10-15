import { describe, expect, it } from "vitest";
import { parseObjectAddress, type ObjectLocateResult } from "@app/domain";

import {
  citationTarget,
  libraryTargetForNavigation,
  navigationForAddress,
  navigationForLocated,
  navigationForPathSegment,
  navigationForPlacement,
  resolvePassage,
  type ReaderDocument
} from "./object-navigation";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = uuid(1);
const chunk = uuid(2);
const span = uuid(3);
const document = uuid(4);

describe("citation targets", () => {
  it("opens the exact chunk and SourceSpan of the evidence in its source", () => {
    const target = citationTarget({
      sourceItemId: source,
      chunkId: chunk,
      sourceSpanId: span,
      documentId: document
    });
    expect(target.sourceItemId).toBe(source);
    expect(target.passage).toEqual({ chunkId: chunk, sourceSpanId: span, documentId: document });
    expect(target.address).toBe(`memora://source/${source}#passage=${chunk}&span=${span}`);
    expect(parseObjectAddress(target.address)).toEqual({
      kind: "source",
      id: source,
      anchor: { passage: chunk, span }
    });
  });

  it("keeps what is known: a chunk without a span, a span without a chunk, or only the source", () => {
    expect(
      citationTarget({ sourceItemId: source, chunkId: chunk, sourceSpanId: null }).address
    ).toBe(`memora://source/${source}#passage=${chunk}`);
    expect(citationTarget({ sourceItemId: source, sourceSpanId: span }).address).toBe(
      `memora://source/${source}#span=${span}`
    );
    const bare = citationTarget({ sourceItemId: source });
    expect(bare.address).toBe(`memora://source/${source}`);
    expect(bare.passage).toEqual({ chunkId: null, sourceSpanId: null, documentId: null });
  });
});

const chunkOf = (
  n: number,
  offsets: [number, number] | null,
  spanId: string | null = uuid(100 + n)
) => ({
  id: uuid(10 + n),
  chunkIndex: n,
  sourceSpanId: spanId,
  startOffset: offsets?.[0] ?? null,
  endOffset: offsets?.[1] ?? null,
  page: n + 1
});
const documents: ReaderDocument[] = [
  { id: document, chunks: [chunkOf(0, [0, 40]), chunkOf(1, [42, 90]), chunkOf(2, null)] },
  { id: uuid(5), chunks: [chunkOf(3, [0, 0])] }
];
const anchor = (chunkId: string | null, sourceSpanId: string | null = null) => ({
  chunkId,
  sourceSpanId,
  documentId: null
});

describe("resolving a cited passage in the source reader", () => {
  it("finds the chunk by ID with its document, span range and page", () => {
    expect(resolvePassage(documents, anchor(uuid(11), uuid(101)))).toEqual({
      status: "found",
      documentId: document,
      chunkId: uuid(11),
      chunkIndex: 1,
      sourceSpanId: uuid(101),
      page: 2,
      range: { start: 42, end: 90 }
    });
  });

  it("finds a chunk in any current document and reports no range when the span is unknown or empty", () => {
    expect(resolvePassage(documents, anchor(uuid(12)))).toMatchObject({
      status: "found",
      documentId: document,
      range: null
    });
    expect(resolvePassage(documents, anchor(uuid(13)))).toMatchObject({
      status: "found",
      documentId: uuid(5),
      range: null
    });
  });

  it("falls back to the SourceSpan when only the span is known, or the chunk was rebuilt", () => {
    expect(resolvePassage(documents, anchor(null, uuid(100)))).toMatchObject({
      status: "found",
      chunkId: uuid(10)
    });
    expect(resolvePassage(documents, anchor(uuid(999), uuid(101)))).toMatchObject({
      status: "found",
      chunkId: uuid(11)
    });
  });

  it("never guesses: an unknown or earlier-version passage is missing", () => {
    expect(resolvePassage(documents, anchor(uuid(999)))).toEqual({ status: "missing" });
    expect(resolvePassage(documents, anchor(uuid(999), uuid(998)))).toEqual({ status: "missing" });
    expect(resolvePassage(documents, anchor(null, null))).toEqual({ status: "missing" });
    expect(resolvePassage([], anchor(uuid(10)))).toEqual({ status: "missing" });
  });
});

const ref = (kind: "source" | "note" | "topic", n: number, title = `${kind} ${n}`) => ({
  kind,
  id: uuid(n),
  title
});
const located = (
  kind: "source" | "note" | "topic",
  path: ReturnType<typeof ref>[]
): ObjectLocateResult => ({
  object: { ...path.at(-1)!, kind },
  primaryPath: path,
  alsoIn: [],
  citedBy: [],
  counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
});

describe("where an object leads", () => {
  const path = [ref("source", 1), ref("source", 2), ref("source", 3), ref("note", 4)];

  it("opens a source segment at its place in the hierarchy and leaves the current object alone", () => {
    expect(navigationForPathSegment(path, 0)).toEqual({ type: "source", path: [uuid(1)] });
    expect(navigationForPathSegment(path, 2)).toEqual({
      type: "source",
      path: [uuid(1), uuid(2), uuid(3)]
    });
    expect(navigationForPathSegment(path, 3)).toEqual({ type: "none" });
    expect(navigationForPathSegment(path, 9)).toEqual({ type: "none" });
    expect(navigationForPathSegment(path.slice(0, 3), 2)).toEqual({ type: "none" });
  });

  it("opens a topic as itself and locates everything else first", () => {
    expect(navigationForPlacement({ kind: "topic", id: uuid(7), title: "Learning" })).toEqual({
      type: "topic",
      topicId: uuid(7)
    });
    expect(navigationForPlacement({ kind: "question", id: uuid(8), title: "Why?" })).toEqual({
      type: "resolve",
      address: `memora://question/${uuid(8)}`
    });
    expect(navigationForPlacement({ kind: "note", id: uuid(9), title: "A note" })).toEqual({
      type: "resolve",
      address: `memora://note/${uuid(9)}`
    });
  });

  it("turns a located source into its chain and a located note into its source plus the note", () => {
    expect(navigationForLocated(located("source", path.slice(0, 3)))).toEqual({
      type: "source",
      path: [uuid(1), uuid(2), uuid(3)]
    });
    expect(navigationForLocated(located("note", path))).toEqual({
      type: "note",
      path: [uuid(1), uuid(2), uuid(3)],
      noteId: uuid(4)
    });
  });

  it("has nowhere to go for a note whose source is gone", () => {
    expect(navigationForLocated(located("note", [ref("note", 4)]))).toEqual({ type: "none" });
  });
});

describe("where a topic leads", () => {
  it("opens a topic placement, a topic segment of a path and a located topic as the topic itself", () => {
    expect(navigationForPlacement({ kind: "topic", id: uuid(7), title: "Learning" })).toEqual({
      type: "topic",
      topicId: uuid(7)
    });
    const path = [ref("topic", 20), ref("topic", 21), ref("note", 22)];
    expect(navigationForPathSegment(path, 0)).toEqual({ type: "topic", topicId: uuid(20) });
    expect(navigationForPathSegment(path, 1)).toEqual({ type: "topic", topicId: uuid(21) });
    expect(navigationForPathSegment(path, 2)).toEqual({ type: "none" });
    expect(navigationForPathSegment(path.slice(0, 2), 1)).toEqual({ type: "none" });
    expect(navigationForLocated(located("topic", path.slice(0, 2)))).toEqual({
      type: "topic",
      topicId: uuid(21)
    });
  });

  it("keeps the topics of a path out of the Library path of a source or a note", () => {
    const path = [
      ref("topic", 20, ""),
      ref("topic", 21),
      ref("source", 1),
      ref("source", 2),
      ref("note", 4)
    ];
    expect(navigationForPathSegment(path, 0)).toEqual({ type: "topic", topicId: uuid(20) });
    expect(navigationForPathSegment(path, 2)).toEqual({ type: "source", path: [uuid(1)] });
    expect(navigationForPathSegment(path, 3)).toEqual({
      type: "source",
      path: [uuid(1), uuid(2)]
    });
    expect(navigationForLocated(located("note", path))).toEqual({
      type: "note",
      path: [uuid(1), uuid(2)],
      noteId: uuid(4)
    });
    expect(navigationForLocated(located("source", path.slice(0, 4)))).toEqual({
      type: "source",
      path: [uuid(1), uuid(2)]
    });
    // A note the library no longer holds a source for, but the tree does, has no Library path.
    expect(navigationForLocated(located("note", [ref("topic", 20, ""), ref("note", 4)]))).toEqual({
      type: "none"
    });
  });

  it("opens a topic address as the topic and locates every other kind first", () => {
    expect(navigationForAddress(`memora://topic/${uuid(5).toUpperCase()}`)).toEqual({
      type: "topic",
      topicId: uuid(5)
    });
    expect(navigationForAddress(`memora://note/${uuid(6)}`)).toEqual({
      type: "resolve",
      address: `memora://note/${uuid(6)}`
    });
    expect(navigationForAddress(`memora://source/${uuid(6)}#passage=${uuid(8)}`)).toEqual({
      type: "resolve",
      address: `memora://source/${uuid(6)}#passage=${uuid(8)}`
    });
    expect(navigationForAddress("memora://topic/not-a-uuid")).toEqual({ type: "none" });
    expect(navigationForAddress("https://example.com")).toEqual({ type: "none" });
  });

  it("turns a source or a note navigation into the Library target in its source", () => {
    expect(libraryTargetForNavigation({ type: "source", path: [uuid(1), uuid(2)] })).toEqual({
      sourceItemId: uuid(2)
    });
    expect(
      libraryTargetForNavigation({ type: "note", path: [uuid(1), uuid(2)], noteId: uuid(3) })
    ).toEqual({ sourceItemId: uuid(2), atomicNoteId: uuid(3) });
    expect(libraryTargetForNavigation({ type: "source", path: [] })).toBeNull();
    expect(libraryTargetForNavigation({ type: "topic", topicId: uuid(4) })).toBeNull();
    expect(libraryTargetForNavigation({ type: "none" })).toBeNull();
  });
});
