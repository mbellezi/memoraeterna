// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import type { PanelProps } from "../../PanelStack";
import { formatView } from "../../route";
import { MapRoot } from "./MapRoot";
import { branchTopics, sampleBranch } from "./relations/branch-fixtures";

// Without WebGL the Grafo is its table alone: the branch picks are plain buttons.
vi.mock("../../../components/graph/webgl", () => ({ isWebGLAvailable: () => false }));

let dom: TestDom;
const opened: { address: string; options: unknown }[] = [];

beforeEach(() => {
  opened.length = 0;
  dom = createTestDom();
  (dom.window as unknown as { app: unknown }).app = {
    relations: { branch: () => Promise.resolve(sampleBranch()) },
    topics: { tree: () => Promise.resolve({ nodes: [] }) },
    objects: { resolveMany: () => Promise.resolve({ items: {} }) },
    settings: { getApp: () => Promise.resolve({ graphWheelZoomSensitivity: 1 }) },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
});

const props = (address: string): PanelProps =>
  ({
    t: createTranslator("en"),
    address,
    mode: "full",
    active: true,
    onState: () => undefined,
    onPlace: () => undefined,
    onOpen: (next: string, options?: unknown) => void opened.push({ address: next, options })
  }) as PanelProps;

describe("the Grafo's picked branch lives in the Map's address", () => {
  it("replaces the address with the branch picked, so a note opened beside does not lose it", async () => {
    await dom.render(
      <MapRoot
        {...props(
          formatView({
            view: "map",
            lens: "relations",
            scope: { kind: "topic", id: branchTopics.fermentation }
          })
        )}
      />
    );
    await dom.act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
    const outside = [...dom.document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("História da ciência")
    ) as HTMLButtonElement;
    expect(outside).toBeTruthy();
    await dom.act(() => void outside.click());
    expect(opened).toEqual([
      {
        address: formatView({
          view: "map",
          lens: "relations",
          scope: { kind: "topic", id: branchTopics.history }
        }),
        options: { replace: true }
      }
    ]);
  });
});
