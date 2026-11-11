import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { destinationRoots } from "./destinations";
import { panelStackStyles } from "./panel-stack-styles";
import { layoutConfig, prevShowsAt, tierFor, topMinFor } from "./layout-config";
import {
  matchPanel,
  PanelStack,
  panelRegistry,
  registerPanels,
  stackView,
  type PanelModule,
  type StackView
} from "./PanelStack";
import { layoutCustomProperties } from "./shell-model";
import { defaultWorkspace, stackWidth, type LayoutChrome, type Stack } from "./state";
import * as legacyPanel from "./views/legacy.panel";

const stylesheet = panelStackStyles;
const en = createTranslator("en");
const noop = () => undefined;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number) => `memora://note/${uuid(n)}`;

/** A stack of `count` note panels on Explore's root, focused on `focus` (the last by default). */
function stackOf(count: number, focus = count - 1): Stack {
  return {
    root: destinationRoots.explore,
    panels: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      history: [note(index + 1)],
      index: 0
    })),
    focus,
    closed: []
  };
}

/** The top panel's width as the host draws the view: the stack less the compact panel and spines. */
function topWidth(view: StackView, width: number, chrome: LayoutChrome): number {
  const tier = tierFor(width);
  const stack = stackWidth(width, chrome, tier);
  const compact = view.items.some((item) => item.mode === "compact") ? tier.prevW : 0;
  const spines =
    view.items.filter((item) => item.mode === "spine" && !item.merged).length +
    (view.merged.length > 0 ? 1 : 0) +
    (view.mergedAhead.length > 0 ? 1 : 0);
  return stack - compact - spines * tier.spineW;
}

const chromes: readonly LayoutChrome[] = [
  { navigator: true, context: false },
  { navigator: false, context: false },
  { navigator: true, context: true }
];

describe("the host lays the stack out with layout() at 960, 1280 and 1440 px", () => {
  for (const width of [960, 1280, 1440])
    for (const chrome of chromes)
      for (let count = 1; count <= 8; count += 1)
        it(`${width} px, ${count} panels, navigator ${chrome.navigator}, context ${chrome.context}`, () => {
          const view = stackView(stackOf(count), width, chrome);
          // One top panel, the focused one; the root and every panel are an item.
          expect(view.items).toHaveLength(count + 1);
          expect(view.items.filter((item) => item.mode === "full").map((i) => i.panel)).toEqual([
            count - 1
          ]);
          expect(view.top).toBe(count - 1);
          // The previous panel is compact only from an 848 px stack, and it is the one left of the top.
          const compact = view.items.filter((item) => item.mode === "compact");
          const stack = stackWidth(width, chrome);
          if (stack < prevShowsAt(tierFor(width))) expect(compact).toEqual([]);
          for (const item of compact) expect(item.panel).toBe(count - 2);
          // At most six spines and the "+N" one; the merged ones are the oldest, from the left.
          const drawnSpines = view.items.filter((item) => item.mode === "spine" && !item.merged);
          expect(drawnSpines.length).toBeLessThanOrEqual(layoutConfig.maxSpines);
          expect(view.merged).toEqual(view.items.filter((i) => i.merged).map((i) => i.panel));
          if (view.merged.length > 0)
            expect(view.merged).toEqual(
              Array.from({ length: view.merged.length }, (_, index) => index - 1)
            );
          // The top keeps its floor (568, or 552 at a 960-999 px window) whenever one spine leaves room.
          const floor = topMinFor(width);
          if (stack - tierFor(width).spineW >= floor)
            expect(topWidth(view, width, chrome)).toBeGreaterThanOrEqual(floor);
          // Nothing is left of the top but the trail; nothing right of it in a stack focused at its end.
          expect(view.items.every((item) => item.side === "left")).toBe(true);
        });

  it("keeps the 552 floor at a 960 px window with two spines and merges the older ones", () => {
    const chrome = { navigator: true, context: false };
    const view = stackView(stackOf(6), 960, chrome);
    expect(topWidth(view, 960, chrome)).toBeGreaterThanOrEqual(layoutConfig.topMinAtWindowMin);
    const drawn = view.items.filter((item) => item.mode === "spine" && !item.merged).length;
    expect(drawn + (view.merged.length > 0 ? 1 : 0)).toBeLessThanOrEqual(3);
    expect(view.merged.length).toBeGreaterThan(0);
  });

  it("shows the previous panel compact at 1440 with the navigator, beside a 568 px top", () => {
    const chrome = { navigator: true, context: false };
    const view = stackView(stackOf(3), 1440, chrome);
    expect(view.items.map((item) => item.mode)).toEqual(["spine", "spine", "compact", "full"]);
    expect(topWidth(view, 1440, chrome)).toBeGreaterThanOrEqual(layoutConfig.topMin);
  });

  it("puts the panels right of a focused one on the forward trail", () => {
    const view = stackView(stackOf(4, 1), 1440, { navigator: true, context: false });
    expect(view.items.filter((item) => item.side === "right").map((i) => i.panel)).toEqual([2, 3]);
    expect(view.items.find((item) => item.panel === 1)?.mode).toBe("full");
  });

  it("draws no compact panel in focus mode: the sheet stands beside spines", () => {
    const chrome = { navigator: false, context: false };
    expect(stackView(stackOf(3), 1440, chrome).items.map((item) => item.mode)).toContain("compact");
    const focus = stackView(stackOf(3), 1440, chrome, new Set(), true);
    expect(focus.items.map((item) => item.mode)).toEqual(["spine", "spine", "spine", "full"]);
  });

  it("keeps panels ahead of a focused root right of it, never among the older ones", () => {
    const view = stackView(stackOf(4, -1), 960, { navigator: true, context: false });
    expect(view.top).toBe(-1);
    expect(view.merged).toEqual([]);
    expect(view.mergedAhead).toEqual([0, 1]);
    expect(view.items.filter((item) => item.merged).every((item) => item.side === "right")).toBe(
      true
    );
  });

  it("never merges a single panel into a +1 spine, and keeps six spines at most", () => {
    for (const chrome of chromes)
      for (const width of [960, 1280, 1440, 1680])
        for (let count = 1; count <= 8; count += 1)
          for (let focus = -1; focus < count; focus += 1) {
            const view = stackView(stackOf(count, focus), width, chrome);
            expect(view.merged.length).not.toBe(1);
            expect(view.mergedAhead.length).not.toBe(1);
            for (const focusMode of [false, true]) {
              const drawn = stackView(stackOf(count, focus), width, chrome, new Set(), focusMode);
              const spines = drawn.items.filter((item) => item.mode === "spine" && !item.merged);
              expect(spines.length).toBeLessThanOrEqual(layoutConfig.maxSpines);
            }
          }
    // At 1440 px with the navigator and 8 panels, layout() merges the root alone; the next joins it.
    const view = stackView(stackOf(8), 1440, { navigator: true, context: false });
    expect(view.merged).toEqual([-1, 0]);
  });

  it("draws a root with no compact form as its spine", () => {
    const view = stackView(stackOf(1), 1440, { navigator: false, context: false }, new Set([-1]));
    expect(view.items.map((item) => item.mode)).toEqual(["spine", "full"]);
  });
});

describe("the stylesheet and layout-config.ts", () => {
  it("names the stack container and shows the previous panel at prevShowsAt for every tier", () => {
    expect(stylesheet).toMatch(/container-type:\s*inline-size/u);
    expect(stylesheet).toMatch(/container-name:\s*stack/u);
    const queries = [...stylesheet.matchAll(/@container\s+stack\s*\(min-width:\s*(\d+)px\)/gu)];
    expect(queries.length).toBeGreaterThan(0);
    for (const tier of layoutConfig.tiers)
      for (const query of queries) expect(Number(query[1])).toBe(prevShowsAt(tier));
  });

  it("reads only the custom properties the shell writes from the configuration", () => {
    const written = new Set(Object.keys(layoutCustomProperties(1440)));
    const layoutProperties = [
      ...stylesheet.matchAll(/var\((--(?:prev|spine|top|rail|nav|ctx)-[a-z]+)\)/gu)
    ];
    expect(layoutProperties.length).toBeGreaterThan(0);
    for (const match of layoutProperties) expect(written.has(match[1] as string)).toBe(true);
  });
});

describe("panel registration", () => {
  const fakes = registerPanels(import.meta.glob("./test-panels/*.panel.tsx", { eager: true }));

  it("finds a panel module by file and matches it by address", () => {
    expect(fakes.map((module) => module.kind)).toEqual(["fake"]);
    expect(matchPanel(fakes, note(1))?.kind).toBe("fake");
    expect(matchPanel(fakes, destinationRoots.explore)).toBeNull();
  });

  it("refuses a file that does not export the four parts", () => {
    expect(() => registerPanels({ "./panels/broken.panel.tsx": { kind: "broken" } })).toThrow(
      /broken\.panel\.tsx must export/u
    );
  });

  it("registers every file of panels/ in shape", () => {
    for (const module of panelRegistry) expect(typeof module.match).toBe("function");
  });

  it("shares one legacy root between Home and the Library, and gives Explore its own", () => {
    expect(legacyPanel.match(destinationRoots.home)).toBe(true);
    expect(legacyPanel.match(note(1))).toBe(false);
    expect(legacyPanel.rootKey(destinationRoots.home)).toBe(
      legacyPanel.rootKey(destinationRoots.library)
    );
    expect(legacyPanel.rootKey(destinationRoots.explore)).not.toBe(
      legacyPanel.rootKey(destinationRoots.library)
    );
  });
});

describe("the host", () => {
  const registry: readonly PanelModule[] = [
    ...registerPanels(import.meta.glob("./test-panels/*.panel.tsx", { eager: true })),
    {
      kind: "root",
      match: (address) => !address.startsWith("memora://note/"),
      title: () => "",
      Component: ({ address }) => <p data-root-surface={address} />
    }
  ];

  function render(count: number, width: number, focus?: number, focusMode = false) {
    const workspace = defaultWorkspace("2026-11-11");
    workspace.destination = "explore";
    workspace.stacks.explore = stackOf(count, focus);
    workspace.stacks.library = { ...stackOf(1), root: destinationRoots.library };
    return renderToString(
      <PanelStack
        t={en}
        workspace={workspace}
        dispatch={noop}
        viewportWidth={width}
        chrome={{ navigator: true, context: false }}
        focusMode={focusMode}
        registry={registry}
      />
    );
  }

  it("reports its own frame, the top panel's state, and frames the drawn panels", () => {
    const html = render(3, 1440);
    expect(html).toContain('data-surface="panel-stack"');
    expect(html).toContain('data-state="loading"');
    expect(html.match(/data-surface="fake"/gu)).toHaveLength(3);
    expect(html).toContain('data-panel-mode="full"');
    expect(html).toContain('data-panel-mode="compact"');
    // The compact panel has a spine twin the container query shows below 848 px.
    expect(html).toContain("data-prev-twin");
  });

  it("draws older panels as spines named as a trail", () => {
    const html = render(4, 1440);
    expect(html).toContain("Note. Reopen");
    expect(html).toContain("Explore. Reopen");
  });

  it("leads the root spine with its destination's glyph, and holds a bar where a title is read", () => {
    const html = render(4, 1440);
    const root = html.match(/<button[^>]*aria-label="Explore\. Reopen"[^>]*>(.*?)<\/button>/u);
    expect(root?.[1]).toContain("<svg");
    // Before `resolveMany` answers, an object spine shows its kind word and a bar, not "Untitled".
    expect(html).toContain("data-pending");
    expect(html).not.toContain("Untitled");
  });

  it("merges spines beyond the floor into one +N spine at 960 px", () => {
    const html = render(8, 960);
    expect(html).toMatch(/older panels: /u);
    expect(html).toContain("panel-stack__spine-count");
  });

  it("draws the panels ahead of a focused root after it, as panels ahead", () => {
    const html = render(4, 960, -1);
    expect(html).not.toMatch(/older panels/u);
    expect(html).toMatch(/2 panels ahead: /u);
    // The trail stays in order: the root, then the merged panels ahead, then the forward spines.
    const root = html.indexOf("data-root-surface");
    const ahead = html.indexOf("panels ahead");
    const forward = html.indexOf('data-side="right" aria-label="Note. Reopen"');
    expect(root).toBeGreaterThan(-1);
    expect(ahead).toBeGreaterThan(root);
    expect(forward).toBeGreaterThan(ahead);
  });

  it("draws spines and the sheet only in focus mode", () => {
    expect(render(3, 1680)).toContain('data-panel-mode="compact"');
    const html = render(3, 1680, undefined, true);
    expect(html).not.toContain('data-panel-mode="compact"');
    expect(html).toContain('data-panel-mode="full"');
    expect(html).toContain("data-focus-mode");
  });

  it("gives every panel a channel to report its place to the frame's ribbon", () => {
    const places = [
      ...registry,
      {
        kind: "placing",
        match: (address: string) => address.startsWith("memora://note/"),
        title: () => "",
        Component: ({ onPlace }: { onPlace?: unknown }) => <p data-reports-place={typeof onPlace} />
      }
    ];
    const workspace = defaultWorkspace("2026-11-11");
    workspace.destination = "explore";
    workspace.stacks.explore = stackOf(1);
    const html = renderToString(
      <PanelStack
        t={en}
        workspace={workspace}
        dispatch={noop}
        viewportWidth={1440}
        chrome={{ navigator: true, context: false }}
        registry={places.filter((module) => module.kind !== "fake")}
      />
    );
    expect(html).toContain('data-reports-place="function"');
  });

  it("keeps a hidden destination's drawn panel mounted, hidden", () => {
    const html = render(1, 1440);
    expect(html.match(/data-surface="fake"/gu)).toHaveLength(2);
    expect(html).toMatch(/data-mode="full" hidden=""/u);
  });
});
