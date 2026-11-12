import type { InboxItem, InboxVerb } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import { isInsideDialog, isTypingTarget, type KeyTarget } from "../topics/ops/notice-key";
import { keyCarries } from "./inbox-state";

/**
 * The Inbox's keyboard (F5 D34, which replaces F4 D29's key list): `j`, `k` and the arrows move,
 * `Enter` opens the item's detail, `a` applies a structure change or keeps a connection, Backspace
 * removes a connection (the verdict that rejects it, so the decider never suggests it again), `x`
 * only dismisses (the item leaves the Inbox and nothing changes), `e` edits the names of a
 * proposal before it is applied where the writer allows, `r` retries, `u` undoes the last verb and
 * `?` shows the keys. A single key is only a command when nothing is being typed, no dialog has the
 * keyboard and no modifier is held; the arrows, Home and End belong to the list alone, so a chart or
 * a table in the detail keeps its own, and no key but Escape and `?` is the Inbox's inside the icicle
 * diff. Duck-typed so the rules are tested without a DOM.
 */

/** What a key asks for: `remove` and `edit` are keys of their own, `dismiss` is `x`. */
export type InboxVerbCommand = "apply" | "dismiss" | "remove" | "edit" | "retry";

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
/** The icicle diff of the detail (T95): its keys are its own. */
const icicleSelector = "[data-icicle-diff]";

function closest(target: KeyTarget | EventTarget | null, selector: string): boolean {
  const element = target as KeyTarget | null;
  return Boolean(element && typeof element.closest === "function" && element.closest(selector));
}

const letters: Readonly<Record<string, InboxCommand>> = {
  j: { type: "move", delta: 1 },
  k: { type: "move", delta: -1 },
  a: { type: "verb", verb: "apply" },
  x: { type: "verb", verb: "dismiss" },
  e: { type: "verb", verb: "edit" },
  r: { type: "verb", verb: "retry" },
  u: { type: "undo" }
};

/**
 * Whether the item is a verdict on a connection between two notes: its `dismiss` verb is the
 * `relations.review` remove verdict (status rejected), which changes something. A Divergence an
 * overview patch kept is a finding, not a connection, and dismissing it changes nothing.
 */
export function isConnection(item: Pick<InboxItem, "kind" | "variant">): boolean {
  return (
    item.kind === "suggestion" ||
    item.kind === "withdrawn" ||
    (item.kind === "contradiction" && item.variant !== "divergence")
  );
}

/**
 * Whether the structure writer lets a proposal's names be edited before it is applied. It does
 * not: `topics.review` and `changes.review` take only the verdict (checked in T142, the [I] of D34),
 * so `e` is not offered and the key sheet leaves it out until a writer gives it a place to write.
 */
export const structureWriterRenames = false;

/** Whether `e` is offered for the item: a structure proposal, where the writer renames. */
export function namesEditable(item: Pick<InboxItem, "kind">): boolean {
  return structureWriterRenames && item.kind === "review";
}

/**
 * The `inbox.act` verb a key carries out on an item, or null when the key is not offered there:
 * `a` is the item's apply verb; Backspace is its dismiss verb on a connection (the removal) and
 * nothing elsewhere; `x` is its dismiss verb only where that changes nothing (never on a
 * connection); `r` retries where retry is offered; `e` is never a verb (it opens the names).
 */
export function verbForKey(
  item: Pick<InboxItem, "kind" | "variant" | "actions">,
  key: InboxVerbCommand
): InboxVerb | null {
  switch (key) {
    case "apply":
      return keyCarries(item as InboxItem, "apply") ? "apply" : null;
    case "retry":
      return item.actions.includes("retry") ? "retry" : null;
    case "remove":
      return isConnection(item) && item.actions.includes("dismiss") ? "dismiss" : null;
    case "dismiss":
      return !isConnection(item) && item.actions.includes("dismiss") ? "dismiss" : null;
    case "edit":
      return null;
  }
}

/** The key that carries a verb out on an item, as it is drawn and as `aria-keyshortcuts` says it. */
export function keyHint(
  item: Pick<InboxItem, "kind" | "variant" | "actions">,
  verb: InboxVerb
): { label: string; shortcut: string } | null {
  if (verb === "apply") return verbForKey(item, "apply") ? { label: "A", shortcut: "A" } : null;
  if (verb === "retry") return verbForKey(item, "retry") ? { label: "R", shortcut: "R" } : null;
  if (verbForKey(item, "remove")) return { label: "⌫", shortcut: "Backspace" };
  return verbForKey(item, "dismiss") ? { label: "X", shortcut: "X" } : null;
}

/** One row of the `?` sheet: the keys as drawn and what they do. */
export interface InboxKeyRow {
  keys: readonly string[];
  label: MessageKey;
}

/**
 * The rows of the `?` sheet for the selected item (all but the keys it does not offer when none is
 * selected): moving, opening, apply, remove, dismiss and edit only where they are offered, retry
 * where it is, undo and the sheet itself.
 */
export function keyRows(
  item: Pick<InboxItem, "kind" | "variant" | "actions"> | null
): InboxKeyRow[] {
  const offered = (key: InboxVerbCommand): boolean =>
    item === null ? key !== "edit" : keyOffered(item, key);
  const rows: InboxKeyRow[] = [
    { keys: ["J", "K"], label: "inbox.keys.move" },
    { keys: ["Enter"], label: "inbox.keys.open" }
  ];
  if (offered("apply")) rows.push({ keys: ["A"], label: "inbox.keys.apply" });
  if (offered("remove")) rows.push({ keys: ["⌫"], label: "inbox.keys.remove" });
  if (offered("dismiss")) rows.push({ keys: ["X"], label: "inbox.keys.dismiss" });
  if (offered("edit")) rows.push({ keys: ["E"], label: "inbox.keys.edit" });
  if (offered("retry")) rows.push({ keys: ["R"], label: "inbox.keys.retry" });
  rows.push({ keys: ["U"], label: "inbox.keys.undo" }, { keys: ["?"], label: "inbox.keys.help" });
  return rows;
}

function keyOffered(
  item: Pick<InboxItem, "kind" | "variant" | "actions">,
  key: InboxVerbCommand
): boolean {
  return key === "edit" ? namesEditable(item) : verbForKey(item, key) !== null;
}

/**
 * Whether the screen takes the focus back after a render: the keyboard was on it and the element
 * that held the focus went away with that render (the last item was decided, a filter or a retry
 * reloaded the list, a verb button was disabled while it worked), which leaves the focus on the
 * page's body, where no key reaches the screen. Focus moved anywhere else is never taken.
 */
export function reclaimsFocus(input: {
  active: boolean;
  keyboardHere: boolean;
  focused: unknown;
  body: unknown;
}): boolean {
  return (
    input.active &&
    input.keyboardHere &&
    (input.focused === null || input.focused === undefined || input.focused === input.body)
  );
}

/** What a key press asks of the Inbox, or null when it is not for it. */
export function inboxCommand(event: InboxKeyEvent): InboxCommand | null {
  if (event.defaultPrevented) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target) || isInsideDialog(event.target)) return null;
  const { key } = event;
  // Inside the icicles the arrows, Home, End, Enter and Space move and select; a letter there is
  // not the Inbox's either. Escape still goes back to the list, and `?` shows the keys.
  if (closest(event.target, icicleSelector) && key !== "Escape" && key !== "?") return null;
  if (key === "?") return { type: "help" };
  if (key === "Escape") return event.shiftKey ? null : { type: "escape" };
  // Backspace removes a connection; a held key never repeats it.
  if (key === "Backspace")
    return event.shiftKey || event.repeat ? null : { type: "verb", verb: "remove" };
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
