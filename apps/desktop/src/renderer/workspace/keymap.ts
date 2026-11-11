import { destinationForDigit } from "./destinations";
import { contextTabIds, type ContextTabId, type WorkspaceAction } from "./state";

/**
 * The workspace shortcuts (docs/f5-decisions.md D8, D15; design record §12) as a pure map from a key
 * event to what it does. The application menu carries the same accelerators; this map serves the
 * renderer's own handling.
 *
 *   Cmd-1..5 destinations · Cmd-, Settings · Cmd-K palette · Cmd-N Add · Cmd-Y quick-look
 *   Cmd-[ / Cmd-] back and forward in the focused panel (Cmd-Shift-[ / ] too) · Cmd-W close
 *   Cmd-Shift-T reopen · Cmd-\ navigator · Cmd-Shift-\ context panel · Cmd-Shift-F focus mode
 *   Ctrl-Tab / Ctrl-Shift-Tab panel focus · F6 / Shift-F6 regions
 *   Option-1..6 context tabs in A5's order, never in a text field or editor
 *
 * Digits, symbols and F6 are read by physical position (`code`), so Shift, Option and keyboard
 * layouts (ABNT2 included) do not change them; letters are read by character, falling back to
 * `code` when the layout types no Latin letter. "Cmd" is Meta on macOS and Ctrl elsewhere. There is
 * no Option-Arrow shortcut (`rules/frontend.md`): hoist is a menu command and a Cmd-K action.
 */
export type WorkspaceCommand =
  | { type: "openPalette" }
  | { type: "newImport" }
  | { type: "quickLook" }
  | { type: "toggleFocusMode" }
  | { type: "cycleRegion"; delta: 1 | -1 }
  | { type: "contextTab"; tab: ContextTabId };
export type KeymapResult = WorkspaceAction | WorkspaceCommand;

/** The part of a KeyboardEvent the keymap reads. */
export interface KeyInput {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  /** The event's target takes text: an input, a textarea, contenteditable or an editor. */
  editable?: boolean;
}

const codeKeys: Record<string, string> = {
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Comma: ",",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Tab: "tab",
  F6: "f6"
};

/** What `key` names when `code` is absent; Shift turns `\` into `|` and the brackets into braces. */
const shiftedKeys: Record<string, string> = { "|": "\\", "{": "[", "}": "]" };

function keyName(event: KeyInput): string | null {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  if (event.code) {
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
    return letter ? letter.toLowerCase() : (codeKeys[event.code] ?? null);
  }
  return shiftedKeys[key] ?? key;
}

/** The action or command a key event triggers, or null when it is not a workspace shortcut. */
export function keymap(event: KeyInput, platform: "mac" | "other" = "mac"): KeymapResult | null {
  if (event.isComposing) return null;
  const name = keyName(event);
  if (name === null) return null;

  if (name === "f6") {
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    return { type: "cycleRegion", delta: event.shiftKey ? -1 : 1 };
  }

  if (name === "tab") {
    if (!event.ctrlKey || event.metaKey || event.altKey) return null;
    return { type: "focusNext", delta: event.shiftKey ? -1 : 1 };
  }

  if (event.altKey) {
    // Option-1..6 by physical key only: on ABNT2 and US layouts Option-digit types a character.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.editable) return null;
    const digit = event.code ? /^Digit([1-6])$/.exec(event.code)?.[1] : undefined;
    const tab = digit ? contextTabIds[Number(digit) - 1] : undefined;
    return tab ? { type: "contextTab", tab } : null;
  }

  const command = platform === "mac" ? event.metaKey : event.ctrlKey;
  const other = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (!command || other) return null;

  if (event.shiftKey) {
    switch (name) {
      case "t":
        return { type: "reopen" };
      case "\\":
        return { type: "toggleContext" };
      case "f":
        return { type: "toggleFocusMode" };
      // Where a layout puts the brackets behind Shift or Option (design record §12).
      case "[":
        return { type: "back" };
      case "]":
        return { type: "forward" };
      default:
        return null;
    }
  }

  const destination = /^[1-5]$/.test(name) ? destinationForDigit(Number(name)) : null;
  if (destination) return { type: "go", destination };
  switch (name) {
    case ",":
      return { type: "go", destination: "settings" };
    case "k":
      return { type: "openPalette" };
    case "n":
      return { type: "newImport" };
    case "y":
      return { type: "quickLook" };
    case "[":
      return { type: "back" };
    case "]":
      return { type: "forward" };
    case "w":
      return { type: "close" };
    case "\\":
      return { type: "toggleNavigator" };
    default:
      return null;
  }
}
