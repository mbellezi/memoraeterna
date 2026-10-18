import Graph from "graphology";

import { relationHitAreaScreenThickness } from "./view-model";
import { blendGraphColor } from "./interaction";
import type { EgoGraphModel } from "./ego-graph-model";
import type { GraphPalette } from "./graph-tokens";

/**
 * The graphology graph Sigma draws for the Note page's relation graph, and the rules that colour it.
 * Nothing here touches the DOM or WebGL: the colours of a frame come from the palette the reader
 * last returned, so a theme change repaints with `renderer.refresh()` and builds nothing again.
 */
export const egoEdgeThickness = 2.2;
export const egoSuggestionThickness = 1.8;
export const egoArrowOptions = { lengthToThicknessRatio: 4, widenessToThicknessRatio: 3 };
/** How much of a suggestion's line is left to the eye next to a relation somebody kept. */
export const egoSuggestionOpacity = 0.78;
/** Notes of the second ring are quieter than the ones related to this note. */
export const egoSecondRingFade = 0.3;
/** What the rest of the graph fades to while one note or relation is emphasised. */
export const egoBackgroundOpacity = 0.16;

export interface EgoNodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  depth: 0 | 1 | 2;
  focus: boolean;
  forceLabel: boolean;
  labelColor?: string;
  zIndex?: number;
  [key: string]: unknown;
}

export interface EgoEdgeAttributes {
  /** Sigma's program for the edge: line, arrow, dashed or dashed-arrow; `line` for a hit area. */
  type: string;
  size: number;
  color: string;
  /** A hit area has this set to the relation it stands for. */
  interactionTarget: string | null;
  stance: string;
  suggested: boolean;
  label: null;
  forceLabel: false;
  zIndex?: number;
  [key: string]: unknown;
}

export type EgoGraph = Graph<EgoNodeAttributes, EgoEdgeAttributes>;

export function buildEgoSigmaGraph(model: EgoGraphModel, palette: GraphPalette): EgoGraph {
  const graph: EgoGraph = new Graph({ type: "directed", multi: true });
  for (const node of model.nodes)
    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: node.size,
      label: node.label,
      color: nodeColor(node.depth, palette),
      depth: node.depth,
      focus: node.focus,
      // The focus and the notes related to it are always named; the second ring names itself when
      // there is room (Sigma's label grid decides), and the card and the list name every note.
      forceLabel: node.depth < 2
    });
  for (const edge of model.edges)
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      type: edge.program,
      size: edge.suggested ? egoSuggestionThickness : egoEdgeThickness,
      color: edgeColor(edge.stance, edge.suggested, palette),
      interactionTarget: null,
      stance: edge.stance,
      suggested: edge.suggested,
      label: null,
      forceLabel: false
    });
  // A dashed line has gaps a pointer would fall through: each relation has an invisible, wider
  // line of its own that answers hover and click, and stands for the relation.
  for (const edge of model.edges)
    graph.addDirectedEdgeWithKey(`hit:${edge.id}`, edge.source, edge.target, {
      type: "line",
      size: relationHitAreaScreenThickness,
      color: "rgba(0, 0, 0, 0)",
      interactionTarget: edge.id,
      stance: edge.stance,
      suggested: edge.suggested,
      label: null,
      forceLabel: false,
      zIndex: 10
    });
  return graph;
}

export function nodeColor(depth: 0 | 1 | 2, palette: GraphPalette): string {
  return depth === 2
    ? blendGraphColor(palette.note, palette.canvasEdge, egoSecondRingFade)
    : palette.note;
}

export function edgeColor(stance: string, suggested: boolean, palette: GraphPalette): string {
  const base = palette.stance[stance as keyof GraphPalette["stance"]] ?? palette.stance.related;
  return suggested ? blendGraphColor(base, base, 0, egoSuggestionOpacity) : base;
}

/** What is emphasised: a note or a relation, by its key in the graph (never a hit area's). */
export interface EgoTarget {
  type: "node" | "edge";
  key: string;
}

/** True when the node or relation `key` belongs with `target`: the target itself or what touches it. */
export function isEmphasised(
  graph: EgoGraph,
  type: "node" | "edge",
  key: string,
  target: EgoTarget | null
): boolean {
  if (!target) return true;
  if (type === "node")
    return target.type === "node"
      ? key === target.key || graph.areNeighbors(key, target.key)
      : graph.extremities(target.key).includes(key);
  return target.type === "edge" ? key === target.key : graph.extremities(key).includes(target.key);
}

/** The display attributes of a note this frame: its resting colour, faded when something else is emphasised. */
export function nodeDisplay(
  graph: EgoGraph,
  key: string,
  target: EgoTarget | null,
  palette: GraphPalette
): { color: string; labelColor: string; zIndex: number; forceLabel?: boolean } {
  const depth = graph.getNodeAttribute(key, "depth");
  const base = nodeColor(depth, palette);
  const emphasised = isEmphasised(graph, "node", key, target);
  const chosen = target?.type === "node" && target.key === key;
  return {
    color: emphasised
      ? base
      : blendGraphColor(palette.note, palette.canvasEdge, 0.7, egoBackgroundOpacity),
    labelColor: emphasised
      ? palette.label
      : blendGraphColor(palette.labelMuted, palette.canvasEdge, 0.7, 0.4),
    zIndex: chosen ? 3 : emphasised ? 2 : 0,
    ...(chosen ? { forceLabel: true } : {})
  };
}

/** The display attributes of a relation this frame; a hit area never shows. */
export function edgeDisplay(
  graph: EgoGraph,
  key: string,
  target: EgoTarget | null,
  palette: GraphPalette
): { color: string; size: number; zIndex: number } {
  const stance = graph.getEdgeAttribute(key, "stance");
  const suggested = graph.getEdgeAttribute(key, "suggested");
  const resting = suggested ? egoSuggestionThickness : egoEdgeThickness;
  const emphasised = isEmphasised(graph, "edge", key, target);
  const chosen = target?.type === "edge" && target.key === key;
  return {
    color: emphasised
      ? edgeColor(stance, suggested, palette)
      : blendGraphColor(
          palette.stance[stance as keyof GraphPalette["stance"]] ?? palette.stance.related,
          palette.canvasEdge,
          0.7,
          egoBackgroundOpacity
        ),
    size: chosen ? resting * 1.6 : resting,
    zIndex: chosen ? 3 : emphasised ? 2 : 0
  };
}
