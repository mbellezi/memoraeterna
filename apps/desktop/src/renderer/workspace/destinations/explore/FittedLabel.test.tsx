import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import type { NavRowOps } from "../../../components/topics/ops/nav-ops";
import { TopicNavTree } from "../../../components/topics/TopicNavTree";
import { id, nodeSummary } from "../../../components/topics/topic-fixtures";
import {
  branchDataFromTree,
  emptyBranch,
  navOverscan,
  rootBranchKey,
  topicRows,
  windowIndexes
} from "../../../components/topics/topic-navigation";
import { cachedMeasure, FittedLabel, fitInto, labelFitStats, WrappedLabel } from "./FittedLabel";
import { fitLabel } from "./label-fit";

const tree = (count: number) => {
  const nodes = Array.from({ length: count }, (_, index) =>
    nodeSummary({
      id: id(10 + index),
      title: `Microbiologia dos alimentos fermentados, capítulo ${index}`,
      items: index,
      children: 0,
      directItems: 0,
      position: index
    })
  );
  return new Map([
    [
      rootBranchKey,
      emptyBranch(
        "ready",
        branchDataFromTree({
          generation: 1,
          parent: nodeSummary({ id: id(1), title: null, items: count, children: count }),
          nodes,
          items: [],
          moreItems: 0,
          unsorted: 0,
          nextCursor: null
        })
      )
    ]
  ]);
};

describe("the label of a row", () => {
  it("keeps the whole text for assistive technology and draws a fitted one", () => {
    const html = renderToString(<FittedLabel text="Microbiologia dos alimentos, cap. 3" />);
    expect(html).toContain('data-fit-label=""');
    expect(html).toContain('<span class="sr-only">Microbiologia dos alimentos, cap. 3</span>');
    expect(html).toContain('aria-hidden="true">Microbiologia dos alimentos, cap. 3</span>');
  });

  it("measures each distinct string once, however many rows share it", () => {
    let calls = 0;
    const measure = cachedMeasure((text) => {
      calls += 1;
      return [...text].length;
    });
    for (let row = 0; row < 50; row += 1)
      fitLabel("Temperatura controla a acidez final", measure, 17);
    const once = calls;
    for (let row = 0; row < 50; row += 1)
      fitLabel("Temperatura controla a acidez final", measure, 17);
    expect(calls).toBe(once);
    // A word-boundary fit tries a handful of forms, never one per character.
    expect(once).toBeLessThan(12);
  });
});

describe("a tree of about 3,000 topics", () => {
  it("fits only the rows its window draws", () => {
    const branches = tree(3000);
    const rows = topicRows(branches, new Set());
    expect(rows).toHaveLength(3000);
    const html = renderToString(
      <TopicNavTree
        t={createTranslator("pt-BR")}
        rows={rows}
        labelledBy="x"
        windowed
        selectedTopicId={null}
        onToggle={() => undefined}
        onActivate={() => undefined}
      />
    );
    const fitted = html.match(/data-fit-label=""/gu)?.length ?? 0;
    // A screenful and its overscan: the first window, never the 3,000 rows.
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThanOrEqual(60);
    expect(html).toContain("capítulo 0");
    expect(html).not.toContain("capítulo 2999");
  });
});

describe("the cost of fitting a tree of about 3,000 topics", () => {
  it("measures strings only for the rows of its window, a small constant each", () => {
    const rows = topicRows(tree(3000), new Set());
    const drawn = windowIndexes(rows.length, { first: 0, end: 40 }, navOverscan);
    expect(drawn.length).toBeLessThan(100);
    const font = "normal 400 14px sans-serif";
    const titles = rows.map((row) => (row.type === "topic" ? (row.node.title ?? "") : ""));
    const before = labelFitStats.measured;
    for (const index of drawn) fitInto(titles[index]!, font, 14, 120);
    const window = labelFitStats.measured - before;
    // A word-boundary fit tries a handful of forms for one label: never one per character.
    expect(window).toBeGreaterThan(0);
    expect(window).toBeLessThanOrEqual(drawn.length * 12);
    // The same widths again come from the cache: nothing is measured twice.
    for (const index of drawn) fitInto(titles[index]!, font, 14, 120);
    expect(labelFitStats.measured - before).toBe(window);
    // Fitting every row would cost about the whole tree: the window is what bounds it.
    const whole = labelFitStats.measured;
    for (const title of titles) fitInto(title, font, 14, 120);
    expect(labelFitStats.measured - whole).toBeGreaterThan(window * 10);
  });
});

describe("the open row and its ancestors", () => {
  it("draw their whole name on up to two lines, the others are cut at word boundaries", () => {
    const rows = topicRows(tree(5), new Set());
    const html = renderToString(
      <TopicNavTree
        t={createTranslator("pt-BR")}
        rows={rows}
        labelledBy="x"
        windowed
        selectedTopicId={id(11)}
        onToggle={() => undefined}
        onActivate={() => undefined}
      />
    );
    expect(html.match(/data-wrap-label=""/gu)).toHaveLength(1);
    expect(html.match(/data-fit-label=""/gu)).toHaveLength(4);
    expect(html).toContain(
      '<span class="sr-only">Microbiologia dos alimentos fermentados, capítulo 1</span>'
    );
  });

  it("show their count in the compact tier, the other rows only on hover and focus", () => {
    const rows = topicRows(tree(3), new Set());
    const draw = (quietCounts: boolean) =>
      renderToString(
        <TopicNavTree
          t={createTranslator("pt-BR")}
          rows={rows}
          labelledBy="x"
          selectedTopicId={id(11)}
          quietCounts={quietCounts}
          onToggle={() => undefined}
          onActivate={() => undefined}
        />
      );
    const onDemand = (html: string) =>
      html.match(/pointer-events-none absolute inset-y-\[3px\]/gu)?.length ?? 0;
    // Three rows, one open: the open row keeps its count in the row, the two others show theirs on demand.
    expect(onDemand(draw(true))).toBe(2);
    expect(onDemand(draw(false))).toBe(0);
    // The overlay stays inside the 2 px focus ring: it never starts at the row's top or bottom edge.
    expect(draw(true)).not.toContain("absolute inset-y-0 ");
  });

  it("keep the on-demand count clear of the row's actions button", () => {
    const rows = topicRows(tree(3), new Set());
    const ops: NavRowOps = {
      renamingKey: null,
      invalid: false,
      busy: false,
      pinnedItems: new Set(),
      onStartRename: () => undefined,
      onCommitRename: () => undefined,
      onCancelRename: () => undefined,
      onOpenMenu: () => undefined
    };
    const draw = (withOps: boolean) =>
      renderToString(
        <TopicNavTree
          t={createTranslator("pt-BR")}
          rows={rows}
          labelledBy="x"
          selectedTopicId={id(11)}
          quietCounts
          ops={withOps ? ops : undefined}
          onToggle={() => undefined}
          onActivate={() => undefined}
        />
      );
    expect(draw(true)).toContain("right-8");
    expect(draw(true)).not.toContain("right-2 ");
    expect(draw(false)).not.toContain("right-8");
  });

  it("wrap whole words: the rendered label keeps the full text", () => {
    const html = renderToString(<WrappedLabel text="Fermentação láctica de hortaliças" />);
    expect(html).toContain('data-wrap-label=""');
    expect(html).toContain("Fermentação láctica de hortaliças");
  });
});

describe("a hoisted tree", () => {
  it("starts at the hoisted topic: its subtopics are the top level", () => {
    const hoisted = id(2);
    const branches = new Map(tree(3));
    branches.set(
      hoisted,
      emptyBranch(
        "ready",
        branchDataFromTree({
          generation: 1,
          parent: nodeSummary({ id: hoisted, title: "Fermentação", items: 54, children: 2 }),
          nodes: [
            nodeSummary({ id: id(20), title: "Láctica", items: 18, children: 0, directItems: 0 }),
            nodeSummary({ id: id(21), title: "Alcoólica", items: 9, children: 0, directItems: 0 })
          ],
          items: [],
          moreItems: 0,
          unsorted: 0,
          nextCursor: null
        })
      )
    );
    const rows = topicRows(branches, new Set(), hoisted);
    expect(rows.map((row) => (row.type === "topic" ? row.node.title : row.type))).toEqual([
      "Láctica",
      "Alcoólica"
    ]);
    expect(rows.every((row) => row.level === 1)).toBe(true);
  });

  it("shows a loading row while the hoisted branch is read", () => {
    const rows = topicRows(tree(3), new Set(), id(99));
    expect(rows.map((row) => row.type)).toEqual(["status"]);
  });
});
