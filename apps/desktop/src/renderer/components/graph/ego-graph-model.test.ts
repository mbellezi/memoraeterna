import { describe, expect, it } from "vitest";
import {
  ObjectNeighborhoodSchema,
  type ObjectNeighborhood,
  type ObjectNeighborhoodEdge
} from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import {
  buildEgoGraphModel,
  edgeStateKey,
  egoCursorItems,
  egoEdgeDescription,
  egoGraphLabel,
  egoGraphLimits,
  egoNodeDescription,
  moveEgoCursor
} from "./ego-graph-model";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, depth: 0 | 1 | 2 = 1) => ({
  id: id(n),
  kind: "note" as const,
  title: `Note ${n}`,
  ideaStatement: `Idea ${n}.`,
  language: null,
  depth
});
const edge = (
  n: number,
  lo: number,
  hi: number,
  overrides: Partial<ObjectNeighborhoodEdge> = {}
): ObjectNeighborhoodEdge => ({
  id: id(100 + n),
  lo: id(lo),
  hi: id(hi),
  direction: "lo_to_hi",
  type: "supports",
  state: "kept",
  band: null,
  ...overrides
});
const answer = (
  nodes: ReturnType<typeof node>[],
  edges: ObjectNeighborhoodEdge[],
  overrides: Partial<ObjectNeighborhood> = {}
): ObjectNeighborhood => ({
  focus: id(1),
  depth: 1,
  nodes,
  edges,
  neighbourTotal: nodes.length - 1,
  truncated: false,
  ...overrides
});

describe("the relation graph model", () => {
  it("draws an arrow only for a directed type whose direction is known", () => {
    const model = buildEgoGraphModel(
      answer(
        [node(1, 0), node(2), node(3), node(4), node(5), node(6)],
        [
          // Directed type, direction known: an arrow, from the decided subject to its object.
          edge(1, 1, 2, { direction: "lo_to_hi", type: "supports" }),
          edge(2, 1, 3, { direction: "hi_to_lo", type: "extends" }),
          // Directed type, direction unknown (a legacy row): both ways, no invented direction.
          edge(3, 1, 4, { direction: "unknown", type: "depends_on" }),
          // Symmetric types read both ways whatever the stored direction says.
          edge(4, 1, 5, { direction: "symmetric", type: "contradicts" }),
          edge(5, 1, 6, { direction: "symmetric", type: "same_as" })
        ]
      )
    );
    const byId = new Map(model.edges.map((entry) => [entry.id, entry]));
    expect(byId.get(id(101))).toMatchObject({
      directed: true,
      source: id(1),
      target: id(2),
      program: "arrow"
    });
    expect(byId.get(id(102))).toMatchObject({
      directed: true,
      source: id(3),
      target: id(1),
      program: "arrow"
    });
    for (const n of [103, 104, 105])
      expect(byId.get(id(n)), String(n)).toMatchObject({ directed: false, program: "line" });
    expect(model.hasArrows).toBe(true);
  });

  it("treats a symmetric type with a stored direction, and an unknown type, as undirected", () => {
    const model = buildEgoGraphModel(
      answer(
        [node(1, 0), node(2), node(3)],
        [
          edge(1, 1, 2, { direction: "lo_to_hi", type: "similar_to" }),
          edge(2, 1, 3, { direction: "hi_to_lo", type: "a_type_a_later_phase_adds" })
        ]
      )
    );
    expect(model.edges.map((entry) => entry.directed)).toEqual([false, false]);
    // An unknown type reads as related: its stance is the neutral one, never the raw value.
    expect(model.edges[1]!.stance).toBe("related");
    expect(model.hasArrows).toBe(false);
  });

  it("draws a suggestion dashed, apart from a kept or applied relation, with an arrow when directed", () => {
    const model = buildEgoGraphModel(
      answer(
        [node(1, 0), node(2), node(3), node(4), node(5)],
        [
          edge(1, 1, 2, { state: "suggested", band: "suggest", type: "supports" }),
          edge(2, 1, 3, {
            state: "suggested",
            band: "suggest",
            type: "contradicts",
            direction: "symmetric"
          }),
          edge(3, 1, 4, { state: "kept" }),
          edge(4, 1, 5, { state: "applied", type: "contradicts", direction: "symmetric" })
        ]
      )
    );
    expect(model.edges.map((entry) => [entry.state, entry.program, entry.suggested])).toEqual([
      ["suggested", "dashed-arrow", true],
      ["suggested", "dashed", true],
      ["kept", "arrow", false],
      ["applied", "line", false]
    ]);
    expect(model.hasSuggestions).toBe(true);
    expect(model.hasKept).toBe(true);
    const onlySuggestions = buildEgoGraphModel(
      answer([node(1, 0), node(2)], [edge(1, 1, 2, { state: "suggested", band: "suggest" })])
    );
    expect(onlySuggestions).toMatchObject({ hasSuggestions: true, hasKept: false });
  });

  it("lists the stances drawn in legend order with one type each", () => {
    const model = buildEgoGraphModel(
      answer(
        [node(1, 0), node(2), node(3), node(4)],
        [
          edge(1, 1, 2, { type: "extends" }),
          edge(2, 1, 3, { type: "supports" }),
          edge(3, 1, 4, { type: "clarifies" })
        ]
      )
    );
    expect(model.stances).toEqual(["supports", "extends", "related"]);
    expect(model.stanceTypes).toEqual({
      extends: "extends",
      supports: "supports",
      related: "clarifies"
    });
  });

  it("keeps the focus first, places the rings deterministically and sizes the focus apart", () => {
    const nodes = [node(1, 0), node(2), node(3), node(4, 2)];
    const edges = [edge(1, 1, 2), edge(2, 2, 3), edge(3, 3, 4)];
    const first = buildEgoGraphModel(answer(nodes, edges));
    const second = buildEgoGraphModel(answer(nodes, edges));
    expect(second).toEqual(first);
    expect(first.nodes[0]).toMatchObject({ id: id(1), focus: true, x: 0, y: 0, depth: 0 });
    expect(first.nodes.find((entry) => entry.focus)!.size).toBeGreaterThan(
      Math.max(...first.nodes.filter((entry) => !entry.focus).map((entry) => entry.size))
    );
    for (const entry of first.nodes) {
      expect(Number.isFinite(entry.x) && Number.isFinite(entry.y)).toBe(true);
      if (entry.depth > 0) expect(Math.hypot(entry.x, entry.y)).toBeGreaterThan(0);
    }
    // The second ring sits outside the first.
    const ring = (depth: number) =>
      first.nodes
        .filter((entry) => entry.depth === depth)
        .map((entry) => Math.hypot(entry.x, entry.y));
    expect(Math.min(...ring(2))).toBeGreaterThan(Math.max(...ring(1)));
  });

  it("is bounded: at most 40 notes, the edges' bound, the focus's own relations first", () => {
    const nodes = [node(1, 0), ...Array.from({ length: 60 }, (_, n) => node(n + 2))];
    const among: ObjectNeighborhoodEdge[] = [];
    let n = 1;
    for (let a = 2; a <= 40; a += 1)
      for (let b = a + 1; b <= 40; b += 1) among.push(edge(n++, a, b));
    const own = [edge(2000, 1, 2), edge(2001, 1, 3)];
    const model = buildEgoGraphModel(answer(nodes, [...among, ...own]));
    expect(model.nodes).toHaveLength(egoGraphLimits.nodes);
    expect(model.edges.length).toBeLessThanOrEqual(egoGraphLimits.edges);
    expect(model.edges.slice(0, 2).map((entry) => entry.id)).toEqual([id(2100), id(2101)]);
    // Every drawn edge joins two drawn notes, and an edge is drawn once.
    const drawn = new Set(model.nodes.map((entry) => entry.id));
    for (const entry of model.edges) {
      expect(drawn.has(entry.source) && drawn.has(entry.target)).toBe(true);
    }
    expect(new Set(model.edges.map((entry) => entry.id)).size).toBe(model.edges.length);
    expect(model.omittedEdges).toBeGreaterThan(0);
  });

  it("ignores an edge to a note that is not in the answer, a self loop and a repeated edge", () => {
    const model = buildEgoGraphModel(
      answer([node(1, 0), node(2)], [edge(1, 1, 2), edge(1, 1, 2), edge(2, 1, 99), edge(3, 2, 2)])
    );
    expect(model.edges.map((entry) => entry.id)).toEqual([id(101)]);
  });

  it("builds from a real answer of the contract and keeps its counts", () => {
    const parsed = ObjectNeighborhoodSchema.parse(
      answer([node(1, 0), node(2)], [edge(1, 1, 2)], { neighbourTotal: 7, truncated: true })
    );
    expect(buildEgoGraphModel(parsed)).toMatchObject({
      neighbourTotal: 7,
      drawnNeighbours: 1,
      truncated: true,
      focus: id(1)
    });
  });

  it("cuts a title for the canvas by characters, never inside a pair, and keeps a short one", () => {
    expect(egoGraphLabel("  Spaced   repetition ")).toBe("Spaced repetition");
    const long = "a very long title that does not fit on a small canvas at all";
    const cut = egoGraphLabel(long);
    expect(Array.from(cut)).toHaveLength(egoGraphLimits.labelCharacters);
    expect(cut.endsWith("…")).toBe(true);
    expect(Array.from(egoGraphLabel("😀".repeat(40), 5))).toHaveLength(5);
    expect(egoGraphLabel("😀".repeat(40), 5)).toBe("😀😀😀😀…");
  });
});

describe("the keyboard cursor", () => {
  const model = buildEgoGraphModel(
    answer([node(1, 0), node(2), node(3)], [edge(1, 1, 2), edge(2, 1, 3)])
  );

  it("walks the notes then the relations, wrapping at both ends", () => {
    const items = egoCursorItems(model);
    expect(items.map((item) => item.type)).toEqual(["node", "node", "node", "edge", "edge"]);
    expect(moveEgoCursor(items.length, null, "ArrowRight")).toBe(0);
    expect(moveEgoCursor(items.length, null, "ArrowLeft")).toBe(4);
    expect(moveEgoCursor(items.length, 4, "ArrowDown")).toBe(0);
    expect(moveEgoCursor(items.length, 0, "ArrowUp")).toBe(4);
    expect(moveEgoCursor(items.length, 2, "Home")).toBe(0);
    expect(moveEgoCursor(items.length, 2, "End")).toBe(4);
    expect(moveEgoCursor(items.length, 2, "a")).toBeNull();
    expect(moveEgoCursor(0, null, "ArrowRight")).toBeNull();
  });
});

describe("what the card and a screen reader say", () => {
  const model = buildEgoGraphModel(
    answer(
      [node(1, 0), node(2), node(3)],
      [
        edge(1, 1, 2, {
          state: "suggested",
          band: "suggest",
          type: "supports",
          direction: "hi_to_lo"
        }),
        edge(2, 1, 3, { type: "depends_on", direction: "unknown" }),
        edge(3, 2, 3, { type: "contradicts", direction: "symmetric", state: "applied" })
      ]
    )
  );
  const titles = new Map(model.nodes.map((entry) => [entry.id, entry.title]));
  const titleOf = (nodeId: string) => titles.get(nodeId) ?? "";

  it("says the direction only when one is known, and the state in words, in every interface language", () => {
    const en = createTranslator("en");
    expect(egoEdgeDescription(model.edges[0]!, titleOf, en)).toBe(
      "Note 2 supports Note 1. Suggestion: nobody has kept this relation yet."
    );
    expect(egoEdgeDescription(model.edges[1]!, titleOf, en)).toBe(
      "Note 1 and Note 3 are linked: depends on. You kept this relation."
    );
    expect(egoEdgeDescription(model.edges[2]!, titleOf, en)).toBe(
      "Note 2 contradicts Note 3. This relation is applied."
    );
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const entry of model.edges) {
        const text = egoEdgeDescription(entry, titleOf, t);
        expect(text, `${locale} ${entry.id}`).not.toMatch(/[{}]|notePage\./u);
        expect(text).toContain("Note");
      }
      expect(egoNodeDescription(model.nodes[0]!, t)).toContain("Note 1");
      expect(egoNodeDescription(model.nodes[1]!, t)).toContain("Note 2");
      expect(egoNodeDescription(model.nodes[0]!, t)).not.toBe(
        egoNodeDescription(model.nodes[1]!, t)
      );
    }
    expect(edgeStateKey("suggested")).toBe("notePage.graph.stateSuggested");
    expect(edgeStateKey("kept")).toBe("notePage.graph.stateKept");
    expect(edgeStateKey("applied")).toBe("notePage.graph.stateApplied");
  });
});
