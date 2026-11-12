import Graph from "graphology";

import type { RelationBranchStance } from "../../../../../shared/ipc-relations-branch";
import { topicColour, type GraphPalette } from "../../../../components/graph/graph-tokens";
import { blendGraphColor } from "../../../../components/graph/interaction";
import {
  graphLayoutRadius,
  graphSeedFraction,
  type GraphLayoutNode
} from "../../../../components/graph/layout-contract";
import { relationHitAreaScreenThickness } from "../../../../components/graph/view-model";
import type { BranchModel } from "./branch-model";

/**
 * The graphology graph Sigma draws for the Map › Grafo, and the rules that colour it (design record
 * 7.5). Nothing here touches the DOM or WebGL: the colours of a frame come from the palette the
 * reader last returned, so a theme change repaints with `renderer.refresh()` and builds nothing.
 *
 *   - a note is a dot in its topic group's colour (`--graph-topic-*`), sized by its connections;
 *   - a relation is a line in its stance colour with the stance glyph at its midpoint, dashed for
 *     a suggestion; a wider invisible line answers the pointer;
 *   - zoomed out past `branchZoom.superNodes`, each topic group becomes one labelled pill and the
 *     lines between groups one line each, as thick as the connections it stands for.
 */

export const branchEdgeThickness = 2;
export const branchSuggestionThickness = 1.6;
/** A suggestion keeps its stance colour at this opacity (3:1 on the canvas: contrast/tokens.test.ts). */
export const branchSuggestionOpacity = 0.78;
/** What the rest of the graph fades to while one note, relation or group is emphasised: it recedes, still readable. */
export const branchBackgroundOpacity = 0.4;
/** The labels of what recedes keep about 3:1 against the canvas in both themes. */
export const branchBackgroundLabelOpacity = 0.7;

export const branchZoom = {
  /**
   * The camera ratio past which the canvas shows topic groups instead of notes (Sigma's ratio grows
   * as the camera zooms out): a branch of up to `crowded` notes, where the labels still fit.
   */
  superNodes: 2.2,
  /** A branch of more than `crowded` notes crowds sooner, so its groups take over sooner *(cal.)*. */
  superNodesCrowded: 1.6,
  /** Notes from which a branch is crowded *(cal.)*. */
  crowded: 150,
  /** A branch of fewer notes is always read as notes: a few pills would hide what fits on screen *(cal.)*. */
  small: 12,
  /** Super-edge thickness: the lightest and the heaviest line between two groups. */
  superEdgeMin: 1.5,
  superEdgeMax: 9
} as const;

/** The forces of the branch layout: a few hundred notes want more room than an ego graph. */
export const branchForces = {
  repulsion: 90,
  linkStrength: 0.3,
  linkDistance: 48,
  centerStrength: 0.025
} as const;

export type BranchElementKind = "note" | "group";

export interface BranchNodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  kind: BranchElementKind;
  /** The topic group (a note's, or the group a super-node stands for); null for an unplaced note. */
  group: string | null;
  colourIndex: number | null;
  forceLabel: boolean;
  hidden?: boolean;
  labelColor?: string;
  emphasised?: boolean;
  zIndex?: number;
  [key: string]: unknown;
}

export interface BranchEdgeAttributes {
  /** Sigma's program: `line` or `dashed`. */
  type: "line" | "dashed";
  size: number;
  color: string;
  kind: "note" | "super";
  stance: RelationBranchStance | null;
  suggested: boolean;
  /** A hit area has this set to the relation it stands for. */
  interactionTarget: string | null;
  weight: number;
  /** Drawn by the edge-label layer: the stance glyph at the midpoint. */
  forceLabel: boolean;
  glyphColor?: string;
  hidden?: boolean;
  zIndex?: number;
  [key: string]: unknown;
}

export type BranchGraph = Graph<BranchNodeAttributes, BranchEdgeAttributes>;

/** The key of the super-node that stands for a topic group. */
export const groupNodeKey = (groupId: string) => `group:${groupId}`;
const superEdgeKey = (a: string, b: string) => `super:${a}:${b}`;
const hitKey = (edgeId: string) => `hit:${edgeId}`;

/** A note's resting colour: its group's topic colour, or the plain note colour when it has none. */
export function noteColour(colourIndex: number | null, palette: GraphPalette): string {
  return colourIndex === null ? palette.labelMuted : topicColour(palette, colourIndex);
}

export function relationColour(
  stance: RelationBranchStance,
  suggested: boolean,
  palette: GraphPalette
): string {
  const base = palette.stance[stance] ?? palette.stance.related;
  return suggested ? blendGraphColor(base, base, 0, branchSuggestionOpacity) : base;
}

/** Thickness of a line between two groups, from its weight against the heaviest one drawn. */
export function superEdgeThickness(weight: number, heaviest: number): number {
  if (heaviest <= 1) return branchZoom.superEdgeMin;
  const share = Math.log1p(Math.max(0, weight - 1)) / Math.log1p(heaviest - 1);
  return branchZoom.superEdgeMin + (branchZoom.superEdgeMax - branchZoom.superEdgeMin) * share;
}

/**
 * Where the layout starts: each group on a golden-angle spiral, its notes around it. Deterministic,
 * never random, so the same branch opens the same way.
 */
function seedPosition(
  index: number,
  groupIndex: number,
  groupCount: number,
  radius: number,
  id: string
): { x: number; y: number } {
  const angle = groupIndex * 2.399963229728653;
  const centre = radius * 0.6 * Math.sqrt(groupIndex / Math.max(1, groupCount));
  const local = branchForces.linkDistance * 0.45 * Math.sqrt(index + graphSeedFraction(id));
  const localAngle = index * 2.399963229728653;
  return {
    x: Math.cos(angle) * centre + Math.cos(localAngle) * local,
    y: Math.sin(angle) * centre + Math.sin(localAngle) * local
  };
}

export function buildBranchSigmaGraph(model: BranchModel, palette: GraphPalette): BranchGraph {
  const graph: BranchGraph = new Graph({ type: "undirected", multi: true });
  const groupOrder = new Map(model.groups.map((group, index) => [group.id, index]));
  const radius = graphLayoutRadius(model.nodes.length, branchForces.linkDistance);
  const seen = new Map<string, number>();
  for (const node of model.nodes) {
    const groupKey = node.groupId ?? "";
    const index = seen.get(groupKey) ?? 0;
    seen.set(groupKey, index + 1);
    const position = seedPosition(
      index,
      node.groupId === null ? model.groups.length : groupOrder.get(node.groupId)!,
      model.groups.length + 1,
      radius,
      node.id
    );
    graph.addNode(node.id, {
      ...position,
      size: node.size,
      label: node.title,
      color: noteColour(node.colourIndex, palette),
      kind: "note",
      group: node.groupId,
      colourIndex: node.colourIndex,
      forceLabel: false
    });
  }
  for (const group of model.groups)
    graph.addNode(groupNodeKey(group.id), {
      x: 0,
      y: 0,
      size: 4,
      label: group.legendLabel,
      color: topicColour(palette, group.colourIndex),
      kind: "group",
      group: group.id,
      colourIndex: group.colourIndex,
      forceLabel: true,
      hidden: true
    });
  for (const edge of model.edges) {
    graph.addUndirectedEdgeWithKey(edge.id, edge.a, edge.b, {
      type: edge.suggested ? "dashed" : "line",
      size: edge.suggested ? branchSuggestionThickness : branchEdgeThickness,
      color: relationColour(edge.stance, edge.suggested, palette),
      kind: "note",
      stance: edge.stance,
      suggested: edge.suggested,
      interactionTarget: null,
      weight: 1,
      forceLabel: true
    });
    // A dashed or thin line has gaps a pointer would fall through: each relation has an invisible,
    // wider line of its own that answers hover and click, and stands for the relation.
    graph.addUndirectedEdgeWithKey(hitKey(edge.id), edge.a, edge.b, {
      type: "line",
      size: relationHitAreaScreenThickness,
      color: blendGraphColor(palette.canvas, palette.canvas, 0, 0),
      kind: "note",
      stance: edge.stance,
      suggested: edge.suggested,
      interactionTarget: edge.id,
      weight: 1,
      forceLabel: false
    });
  }
  const heaviest = Math.max(1, ...model.superEdges.map((edge) => edge.weight));
  for (const edge of model.superEdges)
    graph.addUndirectedEdgeWithKey(
      superEdgeKey(edge.a, edge.b),
      groupNodeKey(edge.a),
      groupNodeKey(edge.b),
      {
        type: "line",
        size: superEdgeThickness(edge.weight, heaviest),
        color: palette.labelMuted,
        kind: "super",
        stance: null,
        suggested: false,
        interactionTarget: null,
        weight: edge.weight,
        forceLabel: false,
        hidden: true
      }
    );
  placeGroupNodes(graph);
  return graph;
}

/** Moves each super-node to the centre of its group's notes (after each layout step). */
export function placeGroupNodes(graph: BranchGraph): void {
  const sums = new Map<string, { x: number; y: number; count: number }>();
  graph.forEachNode((_key, attributes) => {
    if (attributes.kind !== "note" || attributes.group === null) return;
    const sum = sums.get(attributes.group) ?? { x: 0, y: 0, count: 0 };
    sum.x += attributes.x;
    sum.y += attributes.y;
    sum.count += 1;
    sums.set(attributes.group, sum);
  });
  for (const [group, sum] of sums) {
    const key = groupNodeKey(group);
    if (graph.hasNode(key))
      graph.mergeNodeAttributes(key, { x: sum.x / sum.count, y: sum.y / sum.count });
  }
}

/**
 * The camera ratio past which topic groups replace the notes, or null when the branch has no such
 * view: it has one topic group only, or too few notes for groups to say more than the notes do
 * (the table beside the canvas lists the connections either way).
 */
export function superNodeRatio(model: Pick<BranchModel, "groups" | "nodes">): number | null {
  if (model.groups.length < 2 || model.nodes.length < branchZoom.small) return null;
  return model.nodes.length > branchZoom.crowded
    ? branchZoom.superNodesCrowded
    : branchZoom.superNodes;
}

/** Whether the camera is far enough out to show topic groups instead of notes. */
export function showsGroups(
  model: Pick<BranchModel, "groups" | "nodes">,
  cameraRatio: number
): boolean {
  const threshold = superNodeRatio(model);
  return threshold !== null && cameraRatio >= threshold;
}

/** What is emphasised: a note, a relation or a group, by its key in the graph (never a hit area's). */
export interface BranchTarget {
  type: "node" | "edge";
  key: string;
}

/** The relation a key stands for: a hit area stands for its relation. */
export function relationOf(graph: BranchGraph, key: string): string {
  return graph.getEdgeAttribute(key, "interactionTarget") ?? key;
}

function isEmphasised(
  graph: BranchGraph,
  type: "node" | "edge",
  key: string,
  target: BranchTarget | null
): boolean {
  if (!target) return true;
  if (type === "node") {
    if (target.type === "node") return key === target.key || graph.areNeighbors(key, target.key);
    return graph.hasEdge(target.key) && graph.extremities(target.key).includes(key);
  }
  if (target.type === "edge") return relationOf(graph, key) === target.key;
  return graph.extremities(key).includes(target.key);
}

/** The display attributes of a node this frame. */
export function branchNodeDisplay(
  graph: BranchGraph,
  key: string,
  target: BranchTarget | null,
  zoomedOut: boolean,
  palette: GraphPalette
): Partial<BranchNodeAttributes> {
  const attributes = graph.getNodeAttributes(key);
  const isGroup = attributes.kind === "group";
  if (isGroup !== zoomedOut) return { hidden: true };
  const base = isGroup
    ? topicColour(palette, attributes.colourIndex ?? 0)
    : noteColour(attributes.colourIndex, palette);
  const emphasised = isEmphasised(graph, "node", key, target);
  const chosen = target?.type === "node" && target.key === key;
  return {
    hidden: false,
    color: emphasised ? base : blendGraphColor(base, palette.canvas, 0, branchBackgroundOpacity),
    labelColor: emphasised
      ? palette.label
      : blendGraphColor(palette.labelMuted, palette.canvas, 0, branchBackgroundLabelOpacity),
    emphasised: chosen,
    zIndex: chosen ? 3 : emphasised ? 2 : 0,
    ...(chosen ? { forceLabel: true } : {})
  };
}

/** The display attributes of a line this frame; a hit area never shows. */
export function branchEdgeDisplay(
  graph: BranchGraph,
  key: string,
  target: BranchTarget | null,
  zoomedOut: boolean,
  palette: GraphPalette
): Partial<BranchEdgeAttributes> {
  const attributes = graph.getEdgeAttributes(key);
  const isSuper = attributes.kind === "super";
  if (isSuper !== zoomedOut) return { hidden: true };
  if (attributes.interactionTarget !== null) return { hidden: false };
  if (isSuper) return { hidden: false, color: palette.labelMuted };
  const stance = attributes.stance ?? "related";
  const emphasised = isEmphasised(graph, "edge", key, target);
  const chosen = target?.type === "edge" && target.key === key;
  const resting = attributes.suggested ? branchSuggestionThickness : branchEdgeThickness;
  const colour = emphasised
    ? relationColour(stance, attributes.suggested, palette)
    : blendGraphColor(palette.stance[stance], palette.canvas, 0, branchBackgroundOpacity);
  return {
    hidden: false,
    color: colour,
    glyphColor: emphasised ? palette.stance[stance] : colour,
    size: chosen ? resting * 1.8 : resting,
    zIndex: chosen ? 3 : emphasised ? 2 : 0
  };
}

/**
 * The stance glyphs of `components/glyphs.tsx` as path data for a canvas (a 16 px grid, stroked at
 * 1.5): Path2D takes no `<circle>` or `<rect>`, so circles and rounded rectangles are arcs here.
 */
export const stanceGlyphPaths: Readonly<Record<RelationBranchStance, string>> = {
  supports: "M14 8a6 6 0 1 1-12 0a6 6 0 1 1 12 0M8 5v6M5 8h6",
  contradicts: "M1.5 8H6M4 5.5 6.5 8 4 10.5M14.5 8H10M12 5.5 9.5 8 12 10.5",
  extends: "M2.5 4v8M2.5 8h10M10 5.5l2.5 2.5-2.5 2.5",
  depends_on:
    "M4.25 5.25h2a2.75 2.75 0 0 1 0 5.5h-2a2.75 2.75 0 0 1 0-5.5zM9.75 5.25h2a2.75 2.75 0 0 1 0 5.5h-2a2.75 2.75 0 0 1 0-5.5z",
  example_of:
    "M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0",
  related:
    "M5.75 12a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0M13.75 4a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0M5.25 10.75l5.5-5.5"
};

/** The glyph's disc: its radius on screen, and the shortest line that carries one. */
export const midpointGlyph = { radius: 9, glyphSize: 14, minimumLine: 52 } as const;

/**
 * Where a relation's stance glyph sits on screen: the midpoint of the visible part of the line, or
 * null when the line is too short on screen to carry it (zoomed out, or two notes side by side).
 */
export function midpointOf(
  source: { x: number; y: number; size: number },
  target: { x: number; y: number; size: number }
): { x: number; y: number } | null {
  const length = Math.hypot(target.x - source.x, target.y - source.y);
  if (length - source.size - target.size < midpointGlyph.minimumLine) return null;
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
}

/** Path2D objects for the stance glyphs, built once per window (a canvas only). */
let glyphCache: Map<RelationBranchStance, Path2D> | null = null;
function glyphPath(stance: RelationBranchStance): Path2D {
  glyphCache ??= new Map();
  let path = glyphCache.get(stance);
  if (!path) {
    path = new Path2D(stanceGlyphPaths[stance]);
    glyphCache.set(stance, path);
  }
  return path;
}

/**
 * Draws a relation's stance glyph at the midpoint of its line, on a disc of the canvas colour, in
 * the colour it is given (its stance colour, or faded with the line). Nothing on a short line.
 */
export function drawMidpointGlyph(
  context: CanvasRenderingContext2D,
  source: { x: number; y: number; size: number },
  target: { x: number; y: number; size: number },
  stance: RelationBranchStance | null,
  colour: string,
  palette: Pick<GraphPalette, "canvas">
): void {
  const point = midpointOf(source, target);
  if (!point || !stance) return;
  const scale = midpointGlyph.glyphSize / 16;
  context.save();
  context.beginPath();
  context.arc(point.x, point.y, midpointGlyph.radius, 0, Math.PI * 2);
  context.fillStyle = palette.canvas;
  context.fill();
  context.translate(point.x - midpointGlyph.glyphSize / 2, point.y - midpointGlyph.glyphSize / 2);
  context.scale(scale, scale);
  context.lineWidth = 1.5;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = colour;
  context.stroke(glyphPath(stance));
  context.restore();
}

/**
 * The turn that lays a branch along the canvas's long side. The forces have no preferred
 * direction, so a chain of notes may settle upright inside a wide canvas and leave most of it
 * empty; turning the drawing so its principal axis runs across the canvas fits it larger, with
 * more room between labels. Positions are `[x0, y0, x1, y1, …]`; `previous` keeps the turn
 * continuous while the layout settles (an axis has two directions: the nearer one is kept).
 */
export function landscapeTurn(
  positions: ArrayLike<number>,
  wide: boolean,
  previous: number | null
): number {
  const count = Math.floor(positions.length / 2);
  if (count < 2) return previous ?? 0;
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    meanX += positions[index * 2]!;
    meanY += positions[index * 2 + 1]!;
  }
  meanX /= count;
  meanY /= count;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = positions[index * 2]! - meanX;
    const dy = positions[index * 2 + 1]! - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  if (xx + yy === 0) return previous ?? 0;
  // The principal axis's angle; turning by its negative lays it along x (along y on a tall canvas).
  const axis = 0.5 * Math.atan2(2 * xy, xx - yy);
  let turn = -axis + (wide ? 0 : Math.PI / 2);
  if (previous !== null) {
    while (turn - previous > Math.PI / 2) turn -= Math.PI;
    while (previous - turn > Math.PI / 2) turn += Math.PI;
  }
  return turn;
}

/** `positions` turned by `angle` around the origin (the layout's centre). */
export function turnPositions(positions: ArrayLike<number>, angle: number): Float32Array {
  const turned = new Float32Array(positions.length);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let index = 0; index + 1 < positions.length; index += 2) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    turned[index] = x * cos - y * sin;
    turned[index + 1] = x * sin + y * cos;
  }
  return turned;
}

/**
 * What a canvas built again for the same branch keeps from the one before it: a live re-read that
 * changed the answer, or a new interface language, never moves the camera, resets the layout or
 * plays the settling again.
 */
export interface BranchCarry {
  /** The branch it was drawn for (`branchCarryKey`). */
  key: string;
  /** Each note where the layout left it, in the layout's own (unturned) frame. */
  settled: ReadonlyMap<string, { x: number; y: number }>;
  turn: number | null;
  /** The custom bounding box's half side: the same camera state frames the same place. */
  radius: number;
  camera: { x: number; y: number; ratio: number; angle: number };
  /** The person moved the camera: it is no longer fitted to the notes as they settle. */
  interacted: boolean;
}

export const branchCarryKey = (model: Pick<BranchModel, "scope">): string =>
  `${model.scope.kind}:${model.scope.id}`;

/**
 * Puts each carried note back where it was drawn and returns the layout's seeds in its own frame;
 * a note the last canvas did not draw starts at its group's seed. Without a carry the graph keeps
 * its seeds.
 */
export function carryBranchLayout(
  graph: BranchGraph,
  notes: readonly string[],
  carry: BranchCarry | null
): GraphLayoutNode[] {
  const seeds = notes.map((id) => {
    const attributes = graph.getNodeAttributes(id);
    const kept = carry?.settled.get(id);
    return {
      id,
      x: kept?.x ?? attributes.x,
      y: kept?.y ?? attributes.y,
      ...(attributes.group !== null ? { group: attributes.group } : {})
    };
  });
  if (!carry) return seeds;
  const flat = new Float32Array(seeds.length * 2);
  seeds.forEach((seed, index) => {
    flat[index * 2] = seed.x;
    flat[index * 2 + 1] = seed.y;
  });
  const drawn = carry.turn === null ? flat : turnPositions(flat, carry.turn);
  notes.forEach((id, index) => {
    graph.mergeNodeAttributes(id, { x: drawn[index * 2]!, y: drawn[index * 2 + 1]! });
  });
  placeGroupNodes(graph);
  return seeds;
}
