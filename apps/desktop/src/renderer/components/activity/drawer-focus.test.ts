import { describe, expect, it, vi } from "vitest";

import { closesDrawer, createDrawerFocus } from "./drawer-focus";

const element = () => ({ focus: vi.fn() });

describe("the drawer's focus", () => {
  it("moves into the drawer when it opens and back to the pill when the person closes it", () => {
    const pill = element();
    const drawer = element();
    const focus = createDrawerFocus({ pill: { current: pill }, drawer: { current: drawer } });
    focus.opened();
    expect(drawer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(pill.focus).not.toHaveBeenCalled();
    focus.closed();
    expect(pill.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("survives elements that are not there", () => {
    const focus = createDrawerFocus({ pill: { current: null }, drawer: { current: null } });
    expect(() => {
      focus.opened();
      focus.closed();
    }).not.toThrow();
  });

  it("reads the elements when it acts, so a drawer that mounts later is found", () => {
    const targets = {
      pill: { current: null as ReturnType<typeof element> | null },
      drawer: { current: null as ReturnType<typeof element> | null }
    };
    const focus = createDrawerFocus(targets);
    focus.opened();
    targets.drawer.current = element();
    focus.opened();
    expect(targets.drawer.current.focus).toHaveBeenCalledOnce();
  });
});

describe("Escape", () => {
  it("closes the drawer", () => {
    expect(closesDrawer({ key: "Escape", defaultPrevented: false })).toBe(true);
  });

  it("leaves other keys alone, and an Escape something inside already handled", () => {
    expect(closesDrawer({ key: "Enter", defaultPrevented: false })).toBe(false);
    expect(closesDrawer({ key: "Tab", defaultPrevented: false })).toBe(false);
    expect(closesDrawer({ key: "Escape", defaultPrevented: true })).toBe(false);
  });

  it("does not take the Escape that ends an input method's composition", () => {
    expect(closesDrawer({ key: "Escape", defaultPrevented: false, isComposing: true })).toBe(false);
  });
});
