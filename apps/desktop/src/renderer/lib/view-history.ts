import {
  formatObjectAddress,
  parseObjectAddress,
  type ObjectKind,
  type ViewHistoryEntry,
  type ViewHistoryRecordInput
} from "../../shared/view-history";

/**
 * The renderer side of the local view history. Recording is best effort: an open is never delayed
 * or failed because the history could not be written.
 */
export function recordView(input: ViewHistoryRecordInput): void {
  try {
    void window.app.viewHistory.record(input).catch(() => undefined);
  } catch {
    /* The history is a convenience; the view that was opened is unaffected. */
  }
}

/** The kinds the Library can open today; the recents list asks for these only. */
export const recentKinds: readonly ObjectKind[] = ["source", "note"];
export const recentsListSize = 10;

export interface OpenedObject {
  kind: ObjectKind;
  id: string;
  title: string;
  parentAddress?: string;
}

const openKey = (object: OpenedObject) => formatObjectAddress(object.kind, object.id);

/**
 * Which of the objects on screen are new opens. A view that stays on screen (or is only hidden and
 * shown again) is one open; closing it and opening it again is another. `null` means the objects
 * cannot be told (the view is hidden): nothing is recorded and the memory is kept.
 */
export function viewsToRecord(
  shown: readonly OpenedObject[] | null,
  recorded: ReadonlySet<string>
): { record: OpenedObject[]; recorded: ReadonlySet<string> } {
  if (shown === null) return { record: [], recorded };
  return {
    record: shown.filter((object) => !recorded.has(openKey(object))),
    recorded: new Set(shown.map(openKey))
  };
}

/** What the Library opens for a recent entry: a source, and the note in it when it is one. */
export interface RecentTarget {
  sourceItemId: string;
  atomicNoteId?: string;
}

/** Where a recent entry leads in the Library, or `null` when the Library cannot open it. */
export function recentOpenTarget(
  entry: Pick<ViewHistoryEntry, "kind" | "id" | "parentAddress">
): RecentTarget | null {
  if (entry.kind === "source") return { sourceItemId: entry.id };
  if (entry.kind !== "note" || !entry.parentAddress) return null;
  const host = parseObjectAddress(entry.parentAddress);
  return host?.kind === "source" ? { sourceItemId: host.id, atomicNoteId: entry.id } : null;
}

/**
 * The objects the Library shows for the source that is open: the source, and the note that is
 * focused in it (recorded with its source as host, so it can be opened again from there).
 */
export function openedLibraryObjects(
  source: {
    id: string;
    title: string;
    atomicNotes: ReadonlyArray<{ id: string; title: string }>;
  } | null,
  focusedNoteId: string | null
): OpenedObject[] {
  if (!source) return [];
  const objects: OpenedObject[] = [{ kind: "source", id: source.id, title: source.title }];
  const note = focusedNoteId ? source.atomicNotes.find((item) => item.id === focusedNoteId) : null;
  if (note)
    objects.push({
      kind: "note",
      id: note.id,
      title: note.title,
      parentAddress: formatObjectAddress("source", source.id)
    });
  return objects;
}
