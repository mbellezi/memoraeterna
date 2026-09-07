import { describe, expect, it, vi } from "vitest";
import { buildSourceConnectionGraph, addSourceConnectionHitAreas } from "./SourceConnectionGraph";
import { drawSourceConnectionLabel } from "./source-connection-labels";
import { graphTypography } from "./knowledge-graph-view-model";

const relations = [
  { id: "b", source: "a", target: "b", label: "Julgamento no plenário" },
  { id: "a", source: "a", target: "b", label: "Liberou para julgamento" },
  { id: "reverse", source: "b", target: "a", label: "Foi relacionado a" },
  { id: "other", source: "a", target: "c", label: "Liberou para julgamento" }
];
const build = (items = relations) => buildSourceConnectionGraph({ sharedEntities: [], semanticRelations: [],
  entities: ["a", "b", "c"].map((id) => ({ id, label: "Same name", shared: false })), relations: items });
const settings = { ...graphTypography, edgeLabelColor: { attribute: "labelColor", color: "#cbd5e1" } } as Parameters<typeof drawSourceConnectionLabel>[4];
function canvas() {
  return { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), fillText: vi.fn(),
    measureText: (text: string) => ({ width: Array.from(text).length * 7 }), font: "", fillStyle: "", textAlign: "", textBaseline: "" };
}

describe("stacked source connection labels", () => {
  it("assigns stable rows by directed entity IDs, retaining every canonical edge and hit area", () => {
    const graph = build(), reordered = build([...relations].reverse());
    for (const edge of graph.edges()) {
      expect(graph.getEdgeAttribute(edge, "labelLineIndex")).toBe(reordered.getEdgeAttribute(edge, "labelLineIndex"));
    }
    expect(graph.getEdgeAttributes("a")).toMatchObject({ labelLineIndex: 0, labelLineCount: 2, labelSide: 1 });
    expect(graph.getEdgeAttributes("b")).toMatchObject({ labelLineIndex: 1, labelLineCount: 2, labelSide: 1 });
    expect(graph.getEdgeAttributes("reverse")).toMatchObject({ labelLineIndex: 0, labelLineCount: 1, labelSide: -1 });
    expect(graph.getEdgeAttributes("other")).toMatchObject({ labelLineIndex: 0, labelLineCount: 1 });
    addSourceConnectionHitAreas(graph);
    expect(graph.size).toBe(relations.length * 2);
    for (const { id, source, target } of relations) {
      expect(graph.source(id)).toBe(source); expect(graph.target(id)).toBe(target);
      expect(graph.getEdgeAttributes(`hit:${id}`)).toMatchObject({ interactionTarget: id, label: null });
    }
  });
  it("draws each phrase on a separate line with zoom-independent spacing and individual fade colors", () => {
    const graph = build();
    for (const edgeSize of [0.2, 2.1, 20]) {
      const context = canvas();
      for (const id of ["a", "b", "reverse"]) {
        drawSourceConnectionLabel(context as unknown as CanvasRenderingContext2D,
          { ...graph.getEdgeAttributes(id), label: graph.getEdgeAttribute(id, "label"), color: "white", size: edgeSize, labelColor: "rgba(148,148,148,0.1)" } as Parameters<typeof drawSourceConnectionLabel>[1],
          { x: 0, y: 0, size: 5 }, { x: 400, y: 0, size: 5 }, settings);
      }
      const offsets = context.fillText.mock.calls.map((call) => call[2] as number);
      expect(offsets[1]! - offsets[0]!).toBeCloseTo(graphTypography.edgeLabelSize * 1.35);
      expect(offsets[2]).toBeLessThan(0);
      expect(offsets[0]).toBeGreaterThan(0);
      expect(context.fillText.mock.calls[0]?.[0]).toBe("Liberou para julgamento");
      expect(context.fillText.mock.calls[1]?.[0]).toBe("Julgamento no plenário");
      expect(context.fillStyle).toBe("rgba(148,148,148,0.1)");
      expect(context.save).toHaveBeenCalledTimes(3); expect(context.restore).toHaveBeenCalledTimes(3);
    }
  });
  it("keeps labels readable in every orientation and fits long text without overlapping endpoints", () => {
    for (const [x, y] of [[200, 100], [-200, 100], [-200, -100], [0, -200], [0, 200]]) {
      const context = canvas();
      drawSourceConnectionLabel(context as unknown as CanvasRenderingContext2D, { label: "A very long translated relation ".repeat(10), size: 2.1, color: "white" },
        { x: 0, y: 0, size: 5 }, { x: x!, y: y!, size: 5 }, settings);
      const angle = context.rotate.mock.calls[0]?.[0] as number;
      expect(Math.abs(angle)).toBeLessThanOrEqual(Math.PI / 2);
      const text = context.fillText.mock.calls[0]?.[0] as string;
      expect(text.endsWith("…")).toBe(true);
      expect(context.measureText(text).width).toBeLessThanOrEqual(Math.hypot(x!, y!) - 18);
    }
    const context = canvas();
    drawSourceConnectionLabel(context as unknown as CanvasRenderingContext2D, { label: "Hidden", size: 2, color: "white" },
      { x: 0, y: 0, size: 5 }, { x: 0, y: 0, size: 5 }, settings);
    expect(context.fillText).not.toHaveBeenCalled();
  });
});
