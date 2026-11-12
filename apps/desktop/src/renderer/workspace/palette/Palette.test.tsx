// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { quickLookTarget } from "../QuickLookModel";
import { createPreviewBatcher } from "../preview-batcher";
import { defaultWorkspace } from "../state";
import { Palette } from "./Palette";
import { omniFixture, recentFixture, resolveManyFixture } from "./palette-fixtures";
import type { PaletteEffect } from "./palette-model";

const t = createTranslator("pt-BR");
let dom: TestDom;

beforeEach(() => {
  dom = createTestDom();
  // What cmdk and the focus code call and a small DOM does not have.
  const proto = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as Record<string, unknown>;
  proto.scrollIntoView = () => undefined;
  proto.setSelectionRange = () => undefined;
  (dom.window as unknown as { app: unknown }).app = {
    search: { omni: (input: never) => Promise.resolve(omniFixture(false)(input)) },
    objects: { resolveMany: (input: never) => Promise.resolve(resolveManyFixture()(input)) },
    viewHistory: { list: () => Promise.resolve(recentFixture(false)()) },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
});

const settle = () => dom.act(() => new Promise<void>((done) => setTimeout(done, 20)));

async function open(initialQuery: string) {
  const effects: PaletteEffect[] = [];
  const onClose = vi.fn();
  const batcher = createPreviewBatcher({
    resolveMany: (input) => Promise.resolve(resolveManyFixture()(input))
  });
  await dom.render(
    createElement(Palette, {
      t,
      state: defaultWorkspace("2026-11-11"),
      initialQuery,
      onEffect: (effect: PaletteEffect) => effects.push(effect),
      onClose,
      portal: false,
      batcher
    })
  );
  await settle();
  return { effects, onClose };
}

/** The address of the row cmdk marks selected (the one Enter opens). */
function highlightedAddress(): string | null {
  const row = dom.document.querySelector("[data-palette-row][aria-selected=true]");
  return row?.getAttribute("data-quick-look") ?? null;
}

const root = () => dom.document.querySelector("[cmdk-root]") as HTMLElement;

describe("Cmd-K", () => {
  it("lists the groups with 'mostrar mais' and the foot of the design record", async () => {
    await open("ferment");
    const groups = [...dom.document.querySelectorAll("[data-palette-group]")].map((group) =>
      group.getAttribute("data-palette-group")
    );
    expect(groups).toEqual(["best", "topic", "note", "sourceEntity", "question", "do"]);
    const text = dom.document.body.textContent ?? "";
    expect(text).toContain("mostrar mais (2)");
    expect(text).toContain("abrir neste painel");
    expect(text).toContain("todos os resultados");
    expect(text).toContain("espiar");
    expect(text).not.toContain("primeiro");
    expect(dom.document.querySelector("[data-surface=palette]")?.getAttribute("data-state")).toBe(
      "success"
    );
  });

  it("marks each row for quick-look with its address", async () => {
    await open("ferment");
    const rows = [...dom.document.querySelectorAll("[data-palette-row=result]")];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(row.getAttribute("data-quick-look")).toMatch(/^memora:\/\//);
  });

  it("Enter opens the highlighted row beside, and closes", async () => {
    const { effects, onClose } = await open("ferment");
    const highlighted = highlightedAddress();
    expect(highlighted).toMatch(/^memora:\/\/topic\//);
    dom.key(root(), "Enter");
    expect(effects).toEqual([{ type: "open", replace: false, address: highlighted }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter opens the row the arrows moved to, not the first", async () => {
    const { effects } = await open("ferment");
    const first = highlightedAddress();
    dom.key(root(), "ArrowDown");
    await settle();
    const second = highlightedAddress();
    expect(second).not.toBe(first);
    dom.key(root(), "Enter");
    expect(effects).toEqual([{ type: "open", replace: false, address: second }]);
  });

  it("Cmd-Y peeks at the highlighted row, and at the next one after ArrowDown", async () => {
    await open("ferment");
    const first = highlightedAddress();
    expect(quickLookTarget(dom.document)).toBe(first);
    dom.key(root(), "ArrowDown");
    await settle();
    const second = highlightedAddress();
    expect(second).not.toBe(first);
    expect(quickLookTarget(dom.document)).toBe(second);
  });

  it("Option-Enter opens it in this panel and Shift-Enter opens the results panel", async () => {
    const first = await open("ferment");
    dom.key(root(), "Enter", { altKey: true });
    expect(first.effects[0]).toMatchObject({ type: "open", replace: true });
    await dom.dispose();
    dom = createTestDom();
    (dom.window as unknown as { app: unknown }).app = {
      search: { omni: (input: never) => Promise.resolve(omniFixture(false)(input)) },
      objects: { resolveMany: (input: never) => Promise.resolve(resolveManyFixture()(input)) },
      viewHistory: { list: () => Promise.resolve([]) },
      onAppEvent: () => () => undefined
    };
    const second = await open("ferment");
    dom.key(root(), "Enter", { shiftKey: true });
    expect(second.effects).toEqual([
      { type: "open", address: "memora://search?q=ferment", replace: false }
    ]);
  });

  it("'mostrar mais' opens the results panel filtered to the group's kind", async () => {
    const { effects } = await open("ferment");
    const more = [...dom.document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("mostrar mais")
    ) as HTMLButtonElement;
    await dom.act(() => void more.click());
    expect(effects[0]).toMatchObject({
      type: "open",
      address: expect.stringMatching(/^memora:\/\/search\?q=ferment&kinds=/)
    });
  });

  it("shows nothing found with the ways forward, and the empty box with recents", async () => {
    (dom.window as unknown as { app: { search: { omni: unknown } } }).app.search.omni = (
      input: never
    ) => Promise.resolve(omniFixture(true)(input));
    await open("zzz");
    expect(dom.document.querySelector("[data-surface=palette]")?.getAttribute("data-state")).toBe(
      "empty"
    );
    expect(dom.document.body.textContent).toContain("Nada com “zzz”.");
    await dom.dispose();
    dom = createTestDom();
    (dom.window as unknown as { app: unknown }).app = {
      search: { omni: () => Promise.reject(new Error("no")) },
      objects: { resolveMany: (input: never) => Promise.resolve(resolveManyFixture()(input)) },
      viewHistory: { list: () => Promise.resolve(recentFixture(false)()) },
      onAppEvent: () => () => undefined
    };
    await open("");
    const groups = [...dom.document.querySelectorAll("[data-palette-group]")].map((group) =>
      group.getAttribute("data-palette-group")
    );
    expect(groups).toEqual(["recent", "pinned", "do"]);
  });

  it("says a search failed in place and keeps the actions", async () => {
    (dom.window as unknown as { app: { search: { omni: unknown } } }).app.search.omni = () =>
      Promise.reject(new Error("no"));
    await open("ferment");
    expect(dom.document.querySelector("[data-surface=palette]")?.getAttribute("data-state")).toBe(
      "error"
    );
    expect(dom.document.querySelector("[role=alert]")?.textContent).toContain(
      "Não foi possível buscar agora."
    );
    expect(dom.document.querySelector("[data-palette-row=ask]")).not.toBeNull();
  });
});
