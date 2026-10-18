import { describe, expect, it } from "vitest";
import type { ObjectNeighborhood } from "@app/domain";

import { buildEgoGraphModel } from "./ego-graph-model";
import {
  buildEgoSigmaGraph,
  edgeColor,
  edgeDisplay,
  egoBackgroundOpacity,
  egoEdgeThickness,
  egoSuggestionOpacity,
  egoSuggestionThickness,
  isEmphasised,
  nodeColor,
  nodeDisplay
} from "./ego-graph-sigma";
import { fallbackGraphPalette, type GraphPalette } from "./graph-tokens";
import { relationHitAreaScreenThickness } from "./view-model";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, depth: 0 | 1 | 2) => ({
  id: id(n),
  kind: "note" as const,
  title: `Note ${n}`,
  ideaStatement: `Idea ${n}.`,
  language: null,
  depth
});
const answer: ObjectNeighborhood = {
  focus: id(1),
  depth: 2,
  nodes: [node(1, 0), node(2, 1), node(3, 1), node(4, 2)],
  edges: [
    {
      id: id(101),
      lo: id(1),
      hi: id(2),
      direction: "lo_to_hi",
      type: "supports",
      state: "kept",
      band: null
    },
    {
      id: id(102),
      lo: id(1),
      hi: id(3),
      direction: "lo_to_hi",
      type: "extends",
      state: "suggested",
      band: "suggest"
    },
    {
      id: id(103),
      lo: id(2),
      hi: id(4),
      direction: "symmetric",
      type: "contradicts",
      state: "applied",
      band: null
    }
  ],
  neighbourTotal: 2,
  truncated: false
};
const model = buildEgoGraphModel(answer);
const palette = fallbackGraphPalette;

describe("the graph Sigma draws", () => {
  const graph = buildEgoSigmaGraph(model, palette);

  it("has a note per node, a relation per edge and one invisible hit area for each relation", () => {
    expect(graph.order).toBe(4);
    expect(graph.size).toBe(6);
    const hits = graph.edges().filter((edge) => graph.getEdgeAttribute(edge, "interactionTarget"));
    expect(hits.map((edge) => graph.getEdgeAttribute(edge, "interactionTarget")).sort()).toEqual(
      [id(101), id(102), id(103)].sort()
    );
    for (const hit of hits) {
      expect(graph.getEdgeAttribute(hit, "type")).toBe("line");
      expect(graph.getEdgeAttribute(hit, "color")).toBe("rgba(0, 0, 0, 0)");
      expect(graph.getEdgeAttribute(hit, "size")).toBe(relationHitAreaScreenThickness);
    }
  });

  it("gives each relation the program of its kind and the thickness of its state", () => {
    expect(graph.getEdgeAttribute(id(101), "type")).toBe("arrow");
    expect(graph.getEdgeAttribute(id(102), "type")).toBe("dashed-arrow");
    expect(graph.getEdgeAttribute(id(103), "type")).toBe("line");
    expect(graph.getEdgeAttribute(id(101), "size")).toBe(egoEdgeThickness);
    expect(graph.getEdgeAttribute(id(102), "size")).toBe(egoSuggestionThickness);
    expect(egoSuggestionThickness).toBeLessThan(egoEdgeThickness);
  });

  it("names the focus and the notes related to it, and sizes from the model", () => {
    expect(graph.getNodeAttribute(id(1), "forceLabel")).toBe(true);
    expect(graph.getNodeAttribute(id(2), "forceLabel")).toBe(true);
    expect(graph.getNodeAttribute(id(4), "forceLabel")).toBe(false);
    expect(graph.getNodeAttribute(id(1), "size")).toBeGreaterThan(
      graph.getNodeAttribute(id(2), "size")
    );
    expect(graph.getNodeAttribute(id(2), "label")).toBe("Note 2");
  });

  it("colours from the palette it was given: the note colour, the stance colour, a suggestion softer", () => {
    expect(graph.getNodeAttribute(id(2), "color")).toBe(palette.note);
    expect(graph.getEdgeAttribute(id(101), "color")).toBe(palette.stance.supports);
    expect(graph.getEdgeAttribute(id(103), "color")).toBe(palette.stance.contradicts);
    expect(edgeColor("extends", true, palette)).toMatch(
      new RegExp(`^rgba\\(\\d+, \\d+, \\d+, ${egoSuggestionOpacity}\\)$`, "u")
    );
    expect(nodeColor(2, palette)).not.toBe(palette.note);
  });
});

describe("a theme change repaints without a rebuild", () => {
  const graph = buildEgoSigmaGraph(model, palette);
  const other: GraphPalette = {
    ...palette,
    note: "#010203",
    stance: { ...palette.stance, supports: "#040506" }
  };

  it("reads the colours of a frame from the palette, not from the graph", () => {
    expect(nodeDisplay(graph, id(2), null, palette).color).toBe(palette.note);
    expect(nodeDisplay(graph, id(2), null, other).color).toBe("#010203");
    expect(edgeDisplay(graph, id(101), null, palette).color).toBe(palette.stance.supports);
    expect(edgeDisplay(graph, id(101), null, other).color).toBe("#040506");
    // The graph itself was built once and is the same object either way.
    expect(graph.order).toBe(4);
    expect(graph.size).toBe(6);
  });
});

describe("emphasis", () => {
  const graph = buildEgoSigmaGraph(model, palette);

  it("emphasises a note, what touches it and the relations around it; the rest fades", () => {
    const target = { type: "node" as const, key: id(2) };
    expect(isEmphasised(graph, "node", id(2), target)).toBe(true);
    expect(isEmphasised(graph, "node", id(1), target)).toBe(true);
    expect(isEmphasised(graph, "node", id(4), target)).toBe(true);
    expect(isEmphasised(graph, "node", id(3), target)).toBe(false);
    expect(nodeDisplay(graph, id(3), target, palette).color).toMatch(
      new RegExp(`, ${egoBackgroundOpacity}\\)$`, "u")
    );
    expect(nodeDisplay(graph, id(2), target, palette)).toMatchObject({
      zIndex: 3,
      forceLabel: true
    });
  });

  it("emphasises a relation and its two notes; a note elsewhere fades", () => {
    const target = { type: "edge" as const, key: id(102) };
    expect(isEmphasised(graph, "edge", id(102), target)).toBe(true);
    expect(isEmphasised(graph, "edge", id(101), target)).toBe(false);
    expect(isEmphasised(graph, "node", id(1), target)).toBe(true);
    expect(isEmphasised(graph, "node", id(3), target)).toBe(true);
    expect(isEmphasised(graph, "node", id(4), target)).toBe(false);
    expect(edgeDisplay(graph, id(102), target, palette).size).toBeCloseTo(
      egoSuggestionThickness * 1.6
    );
    expect(edgeDisplay(graph, id(101), target, palette).color).toMatch(
      new RegExp(`, ${egoBackgroundOpacity}\\)$`, "u")
    );
  });

  it("emphasises everything when nothing is targeted", () => {
    for (const key of graph.nodes()) expect(isEmphasised(graph, "node", key, null)).toBe(true);
    expect(nodeDisplay(graph, id(4), null, palette).zIndex).toBe(2);
  });
});
