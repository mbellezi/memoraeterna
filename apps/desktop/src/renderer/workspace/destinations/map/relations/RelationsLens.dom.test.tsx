// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../../test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { branchTopics, sampleBranch } from "./branch-fixtures";
import { RelationsLens, type RelationsLensProps } from "./RelationsLens";

// The Grafo lens in a real DOM: what the header does when the read fails, and what a pick reports.
vi.mock("../../../../components/graph/webgl", () => ({ isWebGLAvailable: () => true }));

const en = createTranslator("en");
let dom: TestDom;
const branch = vi.fn();
const picked: unknown[] = [];

const settle = () => dom.act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

beforeEach(() => {
  branch.mockReset();
  picked.length = 0;
  dom = createTestDom();
  (dom.window as unknown as { app: unknown }).app = {
    relations: { branch },
    topics: { tree: () => Promise.resolve({ nodes: [] }) },
    objects: { resolveMany: () => Promise.resolve({ items: {} }) },
    settings: { getApp: () => Promise.resolve({ graphWheelZoomSensitivity: 1 }) },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
});

const lens = (overrides: Partial<RelationsLensProps> = {}) => (
  <RelationsLens
    t={en}
    active
    scope={{ kind: "topic", id: branchTopics.fermentation }}
    onOpenNote={() => undefined}
    onShowTree={() => undefined}
    frame={{ surface: "map-relations", display: "table" }}
    {...overrides}
  />
);

const chip = () =>
  dom.document.querySelector(
    `button[aria-label="${en("mapRelations.scope.menu")}"]`
  ) as HTMLButtonElement | null;
const depthRests = () =>
  [...depthGroup().querySelectorAll("button")].every((item) => item.hasAttribute("disabled"));
const depthGroup = () => dom.document.querySelector('[role="group"][aria-label]') as HTMLElement;

describe("the Grafo header when the read fails (the way out stays open)", () => {
  it("keeps the branch chip enabled, naming what it is for, and rests the depth control", async () => {
    branch.mockRejectedValue(new Error("no"));
    await dom.render(lens());
    await settle();
    expect(dom.document.querySelector("[data-state=error]")).not.toBeNull();
    const button = chip();
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    expect(button!.textContent).toContain("Choose the branch");
    expect(depthRests()).toBe(true);
    // The table alone says connections, not a graph it never drew.
    expect(dom.document.body.textContent).toContain(
      "The connections of this branch could not be loaded."
    );
    expect(dom.document.body.textContent).not.toContain("The graph could not be loaded.");
  });

  it("rests the depth control and keeps the chip for a branch that is gone", async () => {
    branch.mockResolvedValue(null);
    await dom.render(lens());
    await settle();
    expect(chip()!.disabled).toBe(false);
    expect(depthRests()).toBe(true);
  });

  it("waits only while the first read is under way, and keeps the depth control for a connected branch", async () => {
    branch.mockImplementation(() => new Promise(() => undefined));
    await dom.render(lens());
    expect(chip()!.disabled).toBe(true);
    await dom.dispose();
    dom = createTestDom();
    (dom.window as unknown as { app: unknown }).app = {
      relations: { branch: () => Promise.resolve(sampleBranch()) },
      topics: { tree: () => Promise.resolve({ nodes: [] }) },
      objects: { resolveMany: () => Promise.resolve({ items: {} }) },
      settings: { getApp: () => Promise.resolve({ graphWheelZoomSensitivity: 1 }) },
      onAppEvent: () => () => undefined
    };
    await dom.render(lens());
    await settle();
    expect(chip()?.disabled ?? false).toBe(false);
    expect(depthRests()).toBe(false);
  });
});

describe("a picked branch is reported to the host", () => {
  it("calls onScopeChange with the branch chosen outside the one on screen", async () => {
    branch.mockResolvedValue(sampleBranch());
    await dom.render(lens({ onScopeChange: (scope) => void picked.push(scope) }));
    await settle();
    const outside = dom.document.querySelector(
      "section[aria-label] ul button[title]"
    ) as HTMLButtonElement | null;
    const target = [...dom.document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("História da ciência")
    );
    expect(outside ?? target).toBeTruthy();
    await dom.act(() => void (target as HTMLButtonElement).click());
    expect(picked).toEqual([{ kind: "topic", id: branchTopics.history }]);
  });
});
