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
      [press("Tab", "Tab", { ctrlKey: true, shiftKey: true }), { type: "focusNext", delta: -1 }]
    ];
    for (const [event, action] of cases) expect(keymap(event), `${event.code}`).toEqual(action);
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
      cmd("BracketLeft", "{", { shiftKey: true }),
      cmd("KeyK", "k", { isComposing: true }),
      press("Tab", "Tab"),
      press("Tab", "Tab", { ctrlKey: true, metaKey: true }),
      press("Tab", "Tab", { ctrlKey: true, altKey: true })
    ])
      expect(keymap(event), JSON.stringify(event)).toBeNull();
  });
});
