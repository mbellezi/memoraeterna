import { parseObjectAddress } from "@app/domain";

import { keymap, type KeyInput } from "./keymap";

/**
 * Quick-look's rules (D15 as amended by A4; design record §10.2) as plain functions and one small
 * store, so the keys can be proven without a browser. Any row or link that can be peeked at carries
 * `data-quick-look="<object address>"`; the keyboard stays on that row while the sheet is open, so
 * "the row" is always the focused element, the row its `aria-activedescendant` names (Cmd-K keeps
 * focus in its input) or, for Cmd-Y and the arrows, the shown row marked selected.
 *
 *  - Space on a row, outside text fields, opens the sheet; Space again closes it.
 *  - Cmd-Y opens or closes it from anywhere, text fields and Cmd-K included.
 *  - ↑ and ↓ are the list's own keys: the sheet only follows the row the list moved to.
 *  - Enter acts on the row (the list opens it beside, Option-Enter in this panel), and the sheet,
 *    which stays a peek, closes after it. Esc and a click outside close it (the sheet's primitive).
 */

/** The attribute a peekable row or link carries. */
export const quickLookAttribute = "data-quick-look";

/** What a key does to quick-look, or null when it is not a quick-look key in this state. */
export type QuickLookKeyAction =
  "toggle" | "open-from-row" | "close" | "follow" | "close-after-enter" | null;

/** The part of a keyboard event the model reads: the keymap's, plus whether the sheet is open. */
export type QuickLookKey = KeyInput;

/** Cmd-Y (Ctrl-Y elsewhere) comes from the keymap; the rest is local to the sheet. */
export function quickLookKey(
  event: QuickLookKey,
  open: boolean,
  platform: "mac" | "other" = "mac"
): QuickLookKeyAction {
  if (event.isComposing) return null;
  if (keymap(event, platform)?.type === "quickLook") return "toggle";
  const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  if (event.key === " " || event.code === "Space") {
    // A space in a text field is a space. A modified space belongs to the system.
    if (!plain || event.editable) return null;
    return open ? "close" : "open-from-row";
  }
  if (!open) return null;
  // The arrows are the list's own keys (in Cmd-K, the input's, which drive its list); the sheet
  // only follows the row the list moved to. Enter acts on the row and the peek ends.
  if (event.key === "ArrowUp" || event.key === "ArrowDown") return "follow";
  if (event.key === "Enter") return "close-after-enter";
  return null;
}

/** The part of a document the target lookup reads (a real `Document` fits). */
export interface RowLookup {
  activeElement: Element | null;
  getElementById(id: string): Element | null;
  querySelectorAll(selector: string): Iterable<Element>;
}

const peekableSelector = `[${quickLookAttribute}]`;
const selectedSelector = `${peekableSelector}[aria-selected="true"], ${peekableSelector}[data-selected="true"]`;
/** A destination that is not shown stays mounted: its selected row is not a row to peek at. */
const unseenSelector = "[hidden], [inert]";

/** The address a row names, or null for a row with no valid object address. */
function addressOfRow(row: Element | null | undefined): string | null {
  const value = row?.closest(peekableSelector)?.getAttribute(quickLookAttribute) ?? null;
  return value !== null && parseObjectAddress(value) !== null ? value : null;
}

/**
 * The address to peek at: the focused element's row, else the row the focused element points at
 * (`aria-activedescendant`, which a combobox such as Cmd-K's input uses), else, when `selected` is
 * allowed, the first shown row marked selected. Null when no row qualifies. Space does not allow
 * the selected row: it is a plain key, and the focus may be on something else entirely (a button,
 * a switch), which must keep its Space.
 */
export function quickLookTarget(doc: RowLookup, selected = true): string | null {
  const active = doc.activeElement;
  const own = addressOfRow(active);
  if (own !== null) return own;
  const pointed = active?.getAttribute("aria-activedescendant");
  if (pointed) {
    const row = addressOfRow(doc.getElementById(pointed));
    if (row !== null) return row;
  }
  if (!selected) return null;
  for (const row of doc.querySelectorAll(selectedSelector)) {
    if (row.closest(unseenSelector) !== null) continue;
    const address = addressOfRow(row);
    if (address !== null) return address;
  }
  return null;
}

/** Whether a keyboard event's target takes text: an input, a textarea, a select or an editor. */
export function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
      type
    );
  }
  const editable = (element as HTMLElement).isContentEditable;
  return editable === true || element.getAttribute("contenteditable") === "true";
}

// ---------------------------------------------------------------------------------------------
// The store: which address the sheet shows, or none.

type Listener = () => void;

export interface QuickLookStore {
  get(): string | null;
  subscribe(listener: Listener): () => void;
  open(address: string): void;
  close(): void;
  /** Closes an open sheet; otherwise opens the sheet for `address`, when there is one. */
  toggle(address: string | null): void;
}

export function createQuickLookStore(): QuickLookStore {
  let current: string | null = null;
  const listeners = new Set<Listener>();
  const set = (next: string | null) => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(address) {
      if (parseObjectAddress(address) !== null) set(address);
    },
    close: () => set(null),
    toggle(address) {
      if (current !== null) set(null);
      else if (address !== null) set(address);
    }
  };
}

/** The sheet the app shows: Cmd-Y, Space, the palette and the lists all reach this one. */
export const quickLook: QuickLookStore = createQuickLookStore();

/** Cmd-Y from anywhere (the keymap's `quickLook` command): closes the sheet or peeks at the row. */
export function toggleQuickLook(
  doc: RowLookup = document,
  store: QuickLookStore = quickLook
): void {
  store.toggle(store.get() === null ? quickLookTarget(doc) : null);
}
