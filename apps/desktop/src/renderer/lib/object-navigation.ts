import {
  formatObjectAddress,
  parseObjectAddress,
  type ObjectLocateResult,
  type ObjectPlacement,
  type ObjectRef
} from "@app/domain";

/**
 * Where a click on an object, a citation or a path segment leads. These functions only compute
 * targets; the views decide how to show them, so the computation is tested without a renderer.
 */

/** The passage a citation points at, inside a source. Every part may be unknown. */
export interface PassageAnchor {
  chunkId: string | null;
  sourceSpanId: string | null;
  documentId: string | null;
}

/** What the evidence behind a citation chip knows about its passage. */
export interface CitationEvidence {
  sourceItemId: string;
  chunkId?: string | null | undefined;
  sourceSpanId?: string | null | undefined;
  documentId?: string | null | undefined;
}

export interface CitationTarget {
  sourceItemId: string;
  passage: PassageAnchor;
  /** The same target as a stable object address, `memora://source/<id>#passage=<chunk>&span=<span>`. */
  address: string;
}

/** The source reader target of a citation: the source, the exact chunk and its SourceSpan. */
export function citationTarget(evidence: CitationEvidence): CitationTarget {
  const passage: PassageAnchor = {
    chunkId: evidence.chunkId ?? null,
    sourceSpanId: evidence.sourceSpanId ?? null,
    documentId: evidence.documentId ?? null
  };
  return {
    sourceItemId: evidence.sourceItemId,
    passage,
    address: formatObjectAddress({
      kind: "source",
      id: evidence.sourceItemId,
      anchor: {
        ...(passage.chunkId ? { passage: passage.chunkId } : {}),
        ...(passage.sourceSpanId ? { span: passage.sourceSpanId } : {})
      }
    })
  };
}

export interface ReaderChunk {
  id: string;
  chunkIndex: number;
  sourceSpanId: string | null;
  startOffset: number | null;
  endOffset: number | null;
  page: number | null;
}

export interface ReaderDocument {
  id: string;
  chunks: readonly ReaderChunk[];
}

export type ResolvedPassage =
  | {
      status: "found";
      documentId: string;
      chunkId: string;
      chunkIndex: number;
      sourceSpanId: string | null;
      page: number | null;
      /** Where the passage sits in the document Markdown, when its SourceSpan says so. */
      range: { start: number; end: number } | null;
    }
  | { status: "missing" };

/**
 * Finds the cited chunk among the current documents of a source: by chunk ID first, then by the
 * SourceSpan the chunk is made of. A passage of an earlier document version, or one that was
 * reprocessed away, is `missing`; it is never guessed from similar text.
 */
export function resolvePassage(
  documents: readonly ReaderDocument[],
  passage: PassageAnchor
): ResolvedPassage {
  for (const document of documents) {
    const chunk = document.chunks.find(
      (candidate) =>
        (passage.chunkId !== null && candidate.id === passage.chunkId) ||
        (passage.chunkId === null &&
          passage.sourceSpanId !== null &&
          candidate.sourceSpanId === passage.sourceSpanId)
    );
    if (!chunk) continue;
    const hasRange =
      chunk.startOffset !== null && chunk.endOffset !== null && chunk.endOffset > chunk.startOffset;
    return {
      status: "found",
      documentId: document.id,
      chunkId: chunk.id,
      chunkIndex: chunk.chunkIndex,
      sourceSpanId: chunk.sourceSpanId,
      page: chunk.page,
      range: hasRange ? { start: chunk.startOffset!, end: chunk.endOffset! } : null
    };
  }
  // A chunk ID that is gone may still be found through its span (the chunk was rebuilt in place).
  if (passage.chunkId !== null && passage.sourceSpanId !== null)
    return resolvePassage(documents, { ...passage, chunkId: null });
  return { status: "missing" };
}

/** Where an object leads inside the app. */
export type ObjectNavigation =
  /** A source of the Library, as the chain of source IDs from its root. */
  | { type: "source"; path: string[] }
  /** A note, shown in its owning source (the chain of source IDs from the root). */
  | { type: "note"; path: string[]; noteId: string }
  /** A legacy wiki page, opened in the Wiki. */
  | { type: "legacyPage"; pageId: string }
  /** A topic of the topic tree (`memora://topic/<id>`), opened in the Wiki. */
  | { type: "topic"; topicId: string }
  /** Needs `objects.locate` first: the target's own path decides where it opens. */
  | { type: "resolve"; address: string }
  /** The current object itself. */
  | { type: "none" };

const sourceIds = (path: readonly ObjectRef[]): string[] =>
  path.filter((item) => item.kind === "source").map((item) => item.id);

/**
 * A path segment: a source segment opens that source at its place in the hierarchy and a topic
 * segment opens that topic; the current object leads nowhere.
 */
export function navigationForPathSegment(
  path: readonly ObjectRef[],
  index: number
): ObjectNavigation {
  const segment = path[index];
  if (!segment || index === path.length - 1) return { type: "none" };
  if (segment.kind === "topic") return { type: "topic", topicId: segment.id };
  if (segment.kind !== "source") return { type: "none" };
  return { type: "source", path: sourceIds(path.slice(0, index + 1)) };
}

/**
 * An entry of "also in" or "cited by": legacy wiki pages open in the Wiki, a topic opens as itself
 * and the rest is located first.
 */
export function navigationForPlacement(placement: ObjectPlacement): ObjectNavigation {
  if (placement.legacy) return { type: "legacyPage", pageId: placement.id };
  if (placement.kind === "topic") return { type: "topic", topicId: placement.id };
  return {
    type: "resolve",
    address: formatObjectAddress({ kind: placement.kind, id: placement.id })
  };
}

/**
 * Where a located object opens: a source at its place in the hierarchy, a note in its source, a
 * topic as itself.
 */
export function navigationForLocated(result: ObjectLocateResult): ObjectNavigation {
  if (result.object.kind === "topic") return { type: "topic", topicId: result.object.id };
  const path = sourceIds(result.primaryPath);
  if (result.object.kind === "source")
    return path.length > 0 ? { type: "source", path } : { type: "none" };
  if (result.object.kind === "note")
    return path.length > 0 ? { type: "note", path, noteId: result.object.id } : { type: "none" };
  return { type: "none" };
}

/**
 * Where an object address leads: a topic opens as itself, anything else is located first, and
 * text that is not an object address leads nowhere.
 */
export function navigationForAddress(address: string): ObjectNavigation {
  const parsed = parseObjectAddress(address);
  if (!parsed) return { type: "none" };
  if (parsed.kind === "topic") return { type: "topic", topicId: parsed.id };
  return { type: "resolve", address: formatObjectAddress(parsed) };
}

/** The Library target of a navigation that ends in a source or a note; other navigations have none. */
export function libraryTargetForNavigation(
  navigation: ObjectNavigation
): { sourceItemId: string; atomicNoteId?: string } | null {
  if (navigation.type === "source") {
    const sourceItemId = navigation.path.at(-1);
    return sourceItemId ? { sourceItemId } : null;
  }
  if (navigation.type === "note") {
    const sourceItemId = navigation.path.at(-1);
    return sourceItemId ? { sourceItemId, atomicNoteId: navigation.noteId } : null;
  }
  return null;
}
