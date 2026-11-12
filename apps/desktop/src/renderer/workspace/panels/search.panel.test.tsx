// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import type { PanelProps } from "../PanelStack";
import { omniFixture, recentFixture, resolveManyFixture } from "../palette/palette-fixtures";
import { formatView } from "../route";
import { Component } from "./search.panel";

const t = createTranslator("pt-BR");
const address = formatView({ view: "search", query: "ferment" });
let dom: TestDom;
let calls: Array<{ mode: string }>;
let failing: boolean;

beforeEach(() => {
  dom = createTestDom();
  calls = [];
  failing = false;
  (dom.window as unknown as { app: unknown }).app = {
    search: {
      omni: (input: { mode: string }) => {
        calls.push(input);
        return failing
          ? Promise.reject(new Error("failed"))
          : Promise.resolve(omniFixture(false)(input as never));
      }
    },
    objects: { resolveMany: (input: never) => Promise.resolve(resolveManyFixture()(input)) },
    viewHistory: { list: () => Promise.resolve(recentFixture(false)()) },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
});

const settle = () => dom.act(() => new Promise<void>((done) => setTimeout(done, 20)));
const props = (active: boolean): PanelProps => ({
  t,
  address,
  mode: "full",
  active,
  onState: vi.fn(),
  onPlace: vi.fn(),
  onOpen: vi.fn()
});
const show = (active: boolean) => dom.render(createElement(Component, props(active)));
const rows = () => dom.document.querySelectorAll("[data-quick-look]").length;
const skeleton = () => dom.document.querySelector("[data-search-skeleton]") !== null;

describe("the search results panel, hidden and shown again", () => {
  it("asks for nothing while it has never been shown", async () => {
    await show(false);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("keeps its rows while hidden, with no skeleton, and refreshes in place when shown", async () => {
    await show(true);
    await settle();
    const before = rows();
    expect(before).toBeGreaterThan(3);
    expect(calls).toHaveLength(1);

    await show(false);
    await settle();
    expect(rows()).toBe(before);
    expect(skeleton()).toBe(false);
    expect(calls).toHaveLength(1);

    await show(true);
    expect(rows()).toBe(before);
    expect(skeleton()).toBe(false);
    await settle();
    expect(calls).toHaveLength(2);
    expect(rows()).toBe(before);
  });

  it("leaves a failed load visible while hidden and shown, without asking again by itself", async () => {
    failing = true;
    await show(true);
    await settle();
    expect(dom.document.body.textContent).toContain("Tentar de novo");
    await show(false);
    await settle();
    await show(true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(dom.document.body.textContent).toContain("Tentar de novo");
  });
});
