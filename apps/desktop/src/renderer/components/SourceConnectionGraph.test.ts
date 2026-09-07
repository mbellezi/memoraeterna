import { describe, expect, it } from "vitest";
import { addSourceConnectionHitAreas, sourceConnectionEmphasis, buildSourceConnectionGraph, sourceConnectionArrowOptions, sourceConnectionEdgeThickness } from "./SourceConnectionGraph";
import { graphNodeSize, zoomCompensatedEdgeSize } from "./knowledge-graph-view-model";

describe("source connection graph preview", () => {
  it("preserves canonical identity, isolated shared entities, direction and parallel relations", () => {
    const graph = buildSourceConnectionGraph({
      sharedEntities: ["Same name", "Isolated"], semanticRelations: [],
      entities: [
        { id: "a", label: "Same name", shared: true },
        { id: "b", label: "Same name", shared: false },
        { id: "c", label: "Isolated", shared: true }
      ],
      relations: [
        { id: "r1", source: "a", target: "b", label: "contains · punctuation" },
        { id: "r2", source: "a", target: "b", label: "supports" },
        { id: "r3", source: "b", target: "a", label: "extends" }
      ]
    });
    expect(graph.order).toBe(3);
    expect(graph.size).toBe(3);
    expect(graph.degree("c")).toBe(0);
    expect(graph.source("r3")).toBe("b");
    expect(graph.target("r3")).toBe("a");
    expect(graph.getEdgeAttribute("r1", "label")).toBe("contains · punctuation");
    expect(graph.getNodeAttribute("a", "color")).not.toBe(graph.getNodeAttribute("b", "color"));
    for (const id of graph.nodes()) expect(graph.getNodeAttribute(id, "size")).toBe(graphNodeSize(graph.degree(id)));
  });

  it("keeps the shaft and arrowhead dimensions constant across the full popup zoom range", () => {
    for (const ratio of [0.02, 0.08, 0.25, 1, 4, 12]) {
      const screenSize = zoomCompensatedEdgeSize(ratio, sourceConnectionEdgeThickness) / Math.sqrt(ratio);
      expect(screenSize).toBeCloseTo(2.1);
      expect(screenSize * sourceConnectionArrowOptions.lengthToThicknessRatio).toBeCloseTo(8.4);
      expect(screenSize * sourceConnectionArrowOptions.widenessToThicknessRatio).toBeCloseTo(6.3);
    }
  });

  it("accepts an empty connection", () => {
    expect(buildSourceConnectionGraph({ sharedEntities: [], semanticRelations: [], entities: [], relations: [] }).order).toBe(0);
  });

  it("highlights only the selected neighborhood or relation and keeps hit areas out of node sizing", () => {
    const graph = buildSourceConnectionGraph({ sharedEntities: [], semanticRelations: [],
      entities: ["a", "b", "c", "d"].map((id) => ({ id, label: id, shared: false })),
      relations: [{ id: "ab", source: "a", target: "b", label: "supports" }, { id: "bc", source: "b", target: "c", label: "supports" }]
    });
    const sizes = graph.nodes().map((id) => graph.getNodeAttribute(id, "size"));
    addSourceConnectionHitAreas(graph);
    expect(graph.nodes().map((id) => graph.getNodeAttribute(id, "size"))).toEqual(sizes);
    expect(graph.getEdgeAttributes("hit:ab")).toMatchObject({ interactionTarget: "ab", size: 10, color: "rgba(0, 0, 0, 0)", label: null });
    for (const type of ["node", "edge"] as const) {
      const target = { type, key: type === "node" ? "a" : "ab", x: 0, y: 0 };
      expect(sourceConnectionEmphasis(graph, "node", "b", target, 1).color).toBe(graph.getNodeAttribute("b", "color"));
      expect(sourceConnectionEmphasis(graph, "edge", "ab", target, 1).color).toBe("rgba(252, 165, 165, 1)");
      const muted = sourceConnectionEmphasis(graph, "node", "c", target, 1).color as string;
      expect(muted).toMatch(/^rgba\(148, 148, 148,/);
      expect(Number.parseFloat(muted.slice(muted.lastIndexOf(",") + 1))).toBeCloseTo(type === "node" ? 0.1 : 0.04);
      expect(sourceConnectionEmphasis(graph, "edge", "bc", target, 1).labelColor).not.toBe("#cbd5e1");
      expect(sourceConnectionEmphasis(graph, "node", "c", null, 0).color).toBe(graph.getNodeAttribute("c", "color"));
    }
  });
});
