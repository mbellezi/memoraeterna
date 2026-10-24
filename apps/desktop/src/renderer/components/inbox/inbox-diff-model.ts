import type { OverviewDiffSide, RelationDiffItem } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { relationTypeView } from "../../lib/relation-stance";

/**
 * The text form of a relation pass's and an overview's before and after (`changes.diff`) in the
 * Inbox's detail; a structural diff is T95's icicles with their own table. Names are the stored
 * titles, never IDs.
 */

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
