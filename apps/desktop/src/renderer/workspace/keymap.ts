import { destinationForDigit } from "./destinations";
import type { WorkspaceAction } from "./state";

/**
 * The workspace shortcuts (docs/f5-decisions.md D8) as a pure map from a key event to what it does.
 * The application menu carries the same accelerators; this map serves the renderer's own handling.
 *
 *   Cmd-1..5 destinations · Cmd-, Settings · Cmd-K palette · Cmd-N Add
 *   Cmd-[ / Cmd-] back and forward in the focused panel · Cmd-W close · Cmd-Shift-T reopen
 *   Cmd-\ navigator · Cmd-Shift-\ context panel · Ctrl-Tab / Ctrl-Shift-Tab panel focus
 *
 * Keys are read by physical position (`code`) when the event has one, so Shift and keyboard
 * layouts do not change them, and by `key` otherwise. "Cmd" is Meta on macOS and Ctrl elsewhere.
 */
export type WorkspaceCommand = { type: "openPalette" } | { type: "newImport" };
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
}

const codeKeys: Record<string, string> = {
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Comma: ",",
  KeyK: "k",
  KeyN: "n",
  KeyT: "t",
  KeyW: "w",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Tab: "tab"
};

/** What `key` names when `code` is absent; Shift turns `\` into `|`. */
const shiftedKeys: Record<string, string> = { "|": "\\" };

function keyName(event: KeyInput): string | null {
  if (event.code) return codeKeys[event.code] ?? null;
  const key = event.key.toLowerCase();
  return shiftedKeys[key] ?? key;
}

/** The action or command a key event triggers, or null when it is not a workspace shortcut. */
export function keymap(event: KeyInput, platform: "mac" | "other" = "mac"): KeymapResult | null {
  if (event.isComposing || event.altKey) return null;
  const name = keyName(event);
  if (name === null) return null;

  if (name === "tab") {
    if (!event.ctrlKey || event.metaKey) return null;
    return { type: "focusNext", delta: event.shiftKey ? -1 : 1 };
  }

  const command = platform === "mac" ? event.metaKey : event.ctrlKey;
  const other = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (!command || other) return null;

  if (event.shiftKey) {
    if (name === "t") return { type: "reopen" };
    if (name === "\\") return { type: "toggleContext" };
    return null;
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
