import type { Translator } from "@app/i18n";

import type {
  RelationBranchStance,
  RelationsBranchResult
} from "../../../../../shared/ipc-relations-branch";
import { relationTypeView, stances } from "../../../../lib/relation-stance";
import { graphNodeSize } from "../../../../components/graph/view-model";

/**
 * The Map › Grafo of one branch as data (F5 D19, design record 7.5), built from a
 * `relations.branch` answer with no DOM, no WebGL and no colour: the canvas, the legend, the table
 * (T152) and the tests read the same model.
 *
 *   - a topic's colour group is its ancestor-or-self at the colour depth, as the read model says;
 *     a group is named in the legend with the colour it is drawn in, never by colour alone;
 *   - a note's dot takes its group's colour index; a note the tree has not placed has none;
 *   - a suggestion (suggest band) is drawn dashed, apart from an applied or kept relation;
 *   - the super-nodes of the zoomed-out canvas are the colour groups, their lines the super-edges.
 */

export type BranchScope = { kind: "topic"; id: string } | { kind: "source"; id: string };

export interface BranchGroup {
  /** The topic that gives the colour (the group's own ID). */
  id: string;
  /** The topic's name, or the localized name of an unnamed topic. */
  title: string;
  /** The name the legend gives it: the scope topic's own notes say so. */
  legendLabel: string;
  colourIndex: number;
  /** Notes drawn in the group. */
  notes: number;
}

export interface BranchNode {
  id: string;
  title: string;
  /** The note's primary topic, null when the tree has not placed it. */
  topicId: string | null;
  /** The colour group, null when the tree has not placed the note. */
  groupId: string | null;
  colourIndex: number | null;
  degree: number;
  size: number;
}

export interface BranchEdge {
  id: string;
  a: string;
  b: string;
  type: string;
  stance: RelationBranchStance;
  suggested: boolean;
}

export interface BranchSuperEdge {
  a: string;
  b: string;
  weight: number;
}

export interface BranchModel {
  scope: BranchScope;
  /** The name of the scope: the topic's, or the source's when the caller knows it. */
  scopeTitle: string;
  /** The scope topic's direct subtopics, for the branch picker (topic scope only). */
  children: { id: string; title: string }[];
  /** The scope topic's parent, null for a source or a top-level topic's root. */
  parentId: string | null;
  /** In legend order: by colour index, then name. Only groups with a drawn note. */
  groups: BranchGroup[];
  nodes: BranchNode[];
  edges: BranchEdge[];
  superEdges: BranchSuperEdge[];
  /** Notes drawn that the tree has not placed (a source scope). */
  unplaced: number;
  /** The stances drawn, in legend order. */
  stances: RelationBranchStance[];
  /** One stored type per stance drawn, for the legend's glyph and word. */
  stanceTypes: Partial<Record<RelationBranchStance, string>>;
  hasSuggestions: boolean;
  truncated: boolean;
}

/** The interface's name for a topic: its title, or the words for an unnamed one. */
export function topicLabel(t: Translator, title: string): string {
  const trimmed = title.trim();
  return trimmed === "" ? t("mapRelations.untitledTopic") : trimmed;
}

/**
 * Each topic's colour group: its ancestor-or-self at `colourDepth`, or itself when shallower. A
 * topic whose parent is not listed starts at `base` (0 for the scope topic of a branch, 1 for a
 * source, whose list stops below the tree root), the same rule the read model colours by.
 */
export function colourGroups(
  topics: readonly { id: string; parentId: string | null }[],
  colourDepth: number,
  base: number
): Map<string, string> {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const depths = new Map<string, number>();
  const depthOf = (id: string, guard = 0): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const parent = byId.get(id)?.parentId ?? null;
    const depth =
      parent !== null && byId.has(parent) && guard < 32 ? depthOf(parent, guard + 1) + 1 : base;
    depths.set(id, depth);
    return depth;
  };
  const groups = new Map<string, string>();
  const groupOf = (id: string, guard = 0): string => {
    const known = groups.get(id);
    if (known !== undefined) return known;
    const parent = byId.get(id)?.parentId ?? null;
    const group =
      depthOf(id) > colourDepth && parent !== null && byId.has(parent) && guard < 32
        ? groupOf(parent, guard + 1)
        : id;
    groups.set(id, group);
    return group;
  };
  for (const topic of topics) groupOf(topic.id);
  return groups;
}

/** The model of an answer; defensive about what the answer should already guarantee. */
export function buildBranchModel(
  answer: RelationsBranchResult,
  input: { scope: BranchScope; colourDepth: number; sourceTitle?: string | null; t: Translator }
): BranchModel {
  const { scope, colourDepth, t } = input;
  const topicsById = new Map(answer.topics.map((topic) => [topic.id, topic]));
  const groupOf = colourGroups(answer.topics, colourDepth, scope.kind === "topic" ? 0 : 1);
  const scopeTopic = scope.kind === "topic" ? (answer.topics[0] ?? null) : null;

  const nodeIds = new Set<string>();
  const nodes: BranchNode[] = [];
  const groupNotes = new Map<string, number>();
  let unplaced = 0;
  for (const node of answer.nodes) {
    if (nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);
    const topic = node.topicId === null ? undefined : topicsById.get(node.topicId);
    const groupId = topic ? (groupOf.get(topic.id) ?? topic.id) : null;
    const group = groupId === null ? undefined : topicsById.get(groupId);
    if (groupId === null) unplaced += 1;
    else groupNotes.set(groupId, (groupNotes.get(groupId) ?? 0) + 1);
    nodes.push({
      id: node.id,
      title: node.title,
      topicId: topic?.id ?? null,
      groupId,
      colourIndex: group?.colourIndex ?? topic?.colourIndex ?? null,
      degree: node.degree,
      size: graphNodeSize(node.degree)
    });
  }

  const edgeIds = new Set<string>();
  const edges: BranchEdge[] = [];
  for (const edge of answer.edges) {
    if (edgeIds.has(edge.id) || edge.a === edge.b) continue;
    if (!nodeIds.has(edge.a) || !nodeIds.has(edge.b)) continue;
    edgeIds.add(edge.id);
    edges.push({
      id: edge.id,
      a: edge.a,
      b: edge.b,
      type: edge.type,
      stance: edge.stance,
      suggested: edge.band === "suggest"
    });
  }

  const groups: BranchGroup[] = [...groupNotes.entries()]
    .map(([id, notes]) => {
      const topic = topicsById.get(id)!;
      const title = topicLabel(t, topic.title);
      const direct = scopeTopic !== null && id === scopeTopic.id;
      return {
        id,
        title,
        legendLabel: direct ? t("mapRelations.legend.direct", { values: { topic: title } }) : title,
        colourIndex: topic.colourIndex,
        notes
      };
    })
    .sort(
      (left, right) => left.colourIndex - right.colourIndex || left.title.localeCompare(right.title)
    );
  const drawnGroups = new Set(groups.map((group) => group.id));
  const superEdges = answer.superEdges.filter(
    (edge) => edge.a !== edge.b && drawnGroups.has(edge.a) && drawnGroups.has(edge.b)
  );

  const stanceTypes: Partial<Record<RelationBranchStance, string>> = {};
  for (const edge of edges) stanceTypes[edge.stance] ??= edge.type;
  const drawnStances = stances.filter((stance) => stanceTypes[stance] !== undefined);

  return {
    scope,
    scopeTitle:
      scope.kind === "topic"
        ? topicLabel(t, scopeTopic?.title ?? "")
        : (input.sourceTitle ?? t("mapRelations.scope.sourceUnnamed")),
    children: scopeTopic
      ? answer.topics
          .filter((topic) => topic.parentId === scopeTopic.id)
          .map((topic) => ({ id: topic.id, title: topicLabel(t, topic.title) }))
      : [],
    parentId: scopeTopic?.parentId ?? null,
    groups,
    nodes,
    edges,
    superEdges,
    unplaced,
    stances: drawnStances,
    stanceTypes,
    hasSuggestions: edges.some((edge) => edge.suggested),
    truncated: answer.truncated
  };
}

/** Whether the branch has anything to draw: a graph is its connections. */
export function hasConnections(model: BranchModel): boolean {
  return model.edges.length > 0;
}

/** The name of a note's group for a sentence, or the words for a note with no place. */
export function nodeGroupLabel(model: BranchModel, node: BranchNode, t: Translator): string {
  const group = node.groupId ? model.groups.find((entry) => entry.id === node.groupId) : undefined;
  return group?.title ?? t("mapRelations.legend.unplaced");
}

/** What a compact card or a screen reader says about one note. */
export function branchNodeDescription(
  model: BranchModel,
  node: BranchNode,
  connections: number,
  t: Translator
): string {
  return t("mapRelations.node.description", {
    values: { title: node.title, topic: nodeGroupLabel(model, node, t), count: connections }
  });
}

/** What a compact card or a screen reader says about one relation: its sentence and its state. */
export function branchEdgeDescription(
  edge: BranchEdge,
  titleOf: (id: string) => string,
  t: Translator
): string {
  const view = relationTypeView(edge.type);
  const sentence = t("mapRelations.edge.description", {
    values: { first: titleOf(edge.a), verb: t(view.verbKey), second: titleOf(edge.b) }
  });
  return edge.suggested ? `${sentence} ${t("mapRelations.edge.suggested")}` : sentence;
}

/** What a super-node says: the group, its notes drawn and how many lines leave it. */
export function groupDescription(group: BranchGroup, model: BranchModel, t: Translator): string {
  const weight = model.superEdges
    .filter((edge) => edge.a === group.id || edge.b === group.id)
    .reduce((sum, edge) => sum + edge.weight, 0);
  return t("mapRelations.group.description", {
    values: { topic: group.legendLabel, notes: group.notes, count: weight }
  });
}

/** An item the keyboard cursor can stand on: the notes (most connected first), then the relations. */
export interface BranchCursorItem {
  type: "node" | "edge";
  id: string;
}

export function branchCursorItems(model: BranchModel): BranchCursorItem[] {
  return [
    ...[...model.nodes]
      .sort((left, right) => right.degree - left.degree)
      .map((node) => ({ type: "node" as const, id: node.id })),
    ...model.edges.map((edge) => ({ type: "edge" as const, id: edge.id }))
  ];
}

/** The number of relations drawn per note. */
export function connectionCounts(model: BranchModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of model.edges) {
    counts.set(edge.a, (counts.get(edge.a) ?? 0) + 1);
    counts.set(edge.b, (counts.get(edge.b) ?? 0) + 1);
  }
  return counts;
}
