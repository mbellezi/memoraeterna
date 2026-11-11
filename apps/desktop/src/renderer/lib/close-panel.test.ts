import { describe, expect, it, vi } from "vitest";
import { applyMenuCommand } from "./menu-commands";
import {
  closePanelPriority,
  closeTopDialog,
  createClosePanelRouter,
  type DialogLike
} from "./close-panel";

describe("closing a panel", () => {
  it("does nothing, and says so, when nothing is open", () => {
    expect(createClosePanelRouter().dispatch()).toBe(false);
    expect(closeTopDialog([])).toBe(false);
  });

  it("asks the highest priority first and stops at the first that closes something", () => {
    const router = createClosePanelRouter();
    const calls: string[] = [];
    const listener = (name: string, handled: boolean) => () => {
      calls.push(name);
      return handled;
    };
    router.subscribe(listener("panel", true), closePanelPriority.panel);
    router.subscribe(listener("dialog", false), closePanelPriority.dialog);
    router.subscribe(listener("editing", false), closePanelPriority.editing);
    expect(router.dispatch()).toBe(true);
    expect(calls).toEqual(["dialog", "editing", "panel"]);

    calls.length = 0;
    router.subscribe(listener("dialog 2", true), closePanelPriority.dialog);
    expect(router.dispatch()).toBe(true);
    expect(calls).toEqual(["dialog 2"]);
  });

  it("lets unsaved editing answer before the panel that holds it", () => {
    const router = createClosePanelRouter();
    const panel = vi.fn(() => true);
    router.subscribe(panel, closePanelPriority.panel);
    const stopEditing = router.subscribe(() => true, closePanelPriority.editing);
    expect(router.dispatch()).toBe(true);
    expect(panel).not.toHaveBeenCalled();
    stopEditing();
    expect(router.dispatch()).toBe(true);
    expect(panel).toHaveBeenCalledTimes(1);
  });

  it("asks the most recent listener first among equals, and forgets a removed one", () => {
    const router = createClosePanelRouter();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    router.subscribe(first);
    const remove = router.subscribe(second);
    router.dispatch();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    remove();
    remove();
    router.dispatch();
    expect(first).toHaveBeenCalledTimes(1);
  });
});

function fakeDialog(
  tagName: string,
  options: { busy?: boolean; keepOpen?: boolean } = {}
): DialogLike & { closed: boolean; events: string[] } {
  const dialog = {
    tagName,
    closed: false,
    events: [] as string[],
    getAttribute: (name: string) => (name === "aria-busy" && options.busy ? "true" : null),
    dispatchEvent: (event: Event) => {
      dialog.events.push(
        event.type === "keydown" ? `keydown:${(event as never as { key: string }).key}` : event.type
      );
      return !options.keepOpen;
    },
    close: () => {
      dialog.closed = true;
    }
  };
  return dialog;
}

describe("closing the topmost dialog", () => {
  const escape = () => Object.assign(new Event("keydown"), { key: "Escape" });

  it("closes a native dialog the way Escape does", () => {
    const dialog = fakeDialog("DIALOG");
    expect(closeTopDialog([dialog], escape)).toBe(true);
    expect(dialog.events).toEqual(["cancel"]);
    expect(dialog.closed).toBe(true);
  });

  it("leaves a native dialog open when it keeps its own say, such as a request in flight", () => {
    const dialog = fakeDialog("DIALOG", { keepOpen: true });
    expect(closeTopDialog([dialog], escape)).toBe(true);
    expect(dialog.events).toEqual(["cancel"]);
    expect(dialog.closed).toBe(false);
  });

  it("sends Escape to a custom dialog or panel, which already handles it", () => {
    const panel = fakeDialog("SECTION");
    expect(closeTopDialog([panel], escape)).toBe(true);
    expect(panel.events).toEqual(["keydown:Escape"]);
    expect(panel.closed).toBe(false);
  });

  it("answers for the topmost dialog only", () => {
    const below = fakeDialog("DIALOG");
    const top = fakeDialog("SECTION");
    closeTopDialog([below, top], escape);
    expect(below.events).toEqual([]);
    expect(top.events).toEqual(["keydown:Escape"]);
  });

  it("never dismisses a dialog that is busy, and does not fall through to what is below it", () => {
    const busy = fakeDialog("DIV", { busy: true });
    expect(closeTopDialog([busy], escape)).toBe(true);
    expect(busy.events).toEqual([]);
  });
});

describe("application menu commands in the renderer", () => {
  it("run exactly the matching action", () => {
    const handlers = {
      closePanel: vi.fn(),
      goTo: vi.fn(),
      toggleNavigation: vi.fn(),
      toggleTheme: vi.fn(),
      workspace: vi.fn(),
      hoistTopic: vi.fn()
    };
    applyMenuCommand({ type: "close-panel" }, handlers);
    applyMenuCommand({ type: "go-to", view: "explore" }, handlers);
    applyMenuCommand({ type: "toggle-navigation" }, handlers);
    applyMenuCommand({ type: "toggle-theme" }, handlers);
    expect(handlers.closePanel).toHaveBeenCalledTimes(1);
    expect(handlers.goTo).toHaveBeenCalledExactlyOnceWith("explore");
    expect(handlers.toggleNavigation).toHaveBeenCalledTimes(1);
    expect(handlers.toggleTheme).toHaveBeenCalledTimes(1);
  });
});
