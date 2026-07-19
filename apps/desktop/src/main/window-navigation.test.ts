import { describe, expect, it } from "vitest";
import {
  navigationDirectionFromAppCommand,
  navigationDirectionFromInput,
  navigationDirectionFromSwipe
} from "./window-navigation.js";

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

  it("maps browser navigation keys synthesized by mouse drivers", () => {
    const input = (overrides: Partial<Parameters<typeof navigationDirectionFromInput>[0]>) => ({
      type: "keyDown",
      key: "",
      alt: false,
      meta: false,
      ...overrides
    });

    expect(navigationDirectionFromInput(input({ key: "BrowserBack" }))).toBe("back");
    expect(navigationDirectionFromInput(input({ key: "ArrowLeft", alt: true }))).toBe("back");
    expect(navigationDirectionFromInput(input({ key: "[", meta: true }))).toBe("back");
    expect(navigationDirectionFromInput(input({ key: "Dead", code: "BracketLeft", meta: true }))).toBe("back");
    expect(navigationDirectionFromInput(input({ key: "BrowserForward" }))).toBe("forward");
    expect(navigationDirectionFromInput(input({ key: "ArrowRight", alt: true }))).toBe("forward");
    expect(navigationDirectionFromInput(input({ key: "]", meta: true }))).toBe("forward");
    expect(navigationDirectionFromInput(input({ key: "Dead", code: "BracketRight", meta: true }))).toBe("forward");
    expect(navigationDirectionFromInput(input({ type: "keyUp", key: "BrowserBack" }))).toBeNull();
    expect(navigationDirectionFromInput(input({ key: "ArrowLeft" }))).toBeNull();
  });
});
