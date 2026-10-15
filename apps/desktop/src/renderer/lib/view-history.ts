import { formatObjectAddress, parseObjectAddress, type ObjectKind } from "@app/domain";
import {
  viewHistoryBounds,
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
/** Recent (unpinned) entries the list asks for; every pin (at most `pinMax`) comes besides them. */
export const recentsListSize = 10;

export interface OpenedObject {
  kind: ObjectKind;
  id: string;
  title: string;
  parentAddress?: string;
}

const openKey = (object: OpenedObject) => formatObjectAddress({ kind: object.kind, id: object.id });

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
 * The objects the Library shows for the source that is open: the source. A note opened as a page
 * records itself, with its source as host, so it can be opened again from there.
 */
export function openedLibraryObjects(source: { id: string; title: string } | null): OpenedObject[] {
  return source ? [{ kind: "source", id: source.id, title: source.title }] : [];
}

/** Where keyboard focus goes in the Recents list when an action removes the control that had it. */
export type RecentsFocus =
  | { target: "clear-confirmation" }
  | { target: "clear-button" }
  | { target: "title" }
  | { target: "pin"; address: string };

export interface Focusable {
  focus(): void;
}

/**
 * Moves focus to the requested control, or to the list title when that control is gone (the Clear
 * button once nothing is left to clear, a pin whose entry left the list). Resolves with whether
 * anything took focus. `find` looks a control up in the rendered list.
 */
export function applyRecentsFocus(
  request: RecentsFocus,
  find: (target: RecentsFocus) => Focusable | null
): boolean {
  const candidates: RecentsFocus[] =
    request.target === "pin" || request.target === "clear-button"
      ? [request, { target: "title" }]
      : [request];
  for (const candidate of candidates) {
    const element = find(candidate);
    if (element) {
      element.focus();
      return true;
    }
  }
  return false;
}

/**
 * The list in two groups. Pins and recents have slots of their own, so a full set of pins never
 * hides the recents; once every pin slot is taken no other entry can be pinned until one is freed.
 */
export function groupRecents(entries: readonly ViewHistoryEntry[]) {
  const pinned = entries.filter((entry) => entry.pinned);
  return {
    pinned,
    recent: entries.filter((entry) => !entry.pinned),
    pinsFull: pinned.length >= viewHistoryBounds.pinMax
  };
}
