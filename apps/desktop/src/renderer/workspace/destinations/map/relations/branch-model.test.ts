import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { branchId, branchNotes, branchTopics, sampleBranch } from "./branch-fixtures";
import {
  branchCursorItems,
  branchEdgeDescription,
  branchNodeDescription,
  buildBranchModel,
  colourGroups,
  connectionCounts,
  groupDescription,
  hasConnections,
  keptCursor,
  topicLabel
} from "./branch-model";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const scope = { kind: "topic", id: branchTopics.fermentation } as const;
const model = (answer = sampleBranch(), t = en) =>
  buildBranchModel(answer, { scope, colourDepth: 1, t });

describe("the branch model", () => {
  it("colours each note by its topic group: the ancestor at the colour depth, or the topic itself", () => {
    const built = model();
    const byId = new Map(built.nodes.map((node) => [node.id, node]));
    // Kefir sits under lática, so its note takes lática's colour.
    expect(byId.get(branchNotes.kefir.id)?.groupId).toBe(branchTopics.lactic);
    expect(byId.get(branchNotes.kefir.id)?.colourIndex).toBe(1);
    expect(byId.get(branchNotes.kombucha.id)?.groupId).toBe(branchTopics.alcoholic);
    // The scope's own notes are a group of their own.
    expect(byId.get(branchNotes.hours.id)?.groupId).toBe(branchTopics.fermentation);
    // Deeper colours: kefir is its own group at depth 2.
    const deeper = buildBranchModel(sampleBranch(), { scope, colourDepth: 2, t: en });
    expect(deeper.nodes.find((node) => node.id === branchNotes.kefir.id)?.groupId).toBe(
      branchTopics.kefir
    );
  });

  it("follows the read model's depths: a scope topic starts at 0, a source's top topics at 1", () => {
    const topics = [
      { id: "a", parentId: "root" },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" }
    ];
    expect([...colourGroups(topics, 1, 0)]).toEqual([
      ["a", "a"],
      ["b", "b"],
      ["c", "b"]
    ]);
    expect([...colourGroups(topics, 1, 1)]).toEqual([
      ["a", "a"],
      ["b", "a"],
      ["c", "a"]
    ]);
  });

  it("names every drawn group in the legend, by colour index, the scope's own notes as such", () => {
    const built = model(sampleBranch(), pt);
    expect(
      built.groups.map((group) => [group.legendLabel, group.colourIndex, group.notes])
    ).toEqual([
      ["Fermentação alcoólica", 0, 2],
      ["Fermentação lática", 1, 4],
      ["Fermentação (notas diretas)", 2, 2]
    ]);
    expect(built.scopeTitle).toBe("Fermentação");
    expect(built.children.map((child) => child.title)).toEqual([
      "Fermentação alcoólica",
      "Fermentação lática"
    ]);
    expect(built.parentId).toBe(branchId("topic:nutrition"));
  });

  it("draws a suggestion dashed, lists the stances drawn in legend order and the super-edges among drawn groups", () => {
    const built = model();
    expect(built.edges.filter((edge) => edge.suggested)).toHaveLength(2);
    expect(built.hasSuggestions).toBe(true);
    expect(built.stances).toEqual(["supports", "contradicts", "extends", "depends_on", "related"]);
    // A stored contrast keeps its own word in the legend, under the contradicts stance.
    expect(built.stanceTypes.contradicts).toBe("contrasts");
    expect(built.superEdges).toHaveLength(2);
    expect(hasConnections(built)).toBe(true);
  });

  it("drops what the answer should not hold: a repeated note, a relation to a note not drawn, a loop", () => {
    const answer = sampleBranch();
    const acid = branchNotes.acid;
    const built = model({
      ...answer,
      nodes: [...answer.nodes, acid],
      edges: [
        ...answer.edges,
        {
          id: branchId("edge:loop"),
          a: acid.id,
          b: acid.id,
          type: "related",
          stance: "related",
          band: null
        },
        {
          id: branchId("edge:outside"),
          a: acid.id,
          b: branchId("note:not-drawn"),
          type: "supports",
          stance: "supports",
          band: "apply"
        }
      ],
      superEdges: [
        ...answer.superEdges,
        { a: branchTopics.lactic, b: branchTopics.history, weight: 9 }
      ]
    });
    expect(built.nodes).toHaveLength(8);
    expect(built.edges).toHaveLength(7);
    expect(built.superEdges).toHaveLength(2);
  });

  it("says a note, a relation and a group in words, never by colour", () => {
    const built = model(sampleBranch(), pt);
    const counts = connectionCounts(built);
    const acid = built.nodes.find((node) => node.id === branchNotes.acid.id)!;
    expect(branchNodeDescription(built, acid, counts.get(acid.id)!, pt)).toBe(
      "O ácido lático inibe patógenos. Tópico: Fermentação lática. Conexões: 4."
    );
    const titleOf = (id: string) => built.nodes.find((node) => node.id === id)?.title ?? "";
    const supports = built.edges.find((edge) => edge.type === "supports")!;
    const sentence = branchEdgeDescription(supports, titleOf, pt);
    expect(sentence).toContain("apoia");
    expect(sentence).toContain("“A fermentação começa em horas”");
    const suggested = built.edges.find((edge) => edge.suggested)!;
    expect(branchEdgeDescription(suggested, titleOf, pt)).toContain("Sugerida");
    const lactic = built.groups.find((group) => group.id === branchTopics.lactic)!;
    expect(groupDescription(lactic, built, pt)).toBe(
      "Fermentação lática. Notas no grafo: 4. Conexões com outros tópicos: 3."
    );
  });

  it("walks the most connected notes first, then the relations", () => {
    const items = branchCursorItems(model());
    expect(items[0]).toEqual({ type: "node", id: branchNotes.acid.id });
    expect(items.filter((item) => item.type === "edge")).toHaveLength(7);
  });

  it("names an unnamed topic and a source scope in the interface's words", () => {
    expect(topicLabel(pt, "  ")).toBe("Tópico sem nome");
    const answer = sampleBranch({
      nodes: [{ ...branchNotes.acid, topicId: null }, branchNotes.kombucha],
      edges: []
    });
    const source = buildBranchModel(answer, {
      scope: { kind: "source", id: branchId("source") },
      colourDepth: 1,
      sourceTitle: null,
      t: pt
    });
    expect(source.scopeTitle).toBe("esta fonte");
    expect(source.unplaced).toBe(1);
    expect(source.children).toEqual([]);
    expect(hasConnections(source)).toBe(false);
  });
});

describe("the keyboard cursor across a re-read", () => {
  it("stays on the note or relation it stood on, wherever it now sits, and leaves a gone one", () => {
    const before = branchCursorItems(model());
    const answer = sampleBranch();
    const edge = before.find((item) => item.type === "edge")!;
    const after = branchCursorItems(
      model({ ...answer, edges: answer.edges.filter((other) => other.id !== edge.id) })
    );
    const note = before[0]!;
    expect(after[keptCursor(after, note)!]).toEqual(note);
    expect(keptCursor(after, edge)).toBeNull();
    expect(keptCursor(after, null)).toBeNull();
  });
});
