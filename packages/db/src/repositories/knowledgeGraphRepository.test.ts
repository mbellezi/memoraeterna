import { describe, expect, it, vi } from "vitest";

import type { PgPool } from "../client.js";
import { createKnowledgeGraphRepository, inverseEntityFrequency } from "./knowledgeGraphRepository.js";

describe("knowledge graph repository", () => {
  it("penalizes entities linked to many atomic notes", () => {
    expect(inverseEntityFrequency(100, 2)).toBeGreaterThan(inverseEntityFrequency(100, 20));
    expect(inverseEntityFrequency(100, 20)).toBeGreaterThan(inverseEntityFrequency(100, 100));
    expect(inverseEntityFrequency(100, 100)).toBe(0.2);
    expect(inverseEntityFrequency(1, 1)).toBe(1);
  });

  it("discovers graph-only note candidates and applies entity-frequency weight", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000001";
    const targetId = "00000000-0000-4000-8000-000000000002";
    const entityId = "00000000-0000-4000-8000-000000000003";
    const query = vi.fn(async (text: string) => {
      if (text.includes("ag_catalog.ag_graph")) return { rows: [{}], rowCount: 1 };
      if (text.includes("entity.id, pathScore")) return {
        rows: [{ targetId: JSON.stringify(targetId), entityId: JSON.stringify(entityId), relationConfidence: "0.8" }],
        rowCount: 1
      };
      if (text.includes("sourceEntity.id")) return { rows: [], rowCount: 0 };
      if (text.includes("select id from atomic_notes")) return { rows: [{ id: targetId }], rowCount: 1 };
      if (text.includes("count(distinct links.atomic_note_id)")) return {
        rows: [{ entityId, noteCount: "20", totalNotes: "100" }],
        rowCount: 1
      };
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;

    const candidates = await createKnowledgeGraphRepository(pool).findAtomicNoteCandidates(sourceId, 20);

    expect(candidates).toEqual([{
      noteId: targetId,
      graphScore: 0.8 * inverseEntityFrequency(100, 20),
      pathType: "shared_entity"
    }]);
    const directQuery = query.mock.calls.find(([text]) => String(text).includes("entity.id, pathScore"))?.[0];
    expect(directQuery).not.toContain("target.id IN");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("deduplicates semantic relations in atomic-note debug elements", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            noteId: "00000000-0000-4000-8000-000000000001",
            id: "relation-1",
            subject: "Fire",
            predicate: "may_confuse_with",
            object: "True Will",
            confidence: 0.82
          },
          {
            noteId: "00000000-0000-4000-8000-000000000001",
            id: "relation-2",
            subject: "Fire",
            predicate: "may_confuse_with",
            object: "True Will",
            confidence: 0.92
          }
        ]
      });
    const pool = { query } as unknown as PgPool;

    const elements = await createKnowledgeGraphRepository(pool).listAtomicNoteElements([
      "00000000-0000-4000-8000-000000000001"
    ]);

    expect(elements.get("00000000-0000-4000-8000-000000000001")?.relations).toEqual([{
      noteId: "00000000-0000-4000-8000-000000000001",
      id: "relation-2",
      subject: "Fire",
      predicate: "may_confuse_with",
      object: "True Will",
      confidence: 0.92
    }]);
  });

  it("lists source entities, semantic relations, and navigable cross-source connections", async () => {
    const targetSourceId = "00000000-0000-4000-8000-000000000020";
    const query = vi.fn(async (text: string) => {
      if (text.includes("max(mention.confidence)")) return { rows: [{ id: "entity-1", type: "Concept", name: "Memory", confidence: "0.9" }] };
      if (text.includes("where relation.source_item_id")) return { rows: [{ id: "relation-1", subject: "Memory", predicate: "supports", object: "Recall", confidence: "0.8" }] };
      if (text.includes("other_mention.entity_id = entity.id")) return { rows: [{ sourceItemId: targetSourceId, sourceTitle: "Other source", entityName: "Memory", confidence: "0.75" }] };
      if (text.includes("join entity_relations relation on")) return { rows: [{ sourceItemId: targetSourceId, sourceTitle: "Other source", entityName: "Memory", relatedEntityName: "Recall", predicate: "supports", confidence: "0.7" }] };
      return { rows: [] };
    });
    const pool = { query } as unknown as PgPool;

    const graph = await createKnowledgeGraphRepository(pool).listSourceElements(
      "00000000-0000-4000-8000-000000000010"
    );

    expect(graph.entities).toEqual([{ id: "entity-1", type: "Concept", name: "Memory", confidence: 0.9 }]);
    expect(graph.relations[0]).toMatchObject({ subject: "Memory", predicate: "supports", object: "Recall" });
    expect(graph.sourceConnections).toEqual([
      { sourceItemId: targetSourceId, sourceTitle: "Other source", entityName: "Memory", relatedEntityName: "Memory", predicate: "shared_entity", confidence: 0.75 },
      { sourceItemId: targetSourceId, sourceTitle: "Other source", entityName: "Memory", relatedEntityName: "Recall", predicate: "supports", confidence: 0.7 }
    ]);
  });
});
