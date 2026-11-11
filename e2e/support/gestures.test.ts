import { afterEach, describe, expect, it } from "vitest";

import { installerSource, keyIsGesture, type GestureCount, type KeyLike } from "./gestures.js";

const key = (name: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  repeat: false,
  ...extra
});

describe("keyIsGesture", () => {
  it.each([
    "Enter",
    "Escape",
    "Tab",
    " ",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Backspace",
    "Delete",
    "Home",
    "End",
    "PageDown",
    "F6",
    "F12"
  ])("counts the non-printable key %j", (name) => {
    expect(keyIsGesture(key(name))).toBe(true);
  });

  it.each(["a", "Z", "?", "1", "É", "ç", "😀"])("does not count the printable %j", (name) => {
    expect(keyIsGesture(key(name))).toBe(false);
  });

  it("counts a printable key with Meta or Ctrl, once per chord", () => {
    expect(keyIsGesture(key("k", { metaKey: true }))).toBe(true);
    expect(keyIsGesture(key("[", { metaKey: true }))).toBe(true);
    expect(keyIsGesture(key("n", { ctrlKey: true }))).toBe(true);
    expect(keyIsGesture(key("Meta", { metaKey: true }))).toBe(false);
    expect(keyIsGesture(key("Control", { ctrlKey: true }))).toBe(false);
  });

  it("does not count modifiers, Shift for a capital, dead keys, composition or repeats", () => {
    for (const name of ["Shift", "Alt", "AltGraph", "CapsLock", "Dead", "Process", "Unidentified"])
      expect(keyIsGesture(key(name))).toBe(false);
    expect(keyIsGesture(key("A"))).toBe(false);
    expect(keyIsGesture(key("Enter", { isComposing: true }))).toBe(false);
    expect(keyIsGesture(key("ArrowDown", { repeat: true }))).toBe(false);
  });
});

describe("the in-page counter", () => {
  type Listener = (event: Record<string, unknown>) => void;
  const scope = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    delete scope.window;
  });

  it("counts trusted pointer downs and gesture keys, and resets on a second install", () => {
    const listeners = new Map<string, Listener>();
    const fakeWindow: Record<string, unknown> = {
      addEventListener: (type: string, listener: Listener, options: { capture: boolean }) => {
        expect(options.capture).toBe(true);
        listeners.set(type, listener);
      }
    };
    scope.window = fakeWindow;
    (0, eval)(installerSource());
    const down = listeners.get("pointerdown")!;
    const keydown = listeners.get("keydown")!;
    down({ isTrusted: true, button: 0 });
    down({ isTrusted: true, button: 2 });
    down({ isTrusted: false, button: 0 });
    keydown({ isTrusted: true, ...key("Meta", { metaKey: true }) });
    keydown({ isTrusted: true, ...key("k", { metaKey: true }) });
    for (const name of ["h", "e", "l", "l", "o"]) keydown({ isTrusted: true, ...key(name) });
    keydown({ isTrusted: true, ...key("Enter") });
    keydown({ isTrusted: false, ...key("Escape") });
    const state = fakeWindow.__memoraGestures as GestureCount;
    expect(state).toEqual({
      total: 4,
      pointer: 2,
      keys: 2,
      log: ["pointer:0", "pointer:2", "Meta+k", "Enter"]
    });
    (0, eval)(installerSource());
    expect(fakeWindow.__memoraGestures).toEqual({ total: 0, pointer: 0, keys: 0, log: [] });
    expect(listeners.size).toBe(2);
  });
});
