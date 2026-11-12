import type { ObjectNeighborhood, ObjectNeighborhoodEdgeState } from "@app/domain";
import type { Translator } from "@app/i18n";

import { relationTypeView, stances, type Stance } from "../../lib/relation-stance";
import { graphNodeSize } from "./view-model";

/**
 * The Note page's relation graph as data (F3 D43), built from an `objects.neighborhood` answer with
 * no DOM, no WebGL and no colour: the canvas, the legend and the tests read the same model.
 *
 *   - an arrow only for a directed type whose direction is known (a symmetric type, a legacy row
 *     and an unknown direction read both ways and are drawn without one);
 *   - a suggestion (decision 29) is drawn dashed, apart from the relations the owner kept or an
 *     apply band wrote, so no relation is told by colour alone;
 *   - everything is bounded: the answer holds at most 40 notes, and at most `edges` relations are
 *     drawn, the focus's own first.
 */
export const egoGraphLimits = {
  nodes: 40,
  edges: 120,
  /** Characters of a title drawn on the canvas; the card and the list show it whole. */
  labelCharacters: 28
} as const;

/**
 * "2 notes · 1 relation": two counted parts, each in its own singular or plural (never "1 connections"),
 * joined by a middle dot.
 */
export function countsText(t: Translator, notes: number, relations: number): string {
  const one = notes === 1;
  const noteWords = t(one ? "notePage.graph.notesOne" : "notePage.graph.notesMany", {
    values: { count: notes }
  });
  const relationWords = t(
    relations === 1 ? "notePage.graph.connectionsOne" : "notePage.graph.connectionsMany",
    { values: { count: relations } }
  );
  return `${noteWords} · ${relationWords}`;
}

/** How Sigma draws one edge: the program that cuts it into dashes and the one that adds an arrow. */
export type EgoEdgeProgram = "line" | "arrow" | "dashed" | "dashed-arrow";

export interface EgoGraphNode {
  id: string;
  title: string;
  ideaStatement: string;
  language: string | null;
  depth: 0 | 1 | 2;
  focus: boolean;
  /** The title as drawn on the canvas. */
  label: string;
  size: number;
  /** Where the layout starts from: deterministic, never random. */
  x: number;
  y: number;
}

export interface EgoGraphEdge {
  id: string;
  /** The decided subject for an arrow, else the lower ID of the pair. */
  source: string;
  target: string;
  type: string;
  stance: Stance;
  directed: boolean;
  suggested: boolean;
  state: ObjectNeighborhoodEdgeState;
  program: EgoEdgeProgram;
}

export interface EgoGraphModel {
  focus: string;
  nodes: EgoGraphNode[];
  edges: EgoGraphEdge[];
  /** Relations among the notes that the bound left out of the drawing. */
  omittedEdges: number;
  /** The stances drawn, in legend order, for the legend. */
  stances: Stance[];
  /** One type per stance drawn, for the legend's glyph and word. */
  stanceTypes: Partial<Record<Stance, string>>;
  hasSuggestions: boolean;
  hasKept: boolean;
  hasArrows: boolean;
  /** Related notes the answer holds out of those the focus has (the list has them all). */
  neighbourTotal: number;
  drawnNeighbours: number;
  truncated: boolean;
}

const goldenAngle = 2.399963229728653;

/** Title cut to `max` characters (code points) with an ellipsis, never inside a surrogate pair. */
export function egoGraphLabel(title: string, max: number = egoGraphLimits.labelCharacters): string {
  const trimmed = title.replace(/\s+/gu, " ").trim();
  const characters = Array.from(trimmed);
  return characters.length <= max ? trimmed : `${characters.slice(0, max - 1).join("")}…`;
}

function edgeProgram(directed: boolean, suggested: boolean): EgoEdgeProgram {
  if (suggested) return directed ? "dashed-arrow" : "dashed";
  return directed ? "arrow" : "line";
}

/** The model of an answer; defensive about what the answer should already guarantee. */
export function buildEgoGraphModel(neighborhood: ObjectNeighborhood): EgoGraphModel {
  const sourceNodes = neighborhood.nodes.slice(0, egoGraphLimits.nodes);
  const known = new Set(sourceNodes.map((node) => node.id));
  const ringSizes: Record<number, number> = { 1: 0, 2: 0 };
  for (const node of sourceNodes)
    if (node.depth > 0) ringSizes[node.depth] = (ringSizes[node.depth] ?? 0) + 1;
  const placed: Record<number, number> = { 1: 0, 2: 0 };
  const seen = new Set<string>();
  const edges: EgoGraphEdge[] = [];
  for (const edge of neighborhood.edges) {
    if (seen.has(edge.id) || edge.lo === edge.hi) continue;
    if (!known.has(edge.lo) || !known.has(edge.hi)) continue;
    seen.add(edge.id);
    const view = relationTypeView(edge.type);
    const reads = edge.direction === "lo_to_hi" || edge.direction === "hi_to_lo";
    const directed = view.directed && reads;
    const forward = edge.direction === "hi_to_lo" && directed;
    edges.push({
      id: edge.id,
      source: forward ? edge.hi : edge.lo,
      target: forward ? edge.lo : edge.hi,
      type: edge.type,
      stance: view.stance,
      directed,
      suggested: edge.state === "suggested",
      state: edge.state,
      program: edgeProgram(directed, edge.state === "suggested")
    });
  }
  // The focus's own relations are always drawn; the rest, in the answer's rank order, fill the bound.
  const own = edges.filter(
    (edge) => edge.source === neighborhood.focus || edge.target === neighborhood.focus
  );
  const ownIds = new Set(own.map((edge) => edge.id));
  const rest = edges.filter((edge) => !ownIds.has(edge.id));
  const drawn = [...own, ...rest].slice(0, egoGraphLimits.edges);
  const degree = new Map<string, number>();
  for (const edge of drawn)
    for (const end of [edge.source, edge.target]) degree.set(end, (degree.get(end) ?? 0) + 1);

  const nodes: EgoGraphNode[] = sourceNodes.map((node) => {
    let x = 0;
    let y = 0;
    if (node.depth > 0) {
      const index = placed[node.depth]!++;
      const count = Math.max(1, ringSizes[node.depth] ?? 1);
      const radius = node.depth === 1 ? 26 : 52;
      const angle = (index / count) * Math.PI * 2 + (node.depth === 2 ? goldenAngle : 0);
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
    }
    const focus = node.id === neighborhood.focus;
    return {
      id: node.id,
      title: node.title,
      ideaStatement: node.ideaStatement,
      language: node.language,
      depth: node.depth,
      focus,
      label: egoGraphLabel(node.title),
      size: focus ? 12 : Math.min(9, graphNodeSize(degree.get(node.id) ?? 0)),
      x,
      y
    };
  });
  const present = new Set(drawn.map((edge) => edge.stance));
  const stanceTypes: Partial<Record<Stance, string>> = {};
  for (const edge of drawn) stanceTypes[edge.stance] ??= edge.type;
  return {
    focus: neighborhood.focus,
    nodes,
    edges: drawn,
    omittedEdges: edges.length - drawn.length,
    stances: stances.filter((stance) => present.has(stance)),
    stanceTypes,
    hasSuggestions: drawn.some((edge) => edge.suggested),
    hasKept: drawn.some((edge) => !edge.suggested),
    hasArrows: drawn.some((edge) => edge.directed),
    neighbourTotal: neighborhood.neighbourTotal,
    drawnNeighbours: nodes.filter((node) => node.depth === 1).length,
    truncated: neighborhood.truncated
  };
}

/** What a compact card or a screen reader says about one note. */
export function egoNodeDescription(node: EgoGraphNode, t: Translator): string {
  return node.focus
    ? t("notePage.graph.thisNote", { values: { title: node.title } })
    : t("notePage.graph.noteCard", { values: { title: node.title } });
}

/**
 * How the card says an edge: the sentence of the evidence card (a direction only when one is known,
 * never invented), the state in words and the colour-free facts a reader needs.
 */
export function egoEdgeDescription(
  edge: EgoGraphEdge,
  titleOf: (id: string) => string,
  t: Translator
): string {
  const view = relationTypeView(edge.type);
  const subject = titleOf(edge.source);
  const object = titleOf(edge.target);
  const sentence =
    !view.directed || edge.directed
      ? t("notePage.card.sentence", { values: { subject, verb: t(view.verbKey), object } })
      : t("notePage.card.undirected", { values: { subject, object, word: t(view.wordKey) } });
  return `${sentence}. ${t(edgeStateKey(edge.state))}`;
}

export function edgeStateKey(
  state: ObjectNeighborhoodEdgeState
): "notePage.graph.stateSuggested" | "notePage.graph.stateKept" | "notePage.graph.stateApplied" {
  if (state === "suggested") return "notePage.graph.stateSuggested";
  return state === "kept" ? "notePage.graph.stateKept" : "notePage.graph.stateApplied";
}

/** An item the keyboard cursor can stand on: the notes first (the focus, depth 1, depth 2), then the relations. */
export interface EgoCursorItem {
  type: "node" | "edge";
  id: string;
}

export function egoCursorItems(model: EgoGraphModel): EgoCursorItem[] {
  return [
    ...model.nodes.map((node) => ({ type: "node" as const, id: node.id })),
    ...model.edges.map((edge) => ({ type: "edge" as const, id: edge.id }))
  ];
}

/** The key's effect on a cursor: the next index, or null for a key the cursor ignores. */
export function moveEgoCursor(count: number, current: number | null, key: string): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0) return null;
  if (current === null) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}
