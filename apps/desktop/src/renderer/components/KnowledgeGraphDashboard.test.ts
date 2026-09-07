import { describe, expect, it } from "vitest";
import type { Translator } from "@app/i18n";
import type { KnowledgeGraphDashboard } from "../../shared/ipc";

import { atomicRelationColor, atomicRelationIconNode, atomicRelationMarkerRadius, buildGraph, prepareGraphEdges, reduceNode, reduceEdge, restoreKnowledgeGraphViewState } from "./KnowledgeGraphDashboard";
import {
  isLabelOutsideViewport,
  nodeLabelOpacity,
  positionOverlayWithinViewport,
  relationLabelRevealAt,
  relationHitAreaScreenThickness,
  zoomCompensatedEdgeSize,
  zoomVisualStrength
} from "./knowledge-graph-view-model";

describe("knowledge graph level of detail", () => {
  it("makes the background nearly transparent and monochrome, highlights relations in light red, and restores the original colors", () => {
    const data: KnowledgeGraphDashboard = {
      mode: "sources", truncated: false,
      nodes: ["a", "b", "c", "orphan"].map((id) => ({
        id, kind: "source", title: id, subtitle: null, content: null,
        sourceItemId: id, sourceType: "Book", noteStatus: null, detailCount: 0
      })),
      edges: [["a", "b"], ["b", "c"]].map(([source, target]) => ({
        id: `${source}-${target}`, source: source!, target: target!, kind: "shared_entity",
        label: "", description: null, weight: 1, confidence: 1, details: []
      }))
    };
    const { graph } = buildGraph(data, ((key: string) => key) as Translator);
    const edgeAB = graph.edges().find((edge) => edge.startsWith("item-edge:") && graph.extremities(edge).includes("item:a"))!;
    const edgeBC = graph.edges().find((edge) => edge.startsWith("item-edge:") && graph.extremities(edge).includes("item:c"))!;
    const alpha = (color: string) => Number.parseFloat(color.slice(color.lastIndexOf(",") + 1));
    const rgb = (color: string) => color.match(/^rgba\((\d+), (\d+), (\d+),/)?.slice(1).map(Number);
    for (const target of ["item:a", edgeAB]) {
      const backgroundOpacity = target === "item:a" ? 0.1 : 0.04;
      const neighbors = new Set(target === "item:a" ? graph.neighbors(target) : graph.extremities(target));
      const unrelated = graph.getNodeAttributes("item:c");
      const start = reduceNode("item:c", unrelated, 0.16, target, neighbors, 0, backgroundOpacity);
      const middle = reduceNode("item:c", unrelated, 0.16, target, neighbors, 0.5, backgroundOpacity);
      const end = reduceNode("item:c", unrelated, 0.16, target, neighbors, 1, backgroundOpacity);
      expect(alpha(start.color)).toBe(1);
      expect(alpha(middle.color)).toBeGreaterThan(alpha(end.color));
      expect(alpha(end.color)).toBeCloseTo(backgroundOpacity);
      expect(rgb(end.color)).toEqual([148, 148, 148]);
      expect(end.labelOpacity).toBeLessThan(0.04);
      expect(reduceNode("item:b", graph.getNodeAttributes("item:b"), 0.16, target, neighbors, 1).color).toBe(graph.getNodeAttribute("item:b", "color"));
      const selectedEdge = reduceEdge(graph, edgeAB, graph.getEdgeAttributes(edgeAB), 0.16, target, 1);
      const otherEdge = reduceEdge(graph, edgeBC, graph.getEdgeAttributes(edgeBC), 0.16, target, 1);
      expect(alpha(selectedEdge.color)).toBe(1);
      expect(rgb(selectedEdge.color)).toEqual([252, 165, 165]);
      expect(rgb(otherEdge.color)).toEqual([148, 148, 148]);
      if (target === "item:a") {
        expect(alpha(otherEdge.color)).toBeCloseTo(0.1);
        for (const ratio of [2, 0.08]) {
          expect(alpha(reduceEdge(graph, edgeBC, graph.getEdgeAttributes(edgeBC), ratio, target, 1).color)).toBeCloseTo(0.1);
        }
      } else expect(alpha(otherEdge.color)).toBeLessThan(0.02);
      expect(rgb(reduceEdge(graph, edgeAB, graph.getEdgeAttributes(edgeAB), 0.16, null, 0).color)).toEqual([56, 189, 248]);
      // The reverse fade converges to exactly the resting palette before clearing hover state.
      expect(reduceEdge(graph, edgeAB, graph.getEdgeAttributes(edgeAB), 0.16, target, 0).color).toBe(reduceEdge(graph, edgeAB, graph.getEdgeAttributes(edgeAB), 0.16, null, 0).color);
      expect(reduceNode("item:c", unrelated, 0.16, null, new Set(), 0).color).toBe(unrelated.color);
    }
  });
  it("keeps items, orphans and connections visible across the former LOD boundaries", () => {
    const data: KnowledgeGraphDashboard = {
      mode: "sources", truncated: false,
      nodes: ["a", "b", "orphan"].map((id) => ({
        id, kind: "source", title: id, subtitle: null, content: null,
        sourceItemId: id, sourceType: "Book", noteStatus: null, detailCount: 0
      })),
      edges: [{ id: "ab", source: "a", target: "b", kind: "shared_entity", label: "", description: null, weight: 1, confidence: 1, details: [] }]
    };
    const { graph } = buildGraph(data, ((key: string) => key) as Translator);
    expect(graph.nodes()).toEqual(["item:a", "item:b", "item:orphan"]);
    for (const ratio of [8, 1.251, 1.25, 1.249, 0.521, 0.52, 0.519, 0.08]) {
      graph.forEachNode((key, attributes) => {
        expect(reduceNode(key, attributes, ratio, null, new Set()).hidden).toBe(false);
      });
      graph.forEachEdge((key, attributes) => {
        expect(reduceEdge(graph, key, attributes, ratio, null, 0).hidden).toBe(false);
      });
    }
    for (const boundary of [1.25, 0.52]) {
      expect(Math.abs(nodeLabelOpacity(boundary - 0.001, 5) - nodeLabelOpacity(boundary + 0.001, 5))).toBeLessThan(0.01);
    }
    const positions = { "item:a": { x: 12.34, y: 56.78 }, "item:b": { x: 90, y: -10 }, "item:orphan": { x: -88, y: 99 } };
    const saved = { stateKey: "snapshot", camera: { x: 0.3, y: 0.7, ratio: 0.42, angle: 0 }, nodePositions: positions };
    expect(restoreKnowledgeGraphViewState(graph, "changed", saved)).toBe(false);
    expect(restoreKnowledgeGraphViewState(graph, "snapshot", saved)).toBe(true);
    for (const [node, position] of Object.entries(positions)) expect(graph.getNodeAttributes(node)).toMatchObject(position);
  });

  it("increases visual strength continuously while zooming closer", () => {
    expect(zoomVisualStrength(1.25)).toBe(0);
    expect(zoomVisualStrength(0.8)).toBeGreaterThan(0);
    expect(zoomVisualStrength(0.4)).toBeGreaterThan(zoomVisualStrength(0.8));
    expect(zoomVisualStrength(0.16)).toBe(1);
  });

  it("detects when a centered edge label would cross the viewport boundary", () => {
    expect(isLabelOutsideViewport(50, 100, 800, 600, 90, 28)).toBe(true);
    expect(isLabelOutsideViewport(400, 300, 800, 600, 90, 28)).toBe(false);
    expect(isLabelOutsideViewport(750, 590, 800, 600, 90, 28)).toBe(true);
  });

  it("reveals each eligible relation label at a stable zoom threshold", () => {
    const threshold = relationLabelRevealAt("relation-1", 0.8, 100);
    expect(threshold).toBe(relationLabelRevealAt("relation-1", 0.8, 100));
    expect(threshold).toBeGreaterThanOrEqual(0.22);
    expect(threshold).toBeLessThanOrEqual(0.9);
  });

  it("reveals labels continuously and monotonically, including orphan labels", () => {
    for (const degree of [0, 1, 8, 100]) {
      let previous = 0;
      for (let ratio = 2; ratio >= 0.08; ratio -= 0.01) {
        const opacity = nodeLabelOpacity(ratio, degree);
        expect(opacity).toBeGreaterThanOrEqual(previous);
        previous = opacity;
      }
      expect(nodeLabelOpacity(0.08, degree)).toBe(1);
    }
  });

  it("compensates Sigma camera scaling to keep edge thickness stable on screen", () => {
    const farSize = zoomCompensatedEdgeSize(4);
    const nearSize = zoomCompensatedEdgeSize(0.25);
    expect(farSize / Math.sqrt(4)).toBeCloseTo(1.8);
    expect(nearSize / Math.sqrt(0.25)).toBeCloseTo(1.8);
  });

  it("keeps a wider invisible relation hit area stable across zoom levels", () => {
    const farHitArea = zoomCompensatedEdgeSize(4, relationHitAreaScreenThickness);
    const nearHitArea = zoomCompensatedEdgeSize(0.25, relationHitAreaScreenThickness);
    expect(farHitArea / Math.sqrt(4)).toBe(10);
    expect(nearHitArea / Math.sqrt(0.25)).toBe(10);
  });

  it("keeps information overlays inside every viewport edge", () => {
    expect(positionOverlayWithinViewport(
      { x: 780, y: 580 },
      { width: 300, height: 200 },
      { width: 800, height: 600 }
    )).toEqual({ x: 466, y: 366 });
    expect(positionOverlayWithinViewport(
      { x: 4, y: 4 },
      { width: 300, height: 200 },
      { width: 800, height: 600 }
    )).toEqual({ x: 18, y: 18 });
  });

  it("collapses every source pair into one unlabeled connection with grouped details", () => {
    const data = {
      mode: "sources",
      nodes: [],
      edges: [
        {
          id: "shared",
          source: "00000000-0000-4000-8000-000000000001",
          target: "00000000-0000-4000-8000-000000000002",
          kind: "shared_entity",
          label: "shared_entity",
          description: null,
          weight: 3,
          confidence: 0.8,
          details: ["Entity A"]
        },
        {
          id: "semantic",
          source: "00000000-0000-4000-8000-000000000002",
          target: "00000000-0000-4000-8000-000000000001",
          kind: "semantic_relation",
          label: "semantic_relation",
          description: null,
          weight: 2,
          confidence: 0.9,
          details: ["A · supports · B"]
        }
      ],
      truncated: false
    } satisfies KnowledgeGraphDashboard;

    const edges = prepareGraphEdges(data, ((key: string) => key) as Translator);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: "source_connection", label: "", weight: 5 });
    expect(edges[0]?.sourceRelations.map((relation) => relation.kind)).toEqual([
      "shared_entity",
      "semantic_relation"
    ]);
  });

  it("localizes canonical atomic-note relation codes for display", () => {
    const data = {
      mode: "atomic_notes",
      nodes: [],
      edges: [{
        id: "relation",
        source: "00000000-0000-4000-8000-000000000001",
        target: "00000000-0000-4000-8000-000000000002",
        kind: "atomic_note_relation",
        label: "supports",
        description: null,
        weight: 1,
        confidence: 0.9,
        details: []
      }],
      truncated: false
    } satisfies KnowledgeGraphDashboard;
    const translator = ((key: string) => key === "knowledge.relations.types.supports"
      ? "Sustenta"
      : key) as Translator;

    expect(prepareGraphEdges(data, translator)[0]).toMatchObject({
      label: "Sustenta",
      relationType: "supports"
    });
  });

  it("assigns a distinct icon color to every canonical atomic-note relation", () => {
    const types = ["supports", "contrasts", "extends", "similar_to", "depends_on", "clarifies", "mentions", "related"];
    const colors = types.map(atomicRelationColor);
    expect(new Set(colors)).toHaveLength(types.length);
    expect(new Set(types.map((type) => JSON.stringify(atomicRelationIconNode(type))))).toHaveLength(types.length);
    expect(types.every((type) => atomicRelationIconNode(type).length > 0)).toBe(true);
    expect(atomicRelationColor("unknown")).toBe("#cbd5e1");
    expect(atomicRelationIconNode("unknown").length).toBeGreaterThan(0);
  });

  it("gives relation icons ten percent more room inside their marker", () => {
    expect(atomicRelationMarkerRadius).toBeCloseTo(8 * 1.1);
  });
});
