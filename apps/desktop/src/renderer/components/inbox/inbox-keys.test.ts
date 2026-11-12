import { describe, expect, it } from "vitest";

import { inboxKinds, type InboxItem } from "@app/domain";

import { item } from "./inbox-fixtures";
import {
  inboxCommand,
  isConnection,
  keyHint,
  keyRows,
  namesEditable,
  reclaimsFocus,
  verbForKey,
  type InboxKeyEvent
} from "./inbox-keys";

/** A target that answers `closest` the way a DOM element does, for the selectors the rules ask. */
const target = (
  options: { tagName?: string; editable?: boolean; inside?: readonly string[] } = {}
) => ({
  tagName: options.tagName ?? "DIV",
  isContentEditable: options.editable ?? false,
  closest: (selector: string) =>
    (options.inside ?? []).some((role) => selector.includes(role)) ? {} : null
});

const press = (key: string, extra: Partial<InboxKeyEvent> = {}): InboxKeyEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  repeat: false,
  target: target(),
  ...extra
});

describe("the Inbox keys", () => {
  it("maps each key of D34 to its command", () => {
    expect(inboxCommand(press("j"))).toEqual({ type: "move", delta: 1 });
    expect(inboxCommand(press("k"))).toEqual({ type: "move", delta: -1 });
    expect(inboxCommand(press("a"))).toEqual({ type: "verb", verb: "apply" });
    expect(inboxCommand(press("x"))).toEqual({ type: "verb", verb: "dismiss" });
    expect(inboxCommand(press("Backspace"))).toEqual({ type: "verb", verb: "remove" });
    expect(inboxCommand(press("e"))).toEqual({ type: "verb", verb: "edit" });
    expect(inboxCommand(press("r"))).toEqual({ type: "verb", verb: "retry" });
    expect(inboxCommand(press("u"))).toEqual({ type: "undo" });
    expect(inboxCommand(press("Enter"))).toEqual({ type: "open" });
    expect(inboxCommand(press("Escape"))).toEqual({ type: "escape" });
    expect(inboxCommand(press("?", { shiftKey: true }))).toEqual({ type: "help" });
  });

  it("leaves the icicle diff its own keys: only Escape and ? are the Inbox's there", () => {
    const icicle = target({ tagName: "BUTTON", inside: ["data-icicle-diff", "button"] });
    for (const key of [
      "j",
      "k",
      "a",
      "x",
      "e",
      "r",
      "u",
      "Backspace",
      "Enter",
      " ",
      "ArrowDown",
      "Home",
      "End"
    ])
      expect(inboxCommand(press(key, { target: icicle })), key).toBeNull();
    expect(inboxCommand(press("Escape", { target: icicle }))).toEqual({ type: "escape" });
    expect(inboxCommand(press("?", { target: icicle, shiftKey: true }))).toEqual({ type: "help" });
    // Outside it, a button of the detail still hears the letters.
    const verb = target({ tagName: "BUTTON", inside: ["button"] });
    expect(inboxCommand(press("a", { target: verb }))).toEqual({ type: "verb", verb: "apply" });
  });

  it("reads a capital letter (caps lock) as the letter", () => {
    expect(inboxCommand(press("A"))).toEqual({ type: "verb", verb: "apply" });
    expect(inboxCommand(press("J"))).toEqual({ type: "move", delta: 1 });
  });

  it("ignores every other key", () => {
    for (const key of ["b", "z", "1", " ", "Tab", "Delete", "jj", "F5"])
      expect(inboxCommand(press(key)), key).toBeNull();
  });

  it("never fires while the person types", () => {
    const typing = [
      target({ tagName: "INPUT" }),
      target({ tagName: "TEXTAREA" }),
      target({ tagName: "SELECT" }),
      target({ editable: true })
    ];
    for (const key of ["j", "k", "a", "x", "e", "r", "u", "Backspace", "?", "Enter", "Escape"])
      for (const element of typing)
        expect(
          inboxCommand(press(key, { target: element })),
          `${key} ${element.tagName}`
        ).toBeNull();
  });

  it("never fires inside a dialog, which has the keyboard", () => {
    const inDialog = target({ inside: ['[role="dialog"]'] });
    for (const key of ["j", "a", "x", "u", "?", "Escape"])
      expect(inboxCommand(press(key, { target: inDialog })), key).toBeNull();
  });

  it("leaves a key with a platform or editing modifier alone", () => {
    for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const)
      for (const key of ["j", "a", "x", "e", "r", "u", "Backspace", "Enter", "?"])
        expect(inboxCommand(press(key, { [modifier]: true })), `${modifier} ${key}`).toBeNull();
  });

  it("does not take a key another handler already used", () => {
    expect(inboxCommand(press("u", { defaultPrevented: true }))).toBeNull();
  });

  it("lets a held key move but never repeat a verb or an undo", () => {
    expect(inboxCommand(press("j", { repeat: true }))).toEqual({ type: "move", delta: 1 });
    for (const key of ["a", "x", "e", "r", "u", "Backspace", "Enter"])
      expect(inboxCommand(press(key, { repeat: true })), key).toBeNull();
  });

  it("leaves Enter to a button or a link, and opens the detail from the list", () => {
    expect(
      inboxCommand(press("Enter", { target: target({ tagName: "BUTTON", inside: ["button"] }) }))
    ).toBeNull();
    expect(inboxCommand(press("Enter", { target: target({ inside: ["a[href]"] }) }))).toBeNull();
    expect(
      inboxCommand(press("Enter", { target: target({ inside: ['[role="listbox"]'] }) }))
    ).toEqual({
      type: "open"
    });
  });

  it("gives the arrows, Home and End to the list alone", () => {
    const list = target({ inside: ['[role="listbox"]'] });
    expect(inboxCommand(press("ArrowDown", { target: list }))).toEqual({ type: "move", delta: 1 });
    expect(inboxCommand(press("ArrowUp", { target: list }))).toEqual({ type: "move", delta: -1 });
    expect(inboxCommand(press("Home", { target: list }))).toEqual({ type: "edge", to: "first" });
    expect(inboxCommand(press("End", { target: list }))).toEqual({ type: "edge", to: "last" });
    // A chart or a table in the detail keeps its own arrows.
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"])
      expect(inboxCommand(press(key)), key).toBeNull();
  });

  it("does not read a shifted letter as a command", () => {
    expect(inboxCommand(press("a", { shiftKey: true }))).toBeNull();
    expect(inboxCommand(press("Enter", { shiftKey: true }))).toBeNull();
    expect(inboxCommand(press("Escape", { shiftKey: true }))).toBeNull();
  });

  it("copes with a missing target", () => {
    expect(inboxCommand(press("j", { target: null }))).toEqual({ type: "move", delta: 1 });
  });
});

describe("keeping the keyboard on the Inbox", () => {
  const body = { tagName: "BODY" };
  const list = { tagName: "UL" };

  it("takes the focus back when the element that held it went away with a render", () => {
    // The last item was decided: its list is gone and the focus fell to the body.
    expect(reclaimsFocus({ active: true, keyboardHere: true, focused: body, body })).toBe(true);
    expect(reclaimsFocus({ active: true, keyboardHere: true, focused: null, body })).toBe(true);
  });

  it("never takes a focus that is somewhere, elsewhere or while hidden", () => {
    expect(reclaimsFocus({ active: true, keyboardHere: true, focused: list, body })).toBe(false);
    // The person went to another control or pressed outside the screen.
    expect(reclaimsFocus({ active: true, keyboardHere: false, focused: body, body })).toBe(false);
    expect(reclaimsFocus({ active: false, keyboardHere: true, focused: body, body })).toBe(false);
  });
});

describe("which verb a key carries on each kind of item (D34)", () => {
  const connections = [
    item("suggestion"),
    item("withdrawn"),
    item("contradiction", { variant: "relation" })
  ];

  it("reads a suggestion, a withdrawn connection and a contradicting relation as connections", () => {
    for (const connection of connections)
      expect(isConnection(connection), connection.kind).toBe(true);
    for (const other of inboxKinds.filter(
      (kind) => !["suggestion", "withdrawn", "contradiction"].includes(kind)
    ))
      expect(isConnection(item(other)), other).toBe(false);
    // A Divergence an overview patch kept is a finding: nothing is removed by dismissing it.
    expect(isConnection(item("contradiction", { variant: "divergence" }))).toBe(false);
  });

  it("sends Backspace as the removal verb on a connection, and x never removes one", () => {
    for (const connection of connections) {
      expect(verbForKey(connection, "remove"), connection.kind).toBe("dismiss");
      expect(verbForKey(connection, "dismiss"), connection.kind).toBeNull();
      expect(verbForKey(connection, "apply"), connection.kind).toBe("apply");
    }
  });

  it("sends x as a plain dismissal where dismissing changes nothing, and Backspace there does nothing", () => {
    const plain: InboxItem[] = [
      item("review"),
      item("quarantined"),
      item("duplicate"),
      item("budget"),
      item("backlog"),
      item("contradiction", { variant: "divergence", actions: ["apply", "dismiss"] })
    ];
    for (const target of plain) {
      expect(verbForKey(target, "dismiss"), target.kind).toBe("dismiss");
      expect(verbForKey(target, "remove"), target.kind).toBeNull();
    }
  });

  it("offers nothing the item does not list, and never the budget's continue by key", () => {
    expect(verbForKey(item("obsidian_conflict"), "dismiss")).toBeNull();
    expect(verbForKey(item("obsidian_conflict"), "apply")).toBeNull();
    expect(verbForKey(item("budget"), "apply")).toBeNull();
    expect(verbForKey(item("duplicate"), "apply")).toBeNull();
    expect(verbForKey(item("quarantined", { actions: ["dismiss"] }), "retry")).toBeNull();
    expect(verbForKey(item("quarantined"), "retry")).toBe("retry");
  });

  it("never offers e: no writer of the structure takes names with a verdict", () => {
    for (const kind of inboxKinds) {
      expect(namesEditable(item(kind)), kind).toBe(false);
      expect(verbForKey(item(kind), "edit"), kind).toBeNull();
    }
  });

  it("draws the key that carries a verb: ⌫ for a removal, X for a dismissal", () => {
    expect(keyHint(item("suggestion"), "dismiss")).toEqual({ label: "⌫", shortcut: "Backspace" });
    expect(keyHint(item("review"), "dismiss")).toEqual({ label: "X", shortcut: "X" });
    expect(keyHint(item("review"), "apply")).toEqual({ label: "A", shortcut: "A" });
    expect(keyHint(item("budget"), "apply")).toBeNull();
    expect(keyHint(item("quarantined"), "retry")).toEqual({ label: "R", shortcut: "R" });
  });
});

describe("the rows of the keys sheet", () => {
  const labels = (target: InboxItem | null) => keyRows(target).map((row) => row.label);

  it("lists remove on a connection and dismiss on the rest, never both for one item", () => {
    expect(labels(item("suggestion"))).toContain("inbox.keys.remove");
    expect(labels(item("suggestion"))).not.toContain("inbox.keys.dismiss");
    expect(labels(item("review"))).toContain("inbox.keys.dismiss");
    expect(labels(item("review"))).not.toContain("inbox.keys.remove");
  });

  it("leaves out retry where it is not offered, and e everywhere", () => {
    expect(labels(item("review"))).not.toContain("inbox.keys.retry");
    expect(labels(item("quarantined"))).toContain("inbox.keys.retry");
    for (const kind of inboxKinds)
      expect(labels(item(kind)), kind).not.toContain("inbox.keys.edit");
    expect(labels(null)).not.toContain("inbox.keys.edit");
  });

  it("draws Backspace as ⌫ and always lists moving, opening, undo and the sheet", () => {
    const rows = keyRows(item("suggestion"));
    expect(rows.find((row) => row.label === "inbox.keys.remove")?.keys).toEqual(["⌫"]);
    for (const label of [
      "inbox.keys.move",
      "inbox.keys.open",
      "inbox.keys.undo",
      "inbox.keys.help"
    ])
      expect(rows.map((row) => row.label)).toContain(label);
  });

  it("lists every offered key when nothing is selected", () => {
    expect(labels(null)).toEqual(
      expect.arrayContaining([
        "inbox.keys.apply",
        "inbox.keys.remove",
        "inbox.keys.dismiss",
        "inbox.keys.retry"
      ])
    );
  });
});
