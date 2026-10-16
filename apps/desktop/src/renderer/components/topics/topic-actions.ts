import { formatObjectAddress, type ObjectLocateResult } from "@app/domain";
import { navigationForLocated } from "../../lib/object-navigation";
import type { TopicNavigatorStore } from "./topic-navigator-store";
import { unsortedKey, type NavRow } from "./topic-navigation";

/** What a row's activation needs from the screen around the navigator. */
export interface RowActionDeps {
  store: Pick<
    TopicNavigatorStore,
    "expand" | "toggle" | "loadMoreTopics" | "loadMoreItems" | "retryBranch"
  >;
  /** The open topics (and the Unsorted group) as they are now. */
  expanded: ReadonlySet<string>;
  onOpenTopic: (id: string) => void;
  /** Opens a source in the Library; with a note ID, on that note. */
  onOpenSource: (sourceItemId: string, atomicNoteId?: string) => void;
  /** Finds the source a note belongs to and opens it there; may fail. */
  openNote: (noteId: string) => void;
  /** An interaction that opens a branch starts here (it is measured up to its paint). */
  startExpand: (topicId: string) => void;
  /** The last failure to open something is no longer news. */
  clearOpenFailure: () => void;
}

/** The chevron and the arrow keys: opens or closes a branch. Other rows have none. */
export function toggleRow(row: NavRow, deps: RowActionDeps): void {
  if (row.type !== "topic" && row.type !== "unsorted") return;
  if (row.type === "unsorted") return deps.store.toggle(unsortedKey);
  if (!deps.expanded.has(row.node.id)) deps.startExpand(row.node.id);
  deps.store.toggle(row.node.id);
}

/** A click, Enter or Space: opens what the row stands for. */
export function activateRow(row: NavRow, deps: RowActionDeps): void {
  switch (row.type) {
    case "topic":
      // Opening a topic also opens its branch, so its subtopics and leaves are one click away.
      if (!deps.expanded.has(row.node.id)) deps.startExpand(row.node.id);
      deps.store.expand(row.node.id);
      deps.onOpenTopic(row.node.id);
      return;
    case "unsorted":
      return toggleRow(row, deps);
    case "leaf":
      deps.clearOpenFailure();
      if (row.leaf.kind === "source") deps.onOpenSource(row.leaf.id);
      else deps.openNote(row.leaf.id);
      return;
    case "place":
      deps.clearOpenFailure();
      if (row.place.kind === "topic") deps.onOpenTopic(row.place.id);
      else if (row.place.source) {
        deps.onOpenSource(row.place.source.sourceItemId, row.place.source.atomicNoteId);
      }
      return;
    case "more":
      void (row.what === "topics"
        ? deps.store.loadMoreTopics(row.parentId)
        : deps.store.loadMoreItems(row.parentId));
      return;
    case "status":
      if (row.state === "error") deps.store.retryBranch(row.parentId);
      return;
  }
}

/** The source a located note opens in (the innermost of its source chain); null when it has none. */
export function owningSourceOf(located: ObjectLocateResult | null): string | null {
  const navigation = located ? navigationForLocated(located) : null;
  return navigation?.type === "note" ? (navigation.path.at(-1) ?? null) : null;
}

/**
 * The address of the source a note opens in, which the view history keeps as the note's host; null
 * when the note cannot be located (it was deleted) or `locate` fails.
 */
export async function noteHostAddress(
  locate: (input: { address: string }) => Promise<ObjectLocateResult | null>,
  noteId: string
): Promise<string | null> {
  try {
    const located = await locate({ address: formatObjectAddress({ kind: "note", id: noteId }) });
    const sourceId = owningSourceOf(located);
    return sourceId ? formatObjectAddress({ kind: "source", id: sourceId }) : null;
  } catch {
    return null;
  }
}
