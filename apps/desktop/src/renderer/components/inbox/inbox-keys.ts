import { isInsideDialog, isTypingTarget, type KeyTarget } from "../topics/ops/notice-key";

/**
 * The Inbox's keyboard (F4 D29): `j` and `k` move, `Enter` opens the item's detail, `a` applies or
 * keeps, `x` dismisses or removes, `r` retries, `u` undoes the last verb and `?` shows the keys.
 * A single key is only a command when nothing is being typed, no dialog has the keyboard and no
 * modifier is held; the arrows, Home and End belong to the list alone, so a chart or a table in
 * the detail keeps its own. Duck-typed so the rules are tested without a DOM.
 */

export type InboxVerbCommand = "apply" | "dismiss" | "retry";

export type InboxCommand =
  | { type: "move"; delta: 1 | -1 }
  | { type: "edge"; to: "first" | "last" }
  | { type: "open" }
  | { type: "verb"; verb: InboxVerbCommand }
  | { type: "undo" }
  | { type: "help" }
  | { type: "escape" };

export interface InboxKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  target: KeyTarget | EventTarget | null;
}

/** Elements that act on Enter and Space themselves. */
const activatable = 'button, a[href], summary, [role="button"], [role="tab"], [role="link"]';
const listSelector = '[role="listbox"]';

function closest(target: KeyTarget | EventTarget | null, selector: string): boolean {
  const element = target as KeyTarget | null;
  return Boolean(element && typeof element.closest === "function" && element.closest(selector));
}

const letters: Readonly<Record<string, InboxCommand>> = {
  j: { type: "move", delta: 1 },
  k: { type: "move", delta: -1 },
  a: { type: "verb", verb: "apply" },
  x: { type: "verb", verb: "dismiss" },
  r: { type: "verb", verb: "retry" },
  u: { type: "undo" }
};

/** What a key press asks of the Inbox, or null when it is not for it. */
export function inboxCommand(event: InboxKeyEvent): InboxCommand | null {
  if (event.defaultPrevented) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target) || isInsideDialog(event.target)) return null;
  const { key } = event;
  if (key === "?") return { type: "help" };
  if (key === "Escape") return event.shiftKey ? null : { type: "escape" };
  if (key === "Enter") {
    // On a button or a link Enter is theirs; on the list it opens the detail.
    return event.shiftKey || event.repeat || closest(event.target, activatable)
      ? null
      : { type: "open" };
  }
  if (event.shiftKey) return null;
  if (closest(event.target, listSelector)) {
    if (key === "ArrowDown") return { type: "move", delta: 1 };
    if (key === "ArrowUp") return { type: "move", delta: -1 };
    if (key === "Home") return { type: "edge", to: "first" };
    if (key === "End") return { type: "edge", to: "last" };
  }
  const command = letters[key.toLowerCase()];
  if (!command || key.length !== 1) return null;
  // Moving may repeat while the key is held; a verb or an undo never does.
  if (event.repeat && command.type !== "move") return null;
  return command;
}
