import { describe, expect, it } from "vitest";
import type { Translator } from "@app/i18n";
import type { KnowledgeGraphDashboard } from "../../shared/ipc";

import { prepareGraphEdges } from "./KnowledgeGraphDashboard";
import {
  isLabelOutsideViewport,
  isNodeVisibleAtLod,
  linkedNodeSpringForce,
  lodFromRatio,
  positionOverlayWithinViewport,
  relationLabelRevealAt,
  relationHitAreaScreenThickness,
  zoomCompensatedEdgeSize,
  zoomVisualStrength
} from "./knowledge-graph-view-model";

describe("knowledge graph level of detail", () => {
  it("moves from communities through hubs to full detail as the camera zooms in", () => {
    expect(lodFromRatio(2)).toBe("overview");
    expect(lodFromRatio(0.8)).toBe("hubs");
    expect(lodFromRatio(0.3)).toBe("detail");
  });

  it("never mixes community aggregates with source or note nodes", () => {
    expect(isNodeVisibleAtLod("overview", true, 10, 2)).toBe(true);
    expect(isNodeVisibleAtLod("overview", false, 10, 2)).toBe(false);
    expect(isNodeVisibleAtLod("hubs", true, 10, 2)).toBe(false);
    expect(isNodeVisibleAtLod("hubs", false, 10, 2)).toBe(true);
    expect(isNodeVisibleAtLod("detail", true, 10, 2)).toBe(false);
    expect(isNodeVisibleAtLod("detail", false, 0, 2)).toBe(true);
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

  it("pulls and pushes connected nodes like a link spring", () => {
    expect(linkedNodeSpringForce({ x: 0, y: 0 }, { x: 10, y: 0 }, 4).x).toBeGreaterThan(0);
    expect(linkedNodeSpringForce({ x: 8, y: 0 }, { x: 10, y: 0 }, 4).x).toBeLessThan(0);
    expect(linkedNodeSpringForce({ x: 6, y: 0 }, { x: 10, y: 0 }, 4)).toEqual({ x: 0, y: 0 });
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

    expect(prepareGraphEdges(data, translator)[0]?.label).toBe("Sustenta");
  });
});
