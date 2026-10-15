import { describe, expect, it } from "vitest";
import {
  navigationDirectionFromAppCommand,
  navigationDirectionFromInput,
  navigationDirectionFromSwipe
} from "./window-navigation.js";

type Input = Parameters<typeof navigationDirectionFromInput>[0];

const input = (overrides: Partial<Input>): Input => ({
  type: "keyDown",
  key: "",
  shift: false,
  control: false,
  alt: false,
  meta: false,
  ...overrides
});

const direction = (platform: string, overrides: Partial<Input>) =>
  navigationDirectionFromInput(input(overrides), platform);

describe("window navigation", () => {
  it("maps native mouse commands to browser history directions", () => {
    expect(navigationDirectionFromAppCommand("browser-backward")).toBe("back");
    expect(navigationDirectionFromAppCommand("browser-forward")).toBe("forward");
    expect(navigationDirectionFromAppCommand("media-play")).toBeNull();
  });

  it("maps macOS swipe directions to browser history directions", () => {
    expect(navigationDirectionFromSwipe("left")).toBe("back");
    expect(navigationDirectionFromSwipe("right")).toBe("forward");
    expect(navigationDirectionFromSwipe("up")).toBeNull();
  });

  it("maps browser navigation keys synthesized by mouse drivers on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(direction(platform, { key: "BrowserBack" })).toBe("back");
      expect(direction(platform, { key: "BrowserForward" })).toBe("forward");
      expect(direction(platform, { type: "keyUp", key: "BrowserBack" })).toBeNull();
    }
  });

  it("takes Cmd-[ and Cmd-] on macOS, the menu's accelerators, even on a layout with a dead key", () => {
    expect(direction("darwin", { key: "[", meta: true })).toBe("back");
    expect(direction("darwin", { key: "Dead", code: "BracketLeft", meta: true })).toBe("back");
    expect(direction("darwin", { key: "]", meta: true })).toBe("forward");
    expect(direction("darwin", { key: "Dead", code: "BracketRight", meta: true })).toBe("forward");
  });

  it("leaves Option-Arrow to text editing on macOS: word movement and selection in every field", () => {
    for (const alt of [{ alt: true }, { alt: true, shift: true }]) {
      expect(direction("darwin", { key: "ArrowLeft", ...alt })).toBeNull();
      expect(direction("darwin", { key: "ArrowRight", ...alt })).toBeNull();
    }
    expect(direction("darwin", { key: "ArrowLeft" })).toBeNull();
    // Cmd-Arrow moves to the line ends and is not navigation either.
    expect(direction("darwin", { key: "ArrowLeft", meta: true })).toBeNull();
  });

  it("does not take a bracket chord that carries another modifier", () => {
    // Cmd-Shift-[ and Cmd-Shift-] switch tabs in other apps; Cmd-Option-[ is another chord again.
    for (const extra of [{ shift: true }, { alt: true }, { control: true }]) {
      expect(
        direction("darwin", { key: "{", code: "BracketLeft", meta: true, ...extra })
      ).toBeNull();
      expect(direction("darwin", { key: "]", meta: true, ...extra })).toBeNull();
    }
    // Without the platform modifier a bracket is only a character being typed.
    expect(direction("darwin", { key: "[" })).toBeNull();
    expect(direction("darwin", { key: "]", control: true })).toBeNull();
  });

  it("uses Ctrl-[ and Ctrl-] and Alt-Arrow elsewhere, where Alt-Arrow is the platform's history chord", () => {
    for (const platform of ["win32", "linux"]) {
      expect(direction(platform, { key: "[", control: true })).toBe("back");
      expect(direction(platform, { key: "]", control: true })).toBe("forward");
      expect(direction(platform, { key: "ArrowLeft", alt: true })).toBe("back");
      expect(direction(platform, { key: "ArrowRight", alt: true })).toBe("forward");
      // Shift selects by word and a further modifier makes another chord: never navigation.
      expect(direction(platform, { key: "ArrowLeft", alt: true, shift: true })).toBeNull();
      expect(direction(platform, { key: "ArrowRight", alt: true, control: true })).toBeNull();
      expect(direction(platform, { key: "ArrowLeft" })).toBeNull();
      // Cmd is the macOS modifier; the Windows or Super key is not.
      expect(direction(platform, { key: "[", meta: true })).toBeNull();
      expect(direction(platform, { key: "[", control: true, shift: true })).toBeNull();
    }
  });

  it("ignores key releases", () => {
    expect(direction("darwin", { type: "keyUp", key: "[", meta: true })).toBeNull();
    expect(direction("linux", { type: "keyUp", key: "ArrowLeft", alt: true })).toBeNull();
  });
});
