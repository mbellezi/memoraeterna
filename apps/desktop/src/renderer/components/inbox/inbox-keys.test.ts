import { describe, expect, it } from "vitest";

import { inboxCommand, type InboxKeyEvent } from "./inbox-keys";

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
  it("maps each key of D29 to its command", () => {
    expect(inboxCommand(press("j"))).toEqual({ type: "move", delta: 1 });
    expect(inboxCommand(press("k"))).toEqual({ type: "move", delta: -1 });
    expect(inboxCommand(press("a"))).toEqual({ type: "verb", verb: "apply" });
    expect(inboxCommand(press("x"))).toEqual({ type: "verb", verb: "dismiss" });
    expect(inboxCommand(press("r"))).toEqual({ type: "verb", verb: "retry" });
    expect(inboxCommand(press("u"))).toEqual({ type: "undo" });
    expect(inboxCommand(press("Enter"))).toEqual({ type: "open" });
    expect(inboxCommand(press("Escape"))).toEqual({ type: "escape" });
    expect(inboxCommand(press("?", { shiftKey: true }))).toEqual({ type: "help" });
  });

  it("reads a capital letter (caps lock) as the letter", () => {
    expect(inboxCommand(press("A"))).toEqual({ type: "verb", verb: "apply" });
    expect(inboxCommand(press("J"))).toEqual({ type: "move", delta: 1 });
  });

  it("ignores every other key", () => {
    for (const key of ["b", "z", "1", " ", "Tab", "Delete", "Backspace", "jj", "F5"])
      expect(inboxCommand(press(key)), key).toBeNull();
  });

  it("never fires while the person types", () => {
    const typing = [
      target({ tagName: "INPUT" }),
      target({ tagName: "TEXTAREA" }),
      target({ tagName: "SELECT" }),
      target({ editable: true })
    ];
    for (const key of ["j", "k", "a", "x", "r", "u", "?", "Enter", "Escape"])
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
      for (const key of ["j", "a", "x", "r", "u", "Enter", "?"])
        expect(inboxCommand(press(key, { [modifier]: true })), `${modifier} ${key}`).toBeNull();
  });

  it("does not take a key another handler already used", () => {
    expect(inboxCommand(press("u", { defaultPrevented: true }))).toBeNull();
  });

  it("lets a held key move but never repeat a verb or an undo", () => {
    expect(inboxCommand(press("j", { repeat: true }))).toEqual({ type: "move", delta: 1 });
    for (const key of ["a", "x", "r", "u", "Enter"])
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
