import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PgPool } from "../client.js";
import { createAtomicNoteRepository } from "./atomicNoteRepository.js";
import { createConsultationRepository } from "./consultationRepository.js";
import { createEntityIdentityRepository } from "./entityIdentityRepository.js";
import { createKnowledgeConsultationRepository } from "./knowledgeConsultationRepository.js";
import { createKnowledgeGraphRepository } from "./knowledgeGraphRepository.js";
import { createRelationTypeRepository } from "./relationTypeRepository.js";
import { createSourceRelationRepository } from "./sourceRelationRepository.js";

/**
 * Every import mints new UUIDs, so a query that ends its ORDER BY on an ID (or has none) hands the
 * model a different candidate list, evidence order or batch for identical content. These guards
 * pin the ORDER BY of every query whose rows reach a prompt; the real-database behavior is covered
 * by the verify scripts.
 */
class RecordingPool {
  readonly queries: string[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text.replace(/\s+/g, " "));
    return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  get pool() {
    return this as unknown as PgPool;
  }
}

describe("content-stable query order", () => {
  it("orders atomic-note graph inputs, evidence and candidate ties by content", async () => {
    const pool = new RecordingPool();
    const notes = createAtomicNoteRepository(pool.pool);
    await notes.listGraphInputsBySourceItem("source");
    await notes.findTextMatchingCandidates({ noteId: "note", limit: 5 });
    await notes.findVectorMatchingCandidates({
      noteId: "note",
      embedding: Array.from({ length: 256 }, () => 0),
      limit: 5
    });
    await notes.findMatchingCandidates({ noteId: "note", limit: 5 });
    const [inputs, text, vector, general] = pool.queries;
    expect(inputs).toContain("array_agg(l.chunk_id::text order by c.chunk_index nulls last");
    expect(inputs).toContain("order by n.created_at, n.title, n.idea_statement, n.id");
    expect(text).toContain(
      '"textScore" desc, candidate.title, candidate.idea_statement, candidate.id'
    );
    expect(vector).toContain(
      '"vectorScore" desc, candidate.title, candidate.idea_statement, candidate.id'
    );
    expect(general).toContain("candidate.title, candidate.idea_statement, candidate.id limit");
  });

  it("orders canonical identity candidates and relation label batches by content", async () => {
    const pool = new RecordingPool();
    const vector = {
      embedding: Array.from({ length: 256 }, () => 1),
      spaceKey: "space",
      contentHash: "hash",
      provider: "p",
      model: "m",
      runtime: "local",
      metadata: {}
    };
    await createEntityIdentityRepository(pool.pool).candidates({
      type: "Person",
      names: [],
      vector,
      threshold: 0.9
    });
    await createRelationTypeRepository(pool.pool).candidates(vector, 0.9);
    await createKnowledgeGraphRepository(pool.pool).listRelationLabels({
      jobId: "00000000-0000-4000-8000-000000000001",
      mode: "all",
      before: "2026-01-01T00:00:00Z"
    });
    const [entities, types, labels] = pool.queries;
    expect(entities).toContain("e.canonical_name, e.id limit");
    expect(types).toContain("t.predicate, t.definition, t.id limit");
    expect(labels).toContain("order by s.canonical_name, r.predicate, o.canonical_name, r.id");
  });

  it("orders source matching roots, candidates, notes and existing relations by content", async () => {
    const pool = new RecordingPool();
    const repository = createSourceRelationRepository(pool.pool);
    await repository.roots(["00000000-0000-4000-8000-000000000001"]);
    await repository.candidates("00000000-0000-4000-8000-000000000001", 5);
    await repository.pairNotes("a", "b");
    await repository.existing("a", "b");
    const roots = pool.queries[0];
    expect(roots).toContain("order by root.title, id");
    // Text, notes, graph and one query per vector space rank on score, then the work title.
    const ranked = pool.queries.filter((query) =>
      query.includes("from source_items ranked_source")
    );
    expect(ranked.length).toBe(6);
    for (const query of ranked)
      expect(query).toMatch(
        /ranked_source\.id = [a-z_.]+root_id\),|ranked_source\.id = scored\.id\),/
      );
    const notes = pool.queries.find((query) => query.includes("semanticSourceAtomicNoteId"));
    expect(notes).toContain(
      "order by n.final_score desc, a.idea_statement, b.idea_statement, n.id"
    );
    const existing = pool.queries.find((query) => query.includes("from source_relations r"));
    expect(existing).toContain(
      "order by r.importance desc, rs.title, rt.title, r.relation_type, r.source_idea, r.target_idea, r.id"
    );
  });

  it("orders the pair evidence by title and chunk position, and visits the two works in a content order", async () => {
    const pool = new RecordingPool();
    const repository = createSourceRelationRepository(pool.pool);
    const [left, right] = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002"
    ];
    await repository.pairChunks(left!, right!, [left!], 4);
    expect(pool.queries[0]).toContain("order by title, id");
    const lexical = pool.queries.find((query) => query.includes("pairs as"));
    expect(lexical).toContain("a.chunk_index, b.chunk_index, a.id, b.id) as position");
    expect(lexical).toContain("order by position, score desc, a_title, b_title, a_index, b_index");
    expect(lexical).toContain("order by s.title, c.chunk_index, c.id");
    const notes = pool.queries.find((query) => query.includes("array_position($1::uuid[], c.id)"));
    expect(notes).toBeDefined();
    const semantic = pool.queries.find((query) => query.includes("av.embedding <=> bv.embedding"));
    expect(semantic).toContain("a.content_hash, b.content_hash, a.chunk_index, b.chunk_index");
    const concepts = pool.queries.find((query) => query.includes("concepts as"));
    expect(concepts).toContain("order by score desc, a.idea, b.idea, a.chunk_index, b.chunk_index");
  });

  it("orders consultation candidates, vector hits, contexts and relations by content", async () => {
    const pool = new RecordingPool();
    const sources = ["00000000-0000-4000-8000-000000000001"];
    await createConsultationRepository(pool.pool).candidates(sources, "question", false);
    await createConsultationRepository(pool.pool).vector(sources, {
      embedding: Array.from({ length: 256 }, () => 1),
      model: "m",
      provider: "p",
      runtime: "local",
      spaceKey: "k"
    });
    await createKnowledgeConsultationRepository(pool.pool).contexts(sources, sources, false);
    await createKnowledgeConsultationRepository(pool.pool).relations(sources);
    const candidates = pool.queries[0];
    expect(candidates).not.toContain("wiki_");
    expect(candidates).toContain('"sourceTitle","chunkIndex","chunkId" limit 200');
    expect(candidates).toMatch(/desc,"sourceTitle","chunkIndex","chunkId"$/);
    expect(pool.queries[1]).toContain(
      "e.embedding <=> $2::vector,s.title,c.chunk_index,e.target_id"
    );
    const [notes, summaries, entities] = pool.queries.slice(2, 5);
    expect(notes).toContain(
      "order by (select si.title from source_items si where si.id=rc.source_item_id),rc.chunk_index,refs.id"
    );
    expect(notes).toContain("c.chunk_index,n.title,n.idea_statement,n.id limit 20");
    expect(summaries).toContain("order by src.title,s.id limit 20");
    expect(entities).toContain("c.chunk_index,e.canonical_name,m.id limit 20");
    expect(pool.queries[5]).toContain('order by picked."sourceIdea",picked."targetIdea"');
  });
});
