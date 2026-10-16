/**
 * When the U key undoes the notice that follows a change (docs F2 T26): from anywhere in the
 * window, but never while the person is typing, never from inside a dialog (it has the window) and
 * never with a modifier. Duck-typed so it is tested without a DOM.
 */

/** What the rule reads of an event target; a DOM element has all of it. */
export interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

export interface UndoKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  target: KeyTarget | EventTarget | null;
}

const typingTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const dialogSelector = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** True when a key press is being typed into something, where single keys are text. */
export function isTypingTarget(target: KeyTarget | EventTarget | null): boolean {
  const element = target as KeyTarget | null;
  if (!element || typeof element !== "object") return false;
  return element.isContentEditable === true || typingTags.has(element.tagName ?? "");
}

/** True when the target is inside a dialog, which owns the keyboard while it is open. */
export function isInsideDialog(target: KeyTarget | EventTarget | null): boolean {
  const element = target as KeyTarget | null;
  if (!element || typeof element.closest !== "function") return false;
  return element.closest(dialogSelector) !== null;
}

/** Whether this key press is the request to undo the notice on screen. */
export function isUndoKey(event: UndoKeyEvent): boolean {
  if (event.key.toLowerCase() !== "u") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.defaultPrevented || event.repeat) return false;
  return !isTypingTarget(event.target) && !isInsideDialog(event.target);
}
