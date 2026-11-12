// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "./test-dom";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { openDialogs } from "../lib/close-panel";
import { QuickLookHost } from "./QuickLook";
import { createQuickLookStore, type QuickLookStore } from "./QuickLookModel";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number) => `memora://note/${uuid(n)}`;
const en = createTranslator("en");

let dom: TestDom;
let store: QuickLookStore;

beforeEach(() => {
  vi.useFakeTimers();
  dom = createTestDom();
  store = createQuickLookStore();
  (dom.window as unknown as { app: unknown }).app = {
    objects: {
      resolveMany: ({ addresses }: { addresses: string[] }) =>
        Promise.resolve({
          items: Object.fromEntries(
            addresses.map((address) => [
              address,
              {
                address,
                kind: "note",
                title: `Title of ${address.slice(-2)}`,
                status: "current",
                preview: "A line.",
                updatedAt: "2026-11-05T10:00:00.000Z"
              }
            ])
          ),
          missing: []
        }),
      backlinks: () => Promise.resolve({ items: [] })
    },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

/** A frame, as the host's `requestAnimationFrame` waits for it. */
const frame = () => dom.act(() => void vi.advanceTimersByTime(20));

/**
 * A listbox the way cmdk builds one: the input keeps the focus, names the highlighted option with
 * `aria-activedescendant`, and cancels the arrows and Enter in its own handler, which runs on the
 * element, before the event reaches the document.
 */
function paletteList(onEnter = () => undefined) {
  const { document } = dom;
  const list = document.createElement("div");
  list.innerHTML = `<input id="q" role="combobox" aria-activedescendant="r1" />
    <div role="listbox">
      <div id="r1" role="option" data-quick-look="${note(1)}"></div>
      <div id="r2" role="option" data-quick-look="${note(2)}"></div>
      <div id="r3" role="option" data-quick-look="${note(3)}"></div>
    </div>`;
  const input = list.querySelector("#q") as HTMLInputElement;
  input.addEventListener("keydown", (event) => {
    const ids = ["r1", "r2", "r3"];
    const at = ids.indexOf(input.getAttribute("aria-activedescendant") ?? "r1");
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = ids[Math.max(0, Math.min(2, at + (event.key === "ArrowDown" ? 1 : -1)))];
      input.setAttribute("aria-activedescendant", next as string);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onEnter();
    }
  });
  document.body.append(list);
  return input;
}

const mount = () => dom.render(createElement(QuickLookHost, { t: en, store }));

describe("quick-look on the keyboard, in the DOM", () => {
  it("Cmd-Y opens it from Cmd-K's input, and the arrows the list cancels still move the peek", async () => {
    const input = paletteList();
    await mount();
    dom.focus(input);
    dom.key(input, "y", { metaKey: true, code: "KeyY" });
    expect(store.get()).toBe(note(1));

    // The list handles ArrowDown itself and cancels it; the sheet follows it a frame later.
    const notCancelled = dom.key(input, "ArrowDown");
    expect(notCancelled).toBe(false);
    await frame();
    expect(store.get()).toBe(note(2));
    dom.key(input, "ArrowDown");
    await frame();
    expect(store.get()).toBe(note(3));
    dom.key(input, "ArrowUp");
    await frame();
    expect(store.get()).toBe(note(2));
  });

  it("ends the peek after Enter even though the list cancelled it, and the list still acts", async () => {
    const opened = vi.fn();
    const input = paletteList(opened);
    await mount();
    dom.focus(input);
    dom.key(input, "y", { metaKey: true, code: "KeyY" });
    expect(store.get()).toBe(note(1));
    dom.key(input, "Enter");
    expect(opened).toHaveBeenCalledOnce();
    await frame();
    expect(store.get()).toBeNull();
  });

  it("does nothing for the arrows or Enter while the sheet is closed", async () => {
    const input = paletteList();
    await mount();
    dom.focus(input);
    dom.key(input, "ArrowDown");
    dom.key(input, "Enter");
    await frame();
    expect(store.get()).toBeNull();
  });

  it("Space on a row peeks and swallows its key-up; Space again closes", async () => {
    const { document } = dom;
    const row = document.createElement("button");
    row.setAttribute("data-quick-look", note(4));
    document.body.append(row);
    await mount();
    dom.focus(row);
    expect(dom.key(row, " ")).toBe(false);
    expect(store.get()).toBe(note(4));
    expect(dom.keyUp(row, " ")).toBe(false);
    expect(dom.key(row, " ")).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("leaves Space alone in a text field, and keeps it for a control outside any row", async () => {
    const { document } = dom;
    const field = document.createElement("input");
    const button = document.createElement("button");
    const hidden = document.createElement("div");
    hidden.setAttribute("hidden", "");
    // A destination that stays mounted while hidden still holds a selected, peekable row.
    hidden.innerHTML = `<div data-quick-look="${note(5)}" aria-selected="true"></div>`;
    document.body.append(field, button, hidden);
    await mount();
    dom.focus(field);
    expect(dom.key(field, " ")).toBe(true);
    dom.focus(button);
    expect(dom.key(button, " ")).toBe(true);
    expect(store.get()).toBeNull();
    // Cmd-Y also skips the hidden row.
    dom.key(button, "y", { metaKey: true, code: "KeyY" });
    expect(store.get()).toBeNull();
  });

  it("moves the peek when the focus moves to another row", async () => {
    const { document } = dom;
    const a = document.createElement("button");
    const b = document.createElement("button");
    a.setAttribute("data-quick-look", note(6));
    b.setAttribute("data-quick-look", note(7));
    document.body.append(a, b);
    await mount();
    dom.focus(a);
    dom.key(a, " ");
    expect(store.get()).toBe(note(6));
    dom.focus(b);
    expect(store.get()).toBe(note(7));
  });

  it("shows the sheet without taking the focus, closes on Esc, and never answers Cmd-W", async () => {
    const input = paletteList();
    await mount();
    dom.focus(input);
    dom.key(input, "y", { metaKey: true, code: "KeyY" });
    await frame();
    const sheet = dom.document.querySelector('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute("aria-modal")).not.toBe("true");
    expect(dom.document.activeElement).toBe(input);
    // Cmd-W asks `openDialogs` for the topmost dialog: the preview is not one.
    expect(openDialogs(dom.document)).toEqual([]);
    // A real dialog opened over it is still the one Cmd-W closes.
    const real = dom.document.createElement("div");
    real.setAttribute("role", "dialog");
    dom.document.body.append(real);
    expect(openDialogs(dom.document)).toEqual([real]);
    real.remove();

    dom.key(dom.document.body, "Escape");
    await frame();
    expect(store.get()).toBeNull();
    expect(dom.document.querySelector('[role="dialog"]')).toBeNull();
  });
});
