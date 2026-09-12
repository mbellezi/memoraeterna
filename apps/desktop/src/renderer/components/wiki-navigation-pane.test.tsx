import type { HTMLAttributes, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";
import { clampWikiTreeWidth, wikiTreeBounds, wikiTreeKeyboardWidth, WikiNavigationPane } from "./WikiNavigationPane";

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useId: () => "wiki-navigation-test",
  useEffect: vi.fn()
}));

describe("wiki tree resizing", () => {
  it("reserves reading width at minimum size and subtracts the inline inspector budget", () => {
    // 960 px window, expanded 224 px menu and 40 px workspace padding.
    expect(clampWikiTreeWidth(520, 960 - 224 - 40)).toBe(320);
    // Inspector is outside the observed container: 320 px plus its 20 px gap.
    expect(clampWikiTreeWidth(520, 1280 - 224 - 40 - 320 - 20)).toBe(300);
    expect(clampWikiTreeWidth(520, 1600 - 64 - 40)).toBe(520);
    expect(wikiTreeBounds(500)).toEqual({ min: 124, max: 124 });
    expect(clampWikiTreeWidth(Number.NaN, 1200)).toBe(320);
  });
  it("supports precise and larger keyboard steps plus bounded Home/End", () => {
    expect(wikiTreeKeyboardWidth("ArrowRight", 320, 1200)).toBe(336);
    expect(wikiTreeKeyboardWidth("ArrowLeft", 320, 1200, true)).toBe(280);
    expect(wikiTreeKeyboardWidth("Home", 320, 1200)).toBe(240);
    expect(wikiTreeKeyboardWidth("End", 320, 696)).toBe(320);
    expect(wikiTreeKeyboardWidth("Enter", 320, 1200)).toBeUndefined();
  });
  function controls() {
    const onWidthChange = vi.fn();
    const tree = WikiNavigationPane({ children: null, width: 320, onWidthChange, t: createTranslator("en") });
    const children = tree.props.children as ReactElement<HTMLAttributes<HTMLDivElement>>[];
    const separator = children[1]!.props;
    const currentTarget = { focus: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
    const event = (clientX: number) => ({ button: 0, pointerId: 1, clientX, currentTarget, preventDefault: vi.fn() }) as never;
    return { onWidthChange, separator, currentTarget, event };
  }
  it("captures pointer movement and persists only the completed gesture", () => {
    const { separator, onWidthChange, currentTarget, event } = controls();
    separator.onPointerDown!(event(400));
    separator.onPointerMove!(event(450));
    separator.onPointerMove!(event(480));
    expect(onWidthChange).not.toHaveBeenCalled();
    expect(currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
    separator.onPointerUp!(event(480));
    separator.onLostPointerCapture!(event(480));
    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(400);
  });
  it.each(["cancel", "escape", "lost capture"])("discards a drag after %s", reason => {
    const { separator, onWidthChange, event } = controls();
    separator.onPointerDown!(event(400));
    separator.onPointerMove!(event(480));
    if (reason === "cancel") separator.onPointerCancel!(event(480));
    else if (reason === "escape") separator.onKeyDown!({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() } as never);
    else separator.onLostPointerCapture!(event(480));
    separator.onPointerUp!(event(480));
    expect(onWidthChange).not.toHaveBeenCalled();
  });
  it("does not save initial layout and exposes an accessible reset and keyboard adjustment", () => {
    const { separator, onWidthChange } = controls();
    expect(onWidthChange).not.toHaveBeenCalled();
    expect(separator.role).toBe("separator");
    expect(separator["aria-valuetext"]).toBe("Tree width: 320 pixels");
    separator.onKeyDown!({ key: "ArrowLeft", preventDefault: vi.fn() } as never);
    expect(onWidthChange).toHaveBeenLastCalledWith(304);
    separator.onDoubleClick!({} as never);
    expect(onWidthChange).toHaveBeenLastCalledWith(320);
  });
});
