import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PgPool } from "../client.js";
import { createKnowledgeGraphDashboardRepository } from "./knowledgeGraphDashboardRepository.js";
import { noteRelationStateSql, shownNoteRelationSql } from "./note-relation-sql.js";

class FakeGraphPool {
  readonly queries: string[] = [];
  constructor(private readonly responses: QueryResultRow[][]) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    const rows = (this.responses.shift() ?? []) as T[];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
  }
}

describe("knowledge graph dashboard repository", () => {
  it("builds the source projection from shared entities and semantic relations", async () => {
    const pool = new FakeGraphPool([
      [
        {
          id: "source-1",
          type: "Book",
          title: "One",
          subtitle: null,
          entityCount: 3,
          parentSourceItemId: null,
          childCount: 2
        }
      ],
      [{ source: "source-1", target: "source-2", weight: 2, confidence: 0.8, details: ["Ada"] }],
      [
        {
          source: "source-1",
          target: "source-3",
          weight: 1,
          confidence: 0.7,
          details: ["Ada · wrote · Notes"]
        }
      ]
    ]);

    const result = await createKnowledgeGraphDashboardRepository(pool as unknown as PgPool).get(
      "sources"
    );

    expect(result.nodes[0]).toMatchObject({
      kind: "source",
      sourceItemId: "source-1",
      content: null,
      detailCount: 3,
      parentSourceItemId: null,
      childCount: 2
    });
    expect(result.edges.map((edge) => edge.kind)).toEqual(["shared_entity", "semantic_relation"]);
    expect(pool.queries).toHaveLength(3);
    expect(pool.queries[1]).toContain("entity_mentions");
    expect(pool.queries[2]).toContain("entity_relations");
    expect(pool.queries[0]).toContain("child.parent_source_item_id = source.id");
  });

  it("builds the atomic-note projection from current visible notes and non-rejected relations", async () => {
    const pool = new FakeGraphPool([
      [
        {
          id: "note-1",
          title: "One idea",
          ideaStatement: "A compact idea",
          content: "The full atomic note.",
          status: "approved",
          sourceItemId: "source-1",
          sourceTitle: "Source",
          entityCount: 4
        }
      ],
      [
        {
          id: "relation-1",
          source: "note-1",
          target: "note-2",
          relationType: "supports",
          explanation: "Evidence overlaps",
          finalScore: 0.92
        }
      ]
    ]);

    const result = await createKnowledgeGraphDashboardRepository(pool as unknown as PgPool).get(
      "atomic_notes"
    );

    expect(result.nodes[0]).toMatchObject({
      kind: "atomic_note",
      noteStatus: "approved",
      content: "The full atomic note.",
      detailCount: 4,
      parentSourceItemId: null,
      childCount: 0
    });
    expect(result.edges[0]).toMatchObject({
      kind: "atomic_note_relation",
      label: "supports",
      confidence: 0.92
    });
    expect(pool.queries[0]).toContain("supersession_status = 'current'");
    // Shown relations are drawn (D9, decision 29), directed ones from their subject (the stored
    // direction); the predicates, never another filter, choose them and mark the suggestions.
    expect(pool.queries[1]).toContain(shownNoteRelationSql("relation"));
    expect(pool.queries[1]).toContain(`${noteRelationStateSql.suggested("relation")} as suggested`);
    expect(pool.queries[1]).toContain("case when relation.direction = 'hi_to_lo'");
  });

  it("shows no percentage for a relations v2 note relation, and keeps a legacy one's (F3 D42, R4)", async () => {
    const note = (id: string) => ({
      id,
      title: id,
      ideaStatement: id,
      content: id,
      status: "approved",
      sourceItemId: "source-1",
      sourceTitle: "Source",
      entityCount: 0
    });
    const relation = (id: string, band: string | null) => ({
      id,
      source: "note-1",
      target: "note-2",
      relationType: "supports",
      explanation: "Evidence overlaps",
      finalScore: 0.88,
      band
    });
    const pool = new FakeGraphPool([
      [note("note-1"), note("note-2")],
      [relation("legacy", null), relation("strong", "apply"), relation("possible", "suggest")]
    ]);
    const result = await createKnowledgeGraphDashboardRepository(pool as unknown as PgPool).get(
      "atomic_notes"
    );
    expect(result.edges.map((edge) => [edge.id, edge.confidence])).toEqual([
      ["legacy", 0.88],
      ["strong", null],
      ["possible", null]
    ]);
    // The band is only read as a value: the visibility predicates choose the rows.
    expect(pool.queries[1]).toContain("relation.band as band");
  });

  it("marks a suggested note relation and not a kept or applied one (decision 29)", async () => {
    const note = (id: string) => ({
      id,
      title: id,
      ideaStatement: id,
      content: id,
      status: "approved",
      sourceItemId: "source-1",
      sourceTitle: "Source",
      entityCount: 0
    });
    const relation = (id: string, band: string | null, suggested: boolean) => ({
      id,
      source: "note-1",
      target: "note-2",
      relationType: "supports",
      explanation: "Evidence overlaps",
      finalScore: 0.88,
      band,
      suggested
    });
    const pool = new FakeGraphPool([
      [note("note-1"), note("note-2")],
      [
        relation("kept", "suggest", false),
        relation("possible", "suggest", true),
        relation("legacy", null, false)
      ]
    ]);
    const result = await createKnowledgeGraphDashboardRepository(pool as unknown as PgPool).get(
      "atomic_notes"
    );
    expect(result.edges.map((edge) => [edge.id, edge.suggested])).toEqual([
      ["kept", false],
      ["possible", true],
      ["legacy", false]
    ]);
  });

  it("gives a source relation promoted from note links no confidence to show", async () => {
    const pool = new FakeGraphPool([
      [
        {
          id: "source-1",
          type: "Book",
          title: "One",
          subtitle: null,
          entityCount: 0,
          parentSourceItemId: null,
          childCount: 0
        }
      ],
      [
        {
          id: "judged",
          source: "source-1",
          target: "source-1",
          label: "supports",
          description: null,
          confidence: 0.9,
          importance: 0.7
        },
        {
          id: "promoted",
          source: "source-1",
          target: "source-1",
          label: "extends",
          description: null,
          confidence: null,
          importance: null
        }
      ]
    ]);
    const result = await createKnowledgeGraphDashboardRepository(pool as unknown as PgPool).get(
      "sources",
      "relations"
    );
    expect(result.edges.map((edge) => [edge.id, edge.confidence])).toEqual([
      ["judged", 0.9],
      ["promoted", null]
    ]);
  });

  it("loads every source-connection detail only when its card is opened", async () => {
    const pool = new FakeGraphPool([
      [
        { id: "a", detail: "Entity A" },
        { id: "b", detail: "Entity B" }
      ],
      [
        {
          id: "ab",
          source: "a",
          target: "b",
          sourceLabel: "Entity A",
          targetLabel: "Entity B",
          label: "supports",
          detail: "Entity A · supports · Entity B"
        }
      ]
    ]);

    const details = await createKnowledgeGraphDashboardRepository(
      pool as unknown as PgPool
    ).getSourceConnectionDetails("source-1", "source-2");

    expect(details).toEqual({
      sharedEntities: ["Entity A", "Entity B"],
      semanticRelations: ["Entity A · supports · Entity B"],
      entities: [
        { id: "a", label: "Entity A", shared: true },
        { id: "b", label: "Entity B", shared: true }
      ],
      relations: [{ id: "ab", source: "a", target: "b", label: "supports" }]
    });
    expect(pool.queries).toHaveLength(2);
    expect(pool.queries[0]).toContain("select distinct entity.id");
    expect(pool.queries[1]).toContain("select distinct relation.id");
    expect(pool.queries[0]).toContain("with recursive source_tree");
    expect(pool.queries[1]).toContain("child.parent_source_item_id = parent.id");
  });
});
