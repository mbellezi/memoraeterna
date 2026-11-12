import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { TopicNavTree } from "../../../components/topics/TopicNavTree";
import { id, nodeSummary } from "../../../components/topics/topic-fixtures";
import {
  branchDataFromTree,
  emptyBranch,
  rootBranchKey,
  topicRows
} from "../../../components/topics/topic-navigation";
import { cachedMeasure, FittedLabel } from "./FittedLabel";
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
