import { describe, expect, it } from "vitest";

import { keymap, type KeyInput } from "./keymap";

const press = (code: string, key: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers
});
const cmd = (code: string, key: string, modifiers: Partial<KeyInput> = {}) =>
  press(code, key, { metaKey: true, ...modifiers });

describe("keymap", () => {
  it("maps every workspace shortcut", () => {
    const cases: [KeyInput, unknown][] = [
      [cmd("Digit1", "1"), { type: "go", destination: "home" }],
      [cmd("Digit2", "2"), { type: "go", destination: "explore" }],
      [cmd("Digit3", "3"), { type: "go", destination: "library" }],
      [cmd("Digit4", "4"), { type: "go", destination: "inbox" }],
      [cmd("Digit5", "5"), { type: "go", destination: "map" }],
      [cmd("Comma", ","), { type: "go", destination: "settings" }],
      [cmd("KeyK", "k"), { type: "openPalette" }],
      [cmd("KeyN", "n"), { type: "newImport" }],
      [cmd("BracketLeft", "["), { type: "back" }],
      [cmd("BracketRight", "]"), { type: "forward" }],
      [cmd("KeyW", "w"), { type: "close" }],
      [cmd("KeyT", "T", { shiftKey: true }), { type: "reopen" }],
      [cmd("Backslash", "\\"), { type: "toggleNavigator" }],
      [cmd("Backslash", "|", { shiftKey: true }), { type: "toggleContext" }],
      [press("Tab", "Tab", { ctrlKey: true }), { type: "focusNext", delta: 1 }],
      [press("Tab", "Tab", { ctrlKey: true, shiftKey: true }), { type: "focusNext", delta: -1 }],
      [cmd("KeyY", "y"), { type: "quickLook" }],
      [cmd("KeyF", "F", { shiftKey: true }), { type: "toggleFocusMode" }],
      [press("F6", "F6"), { type: "cycleRegion", delta: 1 }],
      [press("F6", "F6", { shiftKey: true }), { type: "cycleRegion", delta: -1 }],
      // Where a layout puts the brackets behind Shift (design record §12).
      [cmd("BracketLeft", "{", { shiftKey: true }), { type: "back" }],
      [cmd("BracketRight", "}", { shiftKey: true }), { type: "forward" }]
    ];
    for (const [event, action] of cases) expect(keymap(event), `${event.code}`).toEqual(action);
  });

  it("maps Option-1..6 to the context tabs in A5's order by physical key", () => {
    const tabs = ["connections", "evidence", "ask", "mentions", "graph", "history"];
    // On the macOS ABNT2 and US layouts Option-digit types a character; the code still matches.
    const typed = ["¡", "™", "£", "¢", "∞", "§"];
    tabs.forEach((tab, index) =>
      expect(keymap(press(`Digit${index + 1}`, typed[index] ?? "", { altKey: true }))).toEqual({
        type: "contextTab",
        tab
      })
    );
  });

  it("refuses Option-1..6 in a text field or editor, with other modifiers or past 6", () => {
    for (const event of [
      press("Digit1", "¡", { altKey: true, editable: true }),
      press("Digit1", "¡", { altKey: true, metaKey: true }),
      press("Digit1", "¡", { altKey: true, shiftKey: true }),
      press("Digit1", "¡", { altKey: true, ctrlKey: true }),
      press("Digit7", "¶", { altKey: true }),
      { key: "1", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true }
    ])
      expect(keymap(event), JSON.stringify(event)).toBeNull();
  });

  it("has no Option-Arrow shortcut (hoist is a menu command)", () => {
    for (const code of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(keymap(press(code, code, { altKey: true }))).toBeNull();
      expect(keymap(press(code, code, { altKey: true, metaKey: true }))).toBeNull();
    }
  });

  it("matches letters by character and symbols by physical key", () => {
    // Dvorak: the key in QWERTY's K position types "t"; Cmd plus it is not the palette.
    expect(keymap(cmd("KeyK", "t"))).toBeNull();
    expect(keymap(cmd("KeyV", "k"))).toEqual({ type: "openPalette" });
    // A non-Latin layout falls back to the physical key.
    expect(keymap(cmd("KeyK", "л"))).toEqual({ type: "openPalette" });
    // ABNT2: the bracket keys keep their position whatever they type.
    expect(keymap(cmd("BracketRight", "["))).toEqual({ type: "forward" });
    expect(keymap(cmd("Backslash", "]"))).toEqual({ type: "toggleNavigator" });
  });

  it("reads the key when the event has no code, Shift-\\ included", () => {
    expect(
      keymap({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })
    ).toEqual({
      type: "openPalette"
    });
    expect(
      keymap({ key: "|", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })
    ).toEqual({
      type: "toggleContext"
    });
    expect(
      keymap({ key: "T", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })
    ).toEqual({
      type: "reopen"
    });
  });

  it("uses Ctrl as the command key off macOS", () => {
    expect(keymap(press("KeyW", "w", { ctrlKey: true }), "other")).toEqual({ type: "close" });
    expect(keymap(cmd("KeyW", "w"), "other")).toBeNull();
    expect(keymap(press("KeyW", "w", { ctrlKey: true }), "mac")).toBeNull();
  });

  it("ignores other keys, extra modifiers and composition", () => {
    for (const event of [
      press("KeyW", "w"),
      cmd("Digit6", "6"),
      cmd("Digit0", "0"),
      cmd("KeyA", "a"),
      cmd("KeyW", "W", { shiftKey: true }),
      cmd("KeyT", "t"),
      cmd("KeyK", "k", { altKey: true }),
      cmd("KeyK", "k", { ctrlKey: true }),
      cmd("KeyY", "Y", { shiftKey: true }),
      cmd("KeyF", "f"),
      press("F6", "F6", { metaKey: true }),
      press("F6", "F6", { altKey: true }),
      cmd("KeyK", "k", { isComposing: true }),
      press("Tab", "Tab"),
      press("Tab", "Tab", { ctrlKey: true, metaKey: true }),
      press("Tab", "Tab", { ctrlKey: true, altKey: true })
    ])
      expect(keymap(event), JSON.stringify(event)).toBeNull();
  });
});
