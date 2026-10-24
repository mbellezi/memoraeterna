import type { ChangesDiff, TopicDiffChange, TopicDiffNode } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { countLabel } from "../topic-page/topic-page-model";
import type { DiffTone } from "./diff-tones";
import type { DiffCell, DiffSide } from "./icicle-layout";
import { nodeName } from "./shape-model";

/**
 * The decisions of the structural diff that need no renderer: how each kind of change is coloured,
 * named and counted, and the rows the table alternative and the selected-topic panel show. The
 * components only draw the result. Topics are named by their titles, never by their ids.
 */

export const diffChanges = {
  added: { tone: "success", key: "topics.shape.diff.change.added" },
  removed: { tone: "danger", key: "topics.shape.diff.change.removed" },
  moved: { tone: "info", key: "topics.shape.diff.change.moved" },
  renamed: { tone: "info", key: "topics.shape.diff.change.renamed" },
  changed: { tone: "info", key: "topics.shape.diff.change.changed" },
  items: { tone: "info", key: "topics.shape.diff.change.items" },
  context: { tone: "neutral", key: "topics.shape.diff.change.context" }
} as const satisfies Record<TopicDiffChange, { tone: DiffTone; key: MessageKey }>;

/** The order the legend and the counts list the kinds of change in. */
export const diffChangeOrder = [
  "added",
  "removed",
  "moved",
  "renamed",
  "changed",
  "items",
  "context"
] as const satisfies readonly TopicDiffChange[];

/** The copy of each side of the diff (message keys are literals, never built from the side). */
export const diffSideKeys = {
  before: {
    heading: "topics.shape.diff.side.before",
    chart: "topics.shape.diff.chart.before",
    nothing: "topics.shape.diff.nothing.before"
  },
  after: {
    heading: "topics.shape.diff.side.after",
    chart: "topics.shape.diff.chart.after",
    nothing: "topics.shape.diff.nothing.after"
  }
} as const satisfies Record<
  DiffSide,
  { heading: MessageKey; chart: MessageKey; nothing: MessageKey }
>;

export type TopicDiff = Extract<ChangesDiff, { kind: "topic" }>;

export const isTopicDiff = (diff: ChangesDiff): diff is TopicDiff => diff.kind === "topic";

const number = (t: Translator, value: number): string =>
  new Intl.NumberFormat(t.locale).format(value);

/** The topic as it was named on a side: its title, "Topics" for the root, "Unnamed topic" otherwise. */
export function topicNameOn(t: Translator, node: TopicDiffNode, side: DiffSide): string {
  return nodeName(
    t,
    side === "before"
      ? { title: node.titleBefore, parentId: node.parentBefore }
      : { title: node.titleAfter, parentId: node.parentAfter },
    true
  );
}

/** The accessible name of a block: the topic, what happened to it, its level and the items it moved. */
export function diffCellLabel(t: Translator, cell: DiffCell): string {
  const values = {
    title: topicNameOn(t, cell.node, cell.side),
    change: t(diffChanges[cell.node.change].key),
    level: cell.row
  };
  const moved = cell.side === "before" ? cell.node.itemsOut : cell.node.itemsIn;
  if (moved <= 0) return t("topics.shape.diff.chart.cell", { values });
  return t(
    cell.side === "before" ? "topics.shape.diff.chart.cellOut" : "topics.shape.diff.chart.cellIn",
    { values: { ...values, items: countLabel(t, "items", moved) } }
  );
}

/** "+12" placed into a topic (after), "−12" taken out of it (before); nothing when none moved. */
export function movedMark(cell: DiffCell): string | null {
  const moved = cell.side === "before" ? cell.node.itemsOut : cell.node.itemsIn;
  if (moved <= 0) return null;
  return `${cell.side === "before" ? "−" : "+"}${moved}`;
}

// ---------------------------------------------------------------------------
// Rows: the table alternative and the selected-topic panel

export interface DiffRow {
  id: string;
  change: TopicDiffChange;
  /** The topic's name after the change; before it for a topic that was removed. */
  name: string;
  /** The name before, when the change renamed the topic. */
  was: string | null;
  existedBefore: boolean;
  existsAfter: boolean;
  /** The parent's name before and after; null at the top of the tree (or when the topic is not there). */
  parentBefore: string | null;
  parentAfter: string | null;
  itemsIn: number;
  itemsOut: number;
}

/** One row per listed topic, in the order of the read: the shallowest first. */
export function diffRows(t: Translator, nodes: readonly TopicDiffNode[]): DiffRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentName = (node: TopicDiffNode, side: DiffSide): string | null => {
    const parentId = side === "before" ? node.parentBefore : node.parentAfter;
    if (parentId === null) return null;
    const parent = byId.get(parentId);
    if (!parent) return t("topics.shape.diff.otherTopic");
    // A parent that is only listed on the other side (the read is inconsistent) is named there.
    const other: DiffSide = side === "before" ? "after" : "before";
    const there = side === "before" ? parent.existedBefore : parent.existsAfter;
    return topicNameOn(t, parent, there ? side : other);
  };
  return nodes.map((node) => {
    const renamed =
      node.existedBefore &&
      node.existsAfter &&
      node.titleBefore !== null &&
      node.titleBefore !== node.titleAfter;
    return {
      id: node.id,
      change: node.change,
      name: topicNameOn(t, node, node.existsAfter ? "after" : "before"),
      was: renamed ? topicNameOn(t, node, "before") : null,
      existedBefore: node.existedBefore,
      existsAfter: node.existsAfter,
      parentBefore: node.existedBefore ? parentName(node, "before") : null,
      parentAfter: node.existsAfter ? parentName(node, "after") : null,
      itemsIn: node.itemsIn,
      itemsOut: node.itemsOut
    };
  });
}

/** The selected topic when the read still lists it; the view shows nothing selected otherwise. */
export function resolveDiffSelection(
  nodes: readonly TopicDiffNode[],
  selectedId: string | null
): string | null {
  return selectedId !== null && nodes.some((node) => node.id === selectedId) ? selectedId : null;
}

// ---------------------------------------------------------------------------
// Legend and counts

export interface DiffLegendItem {
  change: TopicDiffChange;
  count: number;
}

/** The kinds of change the diff holds, each with how many topics, in a fixed order. */
export function diffLegend(nodes: readonly TopicDiffNode[]): DiffLegendItem[] {
  const counts = new Map<TopicDiffChange, number>();
  for (const node of nodes) counts.set(node.change, (counts.get(node.change) ?? 0) + 1);
  return diffChangeOrder.flatMap((change) => {
    const count = counts.get(change) ?? 0;
    return count > 0 ? [{ change, count }] : [];
  });
}

export function legendText(t: Translator, item: DiffLegendItem): string {
  return t("topics.shape.diff.chart.legendItem", {
    values: { change: t(diffChanges[item.change].key), count: number(t, item.count) }
  });
}

/** Topics the read left out because it is bounded (deeper levels are summarized). */
export function hiddenText(t: Translator, hidden: number): string {
  return hidden === 1
    ? t("topics.shape.diff.chart.hiddenOne")
    : t("topics.shape.diff.chart.hidden", { values: { count: number(t, hidden) } });
}
