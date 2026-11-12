import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A small real DOM for tests that must press keys, focus and wait on a timer: `linkedom` (already
 * in the tree for conversion) with React's client renderer. Static markup cannot prove an event
 * handler; this can.
 *
 * Node has no DOM, and Radix reads `document` when its modules load (its layout effect is a no-op
 * without one), so the globals are installed when this module is imported: a test file imports it
 * before any component. Vitest isolates files, so nothing leaks into another file.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='host'></div></body></html>"
);

const globals: Record<string, unknown> = {
  window,
  document,
  navigator: { userAgent: "test", platform: "MacIntel" },
  NodeFilter: {
    SHOW_ELEMENT: 1,
    SHOW_ALL: 0xffffffff,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3
  },
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  // Radix reads styles to tell whether an exit animation is running: there is none here.
  getComputedStyle: () => ({ animationName: "none", display: "block" })
};
for (const name of [
  "HTMLElement",
  "Node",
  "Element",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
  "MutationObserver",
  "SVGElement",
  "HTMLIFrameElement",
  "DocumentFragment",
  "ShadowRoot"
] as const) {
  const value = (window as unknown as Record<string, unknown>)[name];
  if (value) globals[name] = value;
}
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
// Fake timers (vitest's) replace `setTimeout`; a frame is whatever timer is current when asked.
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (run: () => void) => setTimeout(run, 16),
  configurable: true,
  writable: true
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  value: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  configurable: true,
  writable: true
});

let focused: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
  get: () => focused ?? document.body,
  configurable: true
});

export interface TestDom {
  window: Window & typeof globalThis;
  document: Document;
  /** The element React renders into. */
  host: HTMLElement;
  render(element: ReactElement): Promise<void>;
  /** Runs `work` inside `act`, so React has applied its updates when it returns. */
  act(work: () => void | Promise<void>): Promise<void>;
  /** Dispatches a bubbling, cancelable keydown on `target`; true when nothing cancelled it. */
  key(target: Element, key: string, init?: Record<string, unknown>): boolean;
  /** Dispatches a bubbling, cancelable keyup on `target`; true when nothing cancelled it. */
  keyUp(target: Element, key: string): boolean;
  /** Focuses `target` the way the browser does: `activeElement` moves and `focusin` bubbles. */
  focus(target: HTMLElement): void;
  /** Unmounts and empties the page; the next `createTestDom` starts clean. */
  dispose(): Promise<void>;
}

/** A clean page with a React root in it; call `dispose` when the test is done. */
export function createTestDom(): TestDom {
  const body = document.body as unknown as HTMLElement;
  body.innerHTML = "<div id='host'></div>";
  focused = null;
  const host = document.getElementById("host") as unknown as HTMLElement;
  const root: Root = createRoot(host);
  const run = async (work: () => void | Promise<void>) => {
    await act(async () => {
      await work();
    });
  };
  const dispatch = (type: string, target: Element, key: string, init: Record<string, unknown>) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { key, code: key === " " ? "Space" : key, ...init });
    let uncancelled = true;
    act(() => {
      uncancelled = target.dispatchEvent(event);
    });
    return uncancelled;
  };
  return {
    window: window as unknown as Window & typeof globalThis,
    document: document as unknown as Document,
    host,
    render: (element) => run(() => root.render(element)),
    act: run,
    key: (target, key, init = {}) => dispatch("keydown", target, key, init),
    keyUp: (target, key) => dispatch("keyup", target, key, {}),
    focus(target) {
      focused = target;
      act(() => {
        target.dispatchEvent(new window.Event("focusin", { bubbles: true }));
      });
    },
    async dispose() {
      await run(() => root.unmount());
      body.innerHTML = "";
      focused = null;
    }
  };
}
