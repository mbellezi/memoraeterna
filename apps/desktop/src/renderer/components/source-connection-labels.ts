import type Graph from "graphology";
import type { EdgeLabelDrawingFunction } from "sigma/rendering";

/** Allocate rows once from canonical, directed endpoints, independently of draw/hover order. */
export function assignSourceConnectionLabelRows(graph: Graph): void {
  const groups = new Map<string, string[]>();
  for (const edge of graph.edges()) {
    const attributes = graph.getEdgeAttributes(edge);
    if (!attributes.label || attributes.interactionTarget) continue;
    const pair = JSON.stringify([graph.source(edge), graph.target(edge)]);
    const edges = groups.get(pair) ?? [];
    edges.push(edge);
    groups.set(pair, edges);
  }
  for (const edges of groups.values()) {
    edges.sort();
    const source = graph.source(edges[0]!);
    const target = graph.target(edges[0]!);
    // Opposite directions occupy opposite sides of the readable text axis.
    const side = groups.has(JSON.stringify([target, source])) && source > target ? -1 : 1;
    edges.forEach((edge, index) => graph.mergeEdgeAttributes(edge, {
      labelLineIndex: index, labelLineCount: edges.length, labelSide: side
    }));
  }
}

export const drawSourceConnectionLabel: EdgeLabelDrawingFunction = (context, edge, source, target, settings) => {
  if (!edge.label || edge.interactionTarget) return;
  const dx = target.x - source.x, dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  const available = length - source.size - target.size - 8;
  if (available <= 0 || !Number.isFinite(available)) return;
  const size = settings.edgeLabelSize;
  const lineHeight = size * 1.35;
  const index = Number(edge.labelLineIndex ?? 0);
  const count = Number(edge.labelLineCount ?? 1);
  const side = edge.labelSide === -1 ? -1 : 1;
  const row = side === -1 ? count - index - 1 : index;
  // Screen-pixel spacing must not depend on Sigma's zoom-compensated edge size.
  const offset = side * (size / 2 + 5 + row * lineHeight);
  let angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  const shift = (source.size - target.size) / (2 * length);
  context.save();
  context.font = `${settings.edgeLabelWeight} ${size}px ${settings.edgeLabelFont}`;
  context.fillStyle = (settings.edgeLabelColor.attribute
    ? String(edge[settings.edgeLabelColor.attribute] ?? settings.edgeLabelColor.color ?? edge.color)
    : settings.edgeLabelColor.color) ?? edge.color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const label = fitLabel(context, edge.label, available);
  context.translate((source.x + target.x) / 2 + dx * shift, (source.y + target.y) / 2 + dy * shift);
  context.rotate(angle);
  if (label) context.fillText(label, 0, offset);
  context.restore();
};

function fitLabel(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  if (context.measureText("…").width > width) return "";
  const characters = Array.from(text);
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(characters.slice(0, middle).join("") + "…").width <= width) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("") + "…";
}
