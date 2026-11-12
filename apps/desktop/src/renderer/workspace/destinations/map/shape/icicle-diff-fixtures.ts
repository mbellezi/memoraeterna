import type { ChangesDiff, ChangeSetSummary, TopicDiffChange, TopicDiffNode } from "@app/domain";

import { shapeId } from "./shape-fixtures";

/** Synthetic structural diffs for tests: no real library content. */
export const diffId = shapeId;

/** Ids of the topics in `sampleDiffNodes`. */
export const diffTopics = {
  root: 1,
  memory: 2,
  forgetting: 3,
  spacing: 4,
  language: 5,
  retrieval: 10,
  misc: 11,
  /** Not listed in the sample: the parent a topic moved away from without being touched itself. */
  elsewhere: 90
} as const;

/** A topic that exists on both sides, under no parent and without a title, with nothing moved. */
export function diffNode(
  n: number,
  change: TopicDiffChange,
  extra: Partial<TopicDiffNode> = {}
): TopicDiffNode {
  return {
    id: diffId(n),
    change,
    existedBefore: true,
    existsAfter: true,
    parentBefore: null,
    parentAfter: null,
    titleBefore: null,
    titleAfter: null,
    itemsIn: 0,
    itemsOut: 0,
    ...extra
  };
}

/** A topic that stands under `parent` and keeps its title on both sides. */
export function standing(
  n: number,
  change: TopicDiffChange,
  parent: number | null,
  title: string | null,
  extra: Partial<TopicDiffNode> = {}
): TopicDiffNode {
  const parentId = parent === null ? null : diffId(parent);
  return diffNode(n, change, {
    parentBefore: parentId,
    parentAfter: parentId,
    titleBefore: title,
    titleAfter: title,
    ...extra
  });
}

/**
 * A regrouping of a small tree, in the order `changes.diff` lists it (the shallowest first, then
 * by kind of change): "Retrieval practice" is new under Memory, "Forgetting" became "Forgetting
 * curve", "Spacing" moved from Language to Memory, "Misc" was merged away, and the root, Memory and
 * Language only moved items or hang the others from the root.
 */
export function sampleDiffNodes(): TopicDiffNode[] {
  const { root, memory, forgetting, spacing, language, retrieval, misc } = diffTopics;
  return [
    standing(root, "context", null, null),
    standing(misc, "removed", root, "Misc", {
      existsAfter: false,
      parentAfter: null,
      titleAfter: null,
      itemsOut: 6
    }),
    standing(memory, "items", root, "Memory", { itemsIn: 5 }),
    standing(language, "items", root, "Language", { itemsOut: 3 }),
    standing(retrieval, "added", memory, "Retrieval practice", {
      existedBefore: false,
      parentBefore: null,
      titleBefore: null,
      itemsIn: 4
    }),
    standing(spacing, "moved", memory, "Spaced repetition", { parentBefore: diffId(language) }),
    standing(forgetting, "renamed", memory, "Forgetting curve", { titleBefore: "Forgetting" })
  ];
}

export const diffSummary: ChangeSetSummary = {
  kind: "topic",
  id: diffId(700),
  titleKey: "topics.changeSets.proposal",
  titleParams: {},
  risk: "medium",
  status: "pending_review",
  origin: "rebalance",
  subjectId: null,
  jobId: null,
  at: "2026-10-23T12:00:00.123Z",
  undoneAt: null,
  undo: "unavailable"
};

export function sampleTopicDiff(
  nodes: TopicDiffNode[] = sampleDiffNodes(),
  hidden = 0
): Extract<ChangesDiff, { kind: "topic" }> {
  return { kind: "topic", summary: diffSummary, nodes, hidden };
}

/**
 * A change-set at the node limit: a root and renamed topics below it, five under each topic, so
 * the shallowest come first and 200 topics reach five levels. Ids start at 1000.
 */
export function boundedNodes(count = 200): TopicDiffNode[] {
  const nodes: TopicDiffNode[] = [standing(1000, "context", null, null)];
  const parents = [1000];
  let next = 1001;
  for (let parentIndex = 0; nodes.length < count; parentIndex += 1) {
    const parent = parents[parentIndex]!;
    for (let child = 0; child < 5 && nodes.length < count; child += 1) {
      nodes.push(
        standing(next, "renamed", parent, `Topic ${next}`, { titleBefore: `Old ${next}` })
      );
      parents.push(next);
      next += 1;
    }
  }
  return nodes;
}
