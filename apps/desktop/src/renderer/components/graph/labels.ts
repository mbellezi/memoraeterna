import type { GraphPalette } from "./graph-tokens";
import { graphTypography } from "./view-model";

/**
 * Node labels of a graph that reads the theme (design record 4.1 and 7.5): horizontal, at most two
 * lines, centred under the dot, in the label colour on a 3 px halo of the canvas colour, so a label
 * stays legible over the lines it crosses in either theme. Only the person's own text is drawn
 * here (a note's title), so a title too long for two lines ends in an ellipsis; the full title is
 * in the hover card, the keyboard description and the table.
 */

export const graphLabelLayout = {
  /** The widest a line may be, in CSS pixels. */
  maxWidth: 148,
  maxLines: 2,
  lineHeight: 14,
  /** The halo's width on each side of a glyph. */
  halo: 3,
  /** Space between the dot's edge and the first line. */
  gap: 5
} as const;

const ellipsis = "…";

/**
 * Breaks `text` into at most `maxLines` lines no wider than `maxWidth`, at spaces. A word wider than
 * a line is cut only on the last line, where the text ends in an ellipsis; nothing is ever cut
 * inside a word on a line that has more after it.
 */
export function wrapLabel(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
  maxLines: number = graphLabelLayout.maxLines
): string[] {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const last = lines.length === maxLines - 1;
    let line = words[index]!;
    index += 1;
    while (index < words.length && measure(`${line} ${words[index]}`) <= maxWidth) {
      line = `${line} ${words[index]}`;
      index += 1;
    }
    if (last && (index < words.length || measure(line) > maxWidth)) {
      const rest = index < words.length ? `${line} ${words.slice(index).join(" ")}` : line;
      lines.push(fitWithEllipsis(rest, maxWidth, measure));
      index = words.length;
    } else lines.push(line);
  }
  return lines;
}

/** The longest start of `text` that, with an ellipsis, fits `maxWidth` (at a space when one is near). */
function fitWithEllipsis(text: string, maxWidth: number, measure: (value: string) => number) {
  if (measure(text) <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, middle).trimEnd()}${ellipsis}`) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  const cut = text.slice(0, low);
  const space = cut.lastIndexOf(" ");
  const start = space > cut.length * 0.6 ? cut.slice(0, space) : cut;
  return `${start.trimEnd()}${ellipsis}`;
}

/** What a label drawer needs of a node this frame (Sigma's display data). */
export interface LabelNode {
  x: number;
  y: number;
  size: number;
  label?: string | null;
  labelColor?: string;
  /** Drawn in semibold: the node in focus, or the one under the pointer. */
  emphasised?: boolean;
}

export interface LabelContext {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  measureText(text: string): { width: number };
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}

/** Draws a node's label under it on a halo; returns the lines it drew (for tests). */
export function drawHaloLabel(
  context: LabelContext,
  node: LabelNode,
  palette: Pick<GraphPalette, "canvas" | "label">,
  size: number = graphTypography.labelSize
): string[] {
  if (!node.label) return [];
  const weight = node.emphasised ? "600" : graphTypography.labelWeight;
  context.font = `${weight} ${size}px ${graphTypography.labelFont}`;
  const lines = wrapLabel(
    node.label,
    graphLabelLayout.maxWidth,
    (value) => context.measureText(value).width
  );
  context.textAlign = "center";
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.lineWidth = graphLabelLayout.halo * 2;
  context.strokeStyle = palette.canvas;
  context.fillStyle = node.labelColor ?? palette.label;
  const top = node.y + node.size + graphLabelLayout.gap;
  lines.forEach((line, index) => {
    const y = top + index * graphLabelLayout.lineHeight;
    context.strokeText(line, node.x, y);
  });
  lines.forEach((line, index) => {
    const y = top + index * graphLabelLayout.lineHeight;
    context.fillText(line, node.x, y);
  });
  return lines;
}
