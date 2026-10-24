import type {
  OverviewDiffSide,
  RelationDiffItem,
  TopicDiffChange,
  TopicDiffNode
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { relationTypeView } from "../../lib/relation-stance";

/**
 * The text form of a change-set's before and after (`changes.diff`): the table alternative the
 * Inbox's detail shows beside, or in place of, the icicle diff. Names are the stored titles, never
 * IDs; a topic that is not named yet reads as "Unnamed topic".
 */

const changeLabels = {
  added: "inbox.diff.topic.changes.added",
  removed: "inbox.diff.topic.changes.removed",
  moved: "inbox.diff.topic.changes.moved",
  renamed: "inbox.diff.topic.changes.renamed",
  changed: "inbox.diff.topic.changes.changed",
  items: "inbox.diff.topic.changes.items",
  context: "inbox.diff.topic.changes.context"
} as const satisfies Record<TopicDiffChange, MessageKey>;

export interface TopicDiffRow {
  id: string;
  /** Levels below the first topic of the diff. */
  depth: number;
  name: string;
  change: TopicDiffChange;
  changeLabel: string;
  /** Where it went or what it was called ("from “A” to “B”"), when the change has one. */
  detail: string | null;
  /** The placements moved in and out ("3 in, 1 out"), when any. */
  items: string | null;
}

const maxDepth = 64;

/** The topics of a structural diff as indented rows, ancestors first (the order the read gives). */
export function topicDiffRows(t: Translator, nodes: readonly TopicDiffNode[]): TopicDiffRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = (node: TopicDiffNode): string | null => node.parentAfter ?? node.parentBefore;
  const depthOf = (node: TopicDiffNode): number => {
    let depth = 0;
    for (
      let parent = parentOf(node);
      parent !== null && byId.has(parent) && depth < maxDepth;
      parent = parentOf(byId.get(parent)!)
    )
      depth += 1;
    return depth;
  };
  const numbers = new Intl.NumberFormat(t.locale);
  /** A topic's name on one side of the change: its title, the library for the root, else unnamed. */
  const nameOn = (node: TopicDiffNode, side: "before" | "after"): string => {
    const title =
      side === "before"
        ? (node.titleBefore ?? node.titleAfter)
        : (node.titleAfter ?? node.titleBefore);
    if (title !== null) return title;
    return parentOf(node) === null ? t("inbox.diff.topic.root") : t("topics.page.unnamed");
  };
  /** The parent a moved topic left or reached, by name; null when the read did not list it. */
  const parentName = (id: string | null, side: "before" | "after"): string | null => {
    const parent = id === null ? undefined : byId.get(id);
    return parent ? nameOn(parent, side) : null;
  };
  return nodes.map((node) => {
    const moved =
      node.change === "moved"
        ? [parentName(node.parentBefore, "before"), parentName(node.parentAfter, "after")]
        : null;
    const placements = node.itemsIn + node.itemsOut;
    return {
      id: node.id,
      depth: depthOf(node),
      name: nameOn(node, "after"),
      change: node.change,
      changeLabel: t(changeLabels[node.change]),
      detail:
        moved?.[0] && moved[1]
          ? t("inbox.diff.topic.movedFrom", { values: { from: moved[0], to: moved[1] } })
          : node.titleBefore !== null &&
              node.titleAfter !== null &&
              node.titleBefore !== node.titleAfter
            ? t("inbox.diff.topic.renamedFrom", { values: { from: node.titleBefore } })
            : null,
      items:
        placements > 0
          ? t("inbox.diff.topic.itemsInOut", {
              values: { in: numbers.format(node.itemsIn), out: numbers.format(node.itemsOut) }
            })
          : null
    };
  });
}

const relationChangeLabels = {
  created: "inbox.diff.relation.changes.created",
  removed: "inbox.diff.relation.changes.removed",
  changed: "inbox.diff.relation.changes.changed"
} as const satisfies Record<RelationDiffItem["change"], MessageKey>;

export interface RelationDiffRow {
  key: string;
  change: RelationDiffItem["change"];
  changeLabel: string;
  /** “A” and “B”. */
  between: string;
  /** The connection's word ("supports"), or that it has no type yet. */
  type: string;
}

/** The connections a pass touched, as rows. */
export function relationDiffRows(
  t: Translator,
  relations: readonly RelationDiffItem[]
): RelationDiffRow[] {
  const end = (item: RelationDiffItem["from"]) => item.title ?? t("inbox.detail.unnamed");
  return relations.map((relation, index) => {
    const type = relation.after?.type ?? relation.before?.type ?? null;
    return {
      key: `${relation.relationKind}:${relation.relationId ?? index}:${index}`,
      change: relation.change,
      changeLabel: t(relationChangeLabels[relation.change]),
      between: t("inbox.diff.relation.between", {
        values: { from: end(relation.from), to: end(relation.to) }
      }),
      type: type === null ? t("inbox.diff.relation.untyped") : t(relationTypeView(type).wordKey)
    };
  });
}

export interface OverviewSideView {
  version: number;
  paragraphs: readonly string[];
}

export interface OverviewDiffView {
  topic: string;
  before: OverviewSideView | null;
  after: OverviewSideView | null;
  /** Where the new evidence disagrees with the text, as sentences. */
  divergences: string[];
}

const side = (value: OverviewDiffSide | null): OverviewSideView | null =>
  value
    ? { version: value.version, paragraphs: value.paragraphs.map((paragraph) => paragraph.text) }
    : null;

/** An overview change as its two texts and the Divergences the new side keeps beside the prose. */
export function overviewDiffView(
  t: Translator,
  diff: {
    topic: { title: string | null };
    before: OverviewDiffSide | null;
    after: OverviewDiffSide | null;
  }
): OverviewDiffView {
  const kept = diff.after?.divergences ?? [];
  const before = new Set(
    (diff.before?.divergences ?? []).map((item) => `${item.existing}|${item.new}|${item.summary}`)
  );
  return {
    topic: diff.topic.title ?? t("topics.page.unnamed"),
    before: side(diff.before),
    after: side(diff.after),
    divergences: kept
      .filter((item) => !before.has(`${item.existing}|${item.new}|${item.summary}`))
      .map((item) =>
        t("inbox.diff.overview.divergence", {
          values: { existing: item.existing, new: item.new, summary: item.summary }
        })
      )
  };
}
