import type {
  TopicChangeSet,
  TopicChangeSetSummary,
  TopicHealth,
  TopicManagement,
  TopicShapeWarning
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { countLabel, type HealthTone } from "../../../../components/topic-page/topic-page-model";
import { cellTrail, topicCellKey, type IcicleCell, type IcicleLayout } from "./icicle-layout";
import { growthText } from "./shape-growth";

/**
 * The decisions of the Shape view that need no renderer: what it calls things, how it counts and
 * formats, and which sentence each warning and change gets. The view only shows the result.
 */

const number = (t: Translator, value: number): string =>
  new Intl.NumberFormat(t.locale).format(value);

/** A topic as the person reads it: its name, "Topics" for the root of the tree, "Unnamed topic" otherwise. */
export function nodeName(
  t: Translator,
  node: { title: string | null; parentId: string | null },
  wholeTree: boolean
): string {
  if (node.title !== null) return node.title;
  return wholeTree && node.parentId === null
    ? t("topics.navigator.topics")
    : t("topics.page.unnamed");
}

export function cellName(t: Translator, cell: IcicleCell, wholeTree: boolean): string {
  if (cell.kind === "unsorted") return t("topics.navigator.unsorted");
  return cell.node ? nodeName(t, cell.node, wholeTree) : "";
}

export const shapeHealth = {
  good: { key: "topics.shape.health.good", tone: "success" },
  attention: { key: "topics.shape.health.attention", tone: "warning" },
  violation: { key: "topics.shape.health.violation", tone: "danger" }
} as const satisfies Record<TopicHealth, { key: MessageKey; tone: HealthTone }>;

/** "161", "1,9%": the numbers of the summary, in the interface language. */
export const itemsText = (t: Translator, count: number): string => countLabel(t, "items", count);

export function shareText(t: Translator, share: number): string {
  return new Intl.NumberFormat(t.locale, { style: "percent", maximumFractionDigits: 1 }).format(
    share
  );
}

export function depthText(t: Translator, depth: number): string {
  return new Intl.NumberFormat(t.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(depth);
}

export function coherenceText(t: Translator, coherence: number | null): string {
  if (coherence === null) return "—";
  return new Intl.NumberFormat(t.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(coherence);
}

/** "Tamanho e saúde da árvore: 412 notas em 38 tópicos". */
export function mapDescription(t: Translator, items: number, topics: number): string {
  const topicsText =
    topics === 1
      ? t("map.count.topicsOne")
      : t("map.count.topics", { values: { count: number(t, topics) } });
  return t("map.shape.description", {
    values: { notes: countLabel(t, "notes", items), topics: topicsText }
  });
}

/** "+8" new items this week; nothing new reads "0". */
export function weekText(t: Translator, count: number): string {
  return count > 0 ? `+${number(t, count)}` : number(t, 0);
}

export function timeText(t: Translator, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(t.locale, { timeStyle: "short" }).format(at);
}

export function warningsValue(t: Translator, soft: number, hard: number): string {
  return t("topics.shape.summary.warningsValue", {
    values: { soft: number(t, soft), hard: number(t, hard) }
  });
}

/** The accessible name of a block: what it is, how much it holds, where it sits and its health. */
export function cellLabel(
  t: Translator,
  cell: IcicleCell,
  wholeTree: boolean,
  levelOffset: number
): string {
  const values = {
    title: cellName(t, cell, wholeTree),
    items: itemsText(t, cell.value),
    level: cell.row + levelOffset
  };
  if (!cell.node) return t("topics.shape.chart.cellPlain", { values });
  return t("topics.shape.chart.cell", {
    values: { ...values, health: t(shapeHealth[cell.node.health].key).toLocaleLowerCase(t.locale) }
  });
}

export function managementMark(t: Translator, management: TopicManagement): string | null {
  if (management === "pinned") return t("topics.navigator.marks.pinned");
  if (management === "human") return t("topics.navigator.marks.createdByYou");
  return null;
}

/** The block to show as selected: the one asked for when it is still there, otherwise the root. */
export function resolveSelection(
  layout: IcicleLayout,
  selectedKey: string | null,
  preferredKey: string | null = null
): string | null {
  if (selectedKey !== null && layout.byKey.has(selectedKey)) return selectedKey;
  if (preferredKey !== null && layout.byKey.has(preferredKey)) return preferredKey;
  return layout.rootKey;
}

/**
 * The block shown as selected before the person picks one: the topic they came from when they came
 * from an object, else the first topic that needs attention (the largest, as the chart sorts), else
 * nothing (the view then shows the whole tree).
 */
export function defaultSelection(layout: IcicleLayout, originKey: string | null): string | null {
  if (originKey !== null && layout.byKey.has(originKey)) return originKey;
  const needs = layout.order.find((key) => {
    const cell = layout.byKey.get(key);
    return (
      cell?.kind === "topic" && cell.row > 0 && cell.node !== null && cell.node.health !== "good"
    );
  });
  return needs ?? null;
}

// ---------------------------------------------------------------------------
// The selected block

export interface PanelModel {
  key: string;
  kind: "topic" | "unsorted";
  topicId: string;
  title: string;
  /** Names of the blocks above this one in the chart, the top first. */
  trail: string[];
  items: number;
  level: number;
  childrenText: string;
  /** Subtopics and direct notes, for the line "7 subtópicos diretos". */
  subtopics: number;
  /** Notes that arrived in this topic and under it over the last days; null until read. */
  growth: number | null;
  growthText: string;
  coherenceText: string;
  health: TopicHealth | null;
  mark: string | null;
  /** The chart can start at this topic: it has subtopics and is not what the chart starts at. */
  canZoom: boolean;
}

export function panelModel(
  t: Translator,
  layout: IcicleLayout,
  key: string,
  wholeTree: boolean,
  levelOffset: number,
  growth: ReadonlyMap<string, number> | null = null
): PanelModel | null {
  const cell = layout.byKey.get(key);
  if (!cell || (cell.kind !== "topic" && cell.kind !== "unsorted")) return null;
  const trail = cellTrail(layout, key)
    .slice(0, -1)
    .map((above) => cellName(t, above, wholeTree));
  const base = {
    key,
    topicId: cell.topicId,
    title: cellName(t, cell, wholeTree),
    trail,
    items: cell.value,
    level: cell.row + levelOffset
  };
  const node = cell.node;
  if (!node) {
    return {
      ...base,
      kind: "unsorted",
      childrenText: "—",
      subtopics: 0,
      growth: null,
      growthText: "—",
      coherenceText: "—",
      health: null,
      mark: null,
      canZoom: false
    };
  }
  return {
    ...base,
    kind: "topic",
    childrenText: childrenText(t, node.children, node.directItems),
    subtopics: node.children,
    growth: growth?.get(node.id) ?? null,
    growthText: growthText(t, growth?.get(node.id)),
    coherenceText: coherenceText(t, node.coherence),
    health: node.health,
    mark: managementMark(t, node.management),
    canZoom: node.children > 0 && cell.row > 0
  };
}

/** "2 + 6 direct": subtopics and the items placed directly in the topic. */
export function childrenText(t: Translator, subtopics: number, direct: number): string {
  if (subtopics > 0 && direct > 0)
    return t("topics.shape.panel.childrenMixed", {
      values: { subtopics: number(t, subtopics), direct: number(t, direct) }
    });
  if (subtopics === 0 && direct > 0)
    return t("topics.shape.panel.childrenDirect", { values: { direct: number(t, direct) } });
  return number(t, subtopics);
}

// ---------------------------------------------------------------------------
// The table alternative

export interface TableRow {
  key: string;
  kind: "topic" | "unsorted";
  topicId: string;
  /** The level in the tree. */
  level: number;
  name: string;
  items: number;
  direct: number | null;
  subtopics: number | null;
  /** Notes that arrived in the topic and under it over the last days ("+8"; "—" until read). */
  growth: string;
  coherence: string;
  health: TopicHealth | null;
  mark: string | null;
}

/** One row per selectable block, in the order of the chart from the left. */
export function tableRows(
  t: Translator,
  layout: IcicleLayout,
  wholeTree: boolean,
  levelOffset: number,
  growth: ReadonlyMap<string, number> | null = null
): TableRow[] {
  const rows: TableRow[] = [];
  for (const key of layout.order) {
    const cell = layout.byKey.get(key);
    if (!cell || (cell.kind !== "topic" && cell.kind !== "unsorted")) continue;
    const node = cell.node;
    rows.push({
      key,
      kind: cell.kind,
      topicId: cell.topicId,
      level: cell.row + levelOffset,
      name: cellName(t, cell, wholeTree),
      items: cell.value,
      direct: node ? node.directItems : null,
      subtopics: node ? node.children : null,
      growth: node ? growthText(t, growth?.get(node.id)) : "—",
      coherence: node ? coherenceText(t, node.coherence) : "—",
      health: node ? node.health : null,
      mark: node ? managementMark(t, node.management) : null
    });
  }
  return rows;
}

/** Rows shown at first and added by "Show more topics". */
export const tablePageSize = 200;

/**
 * The topic a row of the previous-panel table opens beside it (design record §8, rule 1). The
 * "Unsorted" row holds no topic of its own (its inspector offers no "Open"), so it opens nothing.
 */
export function topicOfRow(rows: readonly TableRow[], key: string): string | null {
  const row = rows.find((candidate) => candidate.key === key);
  return row?.kind === "topic" ? row.topicId : null;
}

// ---------------------------------------------------------------------------
// Warnings and proposals

const reasonKeys = {
  "single-child": "topics.shape.warnings.reasons.singleChild",
  "fan-out-outside-range": "topics.shape.warnings.reasons.fanOutOutside",
  "fan-out-above-hard-max": "topics.shape.warnings.reasons.fanOutAbove",
  "leaf-size-outside-range": "topics.shape.warnings.reasons.leafOutside",
  "leaf-above-hard-max": "topics.shape.warnings.reasons.leafAbove",
  "depth-above-target": "topics.shape.warnings.reasons.depthAbove",
  "depth-above-cap": "topics.shape.warnings.reasons.depthCap",
  "coherence-below-floor": "topics.shape.warnings.reasons.coherence",
  "duplicate-sibling-title": "topics.shape.warnings.reasons.duplicateTitle"
} as const satisfies Record<string, MessageKey>;

const pendingKeys = {
  rebalance: "topics.shape.warnings.pending.rebalance",
  areas: "topics.shape.warnings.pending.areas",
  rebuild: "topics.shape.warnings.pending.rebuild"
} as const satisfies Record<string, MessageKey>;

const riskKeys = {
  high: "topics.shape.warnings.risk.high",
  medium: "topics.shape.warnings.risk.medium",
  low: "topics.shape.warnings.risk.low"
} as const satisfies Record<string, MessageKey>;

export interface WarningView {
  /** A stable key for the list. */
  id: string;
  tone: "warning" | "danger";
  /**
   * The topic the warning is about: its name and the block that name selects (null for a topic
   * below the levels the chart shows). Null when the warning is about no topic in particular.
   */
  subject: { name: string; cellKey: string | null } | null;
  text: string;
  /** The topic is protected (yours or pinned), so the app only reports the problem. */
  awaiting: boolean;
  /** A proposal that waits for the person's decision. */
  proposal: { changeSetId: string; riskLabel: string | null } | null;
}

const asKnown = <T extends Record<string, MessageKey>>(map: T, key: unknown): keyof T | null =>
  typeof key === "string" && Object.hasOwn(map, key) ? (key as keyof T) : null;

function reasonText(t: Translator, warning: TopicShapeWarning): string {
  const known = asKnown(reasonKeys, warning.code);
  if (known === null)
    return t(
      warning.params.severity === "hard"
        ? "topics.shape.warnings.reasons.structure"
        : "topics.shape.warnings.reasons.other"
    );
  const value = warning.params.value;
  const shown =
    typeof value !== "number" || !Number.isFinite(value)
      ? ""
      : known === "coherence-below-floor"
        ? coherenceText(t, value)
        : number(t, Math.round(value));
  return t(reasonKeys[known], { values: { value: shown } });
}

function proposalText(t: Translator, warning: TopicShapeWarning): string {
  const origin = asKnown(pendingKeys, warning.params.origin);
  return t(origin === null ? "topics.shape.warnings.pending.other" : pendingKeys[origin]);
}

/** The warnings of the tree, proposals first (the server orders them), as sentences. */
export function warningViews(
  t: Translator,
  warnings: readonly TopicShapeWarning[],
  layout: IcicleLayout,
  wholeTree: boolean
): WarningView[] {
  return warnings.map((warning, index) => {
    const cell =
      warning.topicId === null ? undefined : layout.byKey.get(topicCellKey(warning.topicId));
    const proposal = warning.pendingReview && warning.changeSetId !== null;
    const risk = asKnown(riskKeys, warning.params.risk);
    return {
      id: `${warning.changeSetId ?? warning.topicId ?? "tree"}:${warning.code}:${index}`,
      tone: !proposal && warning.params.severity === "hard" ? "danger" : "warning",
      subject:
        warning.topicId === null
          ? null
          : cell
            ? { name: cellName(t, cell, wholeTree), cellKey: cell.key }
            : { name: t("topics.shape.warnings.deeper"), cellKey: null },
      text: proposal ? proposalText(t, warning) : reasonText(t, warning),
      awaiting: !proposal && warning.params.awaitingApproval === true,
      proposal:
        proposal && warning.changeSetId !== null
          ? {
              changeSetId: warning.changeSetId,
              riskLabel: risk === null ? null : t(riskKeys[risk])
            }
          : null
    };
  });
}

// ---------------------------------------------------------------------------
// What changed today

const changeKeys = {
  build: "topics.shape.changed.titles.build",
  rebalance: "topics.shape.changed.titles.rebalance",
  audit: "topics.shape.changed.titles.audit",
  areas: "topics.shape.changed.titles.areas",
  naming: "topics.shape.changed.titles.naming",
  human: "topics.shape.changed.titles.human",
  rebuild: "topics.shape.changed.titles.rebuild"
} as const satisfies Record<string, MessageKey>;

function positiveCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The sentence of a change of today. A change this view does not know reads as a plain change. */
export function changeText(t: Translator, change: TopicChangeSetSummary): string {
  const origin = asKnown(changeKeys, change.origin);
  if (origin === null) return t("topics.shape.changed.titles.other");
  if (origin === "rebalance") {
    const items = positiveCount(change.titleParams.items);
    if (items !== null)
      return items === 1
        ? t("topics.shape.changed.titles.rebalanceItemsOne")
        : t("topics.shape.changed.titles.rebalanceItems", { values: { count: number(t, items) } });
  }
  if (origin === "naming") {
    const topics = positiveCount(change.titleParams.topics);
    if (topics !== null)
      return topics === 1
        ? t("topics.shape.changed.titles.namingCountOne")
        : t("topics.shape.changed.titles.namingCount", { values: { count: number(t, topics) } });
  }
  return t(changeKeys[origin]);
}

// ---------------------------------------------------------------------------
// Before and after

export interface CompareLine {
  key: string;
  text: string;
}

export interface CompareView {
  before: CompareLine[];
  after: CompareLine[];
  /** The change-set touched more than the two sides list. */
  partial: boolean;
}

/** The two sides of a change-set as lines of text: topics under their parents, then items in their topics. */
export function compareView(t: Translator, changeSet: TopicChangeSet): CompareView {
  const name = (title: string | null): string => title ?? t("topics.page.unnamed");
  const side = (part: TopicChangeSet["before"]): CompareLine[] => [
    ...part.topics.map((topic) => ({
      key: `topic:${topic.id}`,
      text:
        topic.parentTitle === null
          ? name(topic.title)
          : t("topics.shape.compare.topic", {
              values: { title: name(topic.title), parent: topic.parentTitle }
            })
    })),
    ...part.items.map((item) => ({
      key: `${item.kind}:${item.id}`,
      text:
        item.topicId === null
          ? item.title
          : t("topics.shape.compare.item", {
              values: { title: item.title, topic: name(item.topicTitle) }
            })
    }))
  ];
  return {
    before: side(changeSet.before),
    after: side(changeSet.after),
    partial: changeSet.truncated
  };
}
