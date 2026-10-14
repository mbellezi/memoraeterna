/**
 * Views that stay mounted while hidden (Library, Wiki) load nothing and hold no modal while they
 * are hidden. These are the decisions they share when they are shown again.
 */

/** What the last load of a view found, keyed by everything that selects what it shows. */
export interface LoadOutcome {
  key: string;
  ok: boolean;
  /** Whether the successful load found anything to show. */
  hasData: boolean;
}

/**
 * A refresh after the view was hidden may keep showing what is already there only when the key is
 * unchanged and the previous load succeeded. Anything else is a normal load with a loading state.
 */
export function isSilentRefresh(
  wasHidden: boolean,
  previous: LoadOutcome | null,
  key: string
): boolean {
  return wasHidden && previous !== null && previous.ok && previous.key === key;
}

/**
 * A failed load is always visible, except a silent one that has the previous result to keep
 * showing. With no data, or with a key that changed, the failure must surface so it can be retried.
 */
export function showsLoadError(input: {
  silent: boolean;
  previous: LoadOutcome | null;
  key: string;
}): boolean {
  const { silent, previous, key } = input;
  return !silent || previous === null || !previous.ok || previous.key !== key || !previous.hasData;
}

export type ModalDialog = Pick<HTMLDialogElement, "open" | "showModal" | "close">;

/**
 * Opens or closes a modal dialog to match whether it is wanted. A modal dialog left open inside a
 * hidden view keeps the rest of the document inert, so a hidden view always closes its dialogs
 * (keeping their state) and opens them again when it is shown.
 */
export function syncModalDialog(dialog: ModalDialog | null | undefined, wanted: boolean): void {
  if (!dialog) return;
  if (wanted && !dialog.open) dialog.showModal();
  else if (!wanted && dialog.open) dialog.close();
}
