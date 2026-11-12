import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { fallbackGraphPalette } from "../../../../components/graph/graph-tokens";
import { branchNotes, branchTopics, sampleBranch } from "./branch-fixtures";
import { buildBranchModel } from "./branch-model";
import {
  branchEdgeDisplay,
  branchNodeDisplay,
  branchZoom,
  buildBranchSigmaGraph,
  groupNodeKey,
  landscapeTurn,
  midpointOf,
  placeGroupNodes,
  relationOf,
  showsGroups,
  stanceGlyphPaths,
  superEdgeThickness,
  turnPositions
} from "./branch-sigma";

const palette = fallbackGraphPalette;
const model = buildBranchModel(sampleBranch(), {
  scope: { kind: "topic", id: branchTopics.fermentation },
  colourDepth: 1,
  t: createTranslator("en")
});

describe("the Grafo's Sigma graph", () => {
  it("colours each note by its topic group's token and each line by its stance, a suggestion dashed", () => {
    const graph = buildBranchSigmaGraph(model, palette);
    // Lática is colour index 1: --graph-topic-2.
    expect(graph.getNodeAttribute(branchNotes.acid.id, "color")).toBe(palette.topic[1]);
    expect(graph.getNodeAttribute(branchNotes.kombucha.id, "color")).toBe(palette.topic[0]);
    const supports = model.edges.find((edge) => edge.stance === "supports")!;
    expect(graph.getEdgeAttribute(supports.id, "color")).toBe(palette.stance.supports);
    expect(graph.getEdgeAttribute(supports.id, "type")).toBe("line");
    const suggested = model.edges.find((edge) => edge.suggested)!;
    expect(graph.getEdgeAttribute(suggested.id, "type")).toBe("dashed");
    // Every relation has a hit area that stands for it.
    expect(relationOf(graph, `hit:${suggested.id}`)).toBe(suggested.id);
    // Positions are deterministic and finite.
    const again = buildBranchSigmaGraph(model, palette);
    graph.forEachNode((key, attributes) => {
      expect(Number.isFinite(attributes.x) && Number.isFinite(attributes.y)).toBe(true);
      expect(again.getNodeAttribute(key, "x")).toBe(attributes.x);
    });
  });

  it("shows notes up close and one labelled pill per topic group zoomed out", () => {
    const graph = buildBranchSigmaGraph(model, palette);
    const group = groupNodeKey(branchTopics.lactic);
    expect(graph.getNodeAttribute(group, "label")).toBe("Fermentação lática");
    expect(branchNodeDisplay(graph, group, null, false, palette).hidden).toBe(true);
    expect(branchNodeDisplay(graph, group, null, true, palette).hidden).toBe(false);
    expect(branchNodeDisplay(graph, branchNotes.acid.id, null, true, palette).hidden).toBe(true);
    const superEdge = graph.edges().find((key) => graph.getEdgeAttribute(key, "kind") === "super")!;
    expect(branchEdgeDisplay(graph, superEdge, null, true, palette).hidden).toBe(false);
    expect(branchEdgeDisplay(graph, superEdge, null, false, palette).hidden).toBe(true);
    expect(showsGroups(model, branchZoom.superNodes)).toBe(true);
    expect(showsGroups(model, 1)).toBe(false);
    expect(showsGroups({ groups: model.groups.slice(0, 1) }, 10)).toBe(false);
  });

  it("puts a pill at the centre of its group's notes and thickens a line with its connections", () => {
    const graph = buildBranchSigmaGraph(model, palette);
    graph.setNodeAttribute(branchNotes.kombucha.id, "x", 10);
    graph.setNodeAttribute(branchNotes.yeast.id, "x", 30);
    graph.setNodeAttribute(branchNotes.kombucha.id, "y", 0);
    graph.setNodeAttribute(branchNotes.yeast.id, "y", 4);
    placeGroupNodes(graph);
    expect(graph.getNodeAttribute(groupNodeKey(branchTopics.alcoholic), "x")).toBe(20);
    expect(graph.getNodeAttribute(groupNodeKey(branchTopics.alcoholic), "y")).toBe(2);
    expect(superEdgeThickness(1, 1)).toBe(branchZoom.superEdgeMin);
    expect(superEdgeThickness(40, 40)).toBeCloseTo(branchZoom.superEdgeMax, 5);
    expect(superEdgeThickness(5, 40)).toBeGreaterThan(superEdgeThickness(2, 40));
  });

  it("fades what a chosen note does not touch and keeps its relations in their stance colour", () => {
    const graph = buildBranchSigmaGraph(model, palette);
    const target = { type: "node" as const, key: branchNotes.acid.id };
    const chosen = branchNodeDisplay(graph, branchNotes.acid.id, target, false, palette);
    expect(chosen.forceLabel).toBe(true);
    expect(chosen.emphasised).toBe(true);
    const far = branchNodeDisplay(graph, branchNotes.yeast.id, target, false, palette);
    expect(far.color).toMatch(/^rgba\(/u);
    const touching = model.edges.find(
      (edge) => edge.a === branchNotes.acid.id || edge.b === branchNotes.acid.id
    )!;
    expect(branchEdgeDisplay(graph, touching.id, target, false, palette).glyphColor).toBe(
      palette.stance[touching.stance]
    );
  });

  it("carries a stance glyph only where the line is long enough on screen, at its midpoint", () => {
    expect(midpointOf({ x: 0, y: 0, size: 4 }, { x: 100, y: 0, size: 4 })).toEqual({ x: 50, y: 0 });
    expect(midpointOf({ x: 0, y: 0, size: 4 }, { x: 30, y: 0, size: 4 })).toBeNull();
    for (const path of Object.values(stanceGlyphPaths)) expect(path).toMatch(/^M[0-9 .a-zA-Z-]+$/u);
  });

  it("turns an upright branch to run across a wide canvas, continuously while it settles", () => {
    const upright = [0, -100, 2, -50, -1, 0, 1, 50, 0, 100];
    const turn = landscapeTurn(upright, true, null);
    const turned = turnPositions(upright, turn);
    const xs = [0, 2, 4, 6, 8].map((index) => turned[index]!);
    const ys = [1, 3, 5, 7, 9].map((index) => turned[index]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(190);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(10);
    // A tall canvas keeps the branch upright.
    const tall = turnPositions(upright, landscapeTurn(upright, false, null));
    expect(Math.abs(tall[9]! - tall[1]!)).toBeGreaterThan(190);
    // The next frame never flips the drawing half a turn.
    expect(landscapeTurn(upright, true, turn + Math.PI * 0.4)).toBeCloseTo(turn, 9);
    expect(landscapeTurn(upright, true, turn + Math.PI * 0.6)).toBeCloseTo(turn + Math.PI, 9);
    expect(landscapeTurn([1, 1], true, 0.3)).toBe(0.3);
  });
});
