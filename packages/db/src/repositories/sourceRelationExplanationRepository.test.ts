import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import {
  createSourceRelationExplanationRepository,
  sourceRelationExplainable,
  sourceRelationExplanationPlan,
  type SourceRelationExplanationContext,
  type SourceRelationExplanationSide
} from "./sourceRelationExplanationRepository.js";
import { currentSourceRelationEvidenceSql } from "./sourceRelationRepository.js";

const ids = {
  relation: "00000000-0000-4000-8000-000000000010",
  low: "00000000-0000-4000-8000-000000000001",
  high: "00000000-0000-4000-8000-000000000002"
};
const side = (id: string, title: string, ...passages: string[]): SourceRelationExplanationSide => ({
  id,
  title,
  passages: passages.map((content, chunkIndex) => ({
    chunkId: `${id}-${chunkIndex}`,
    content,
    chunkIndex
  }))
});
const context = (
  overrides: Partial<SourceRelationExplanationContext> = {}
): SourceRelationExplanationContext => ({
  relationId: ids.relation,
  type: "supports",
  status: "pending_review",
  hasProse: false,
  source: side(ids.high, "Zeta review", "Retrieval improves recall."),
  target: side(ids.low, "Alpha study", "Feedback qualified the benefit."),
  stored: null,
  ...overrides
});

describe("source relation explanation inputs", () => {
  it("reads a directed relation from its source and hashes what the explanation depends on", () => {
    const plan = sourceRelationExplanationPlan(context(), "en");
    expect(plan.direction).toBe("s1_to_s2");
    expect(plan.first.title).toBe("Zeta review");
    expect(plan.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceRelationExplanationPlan(context(), "en").inputHash).toBe(plan.inputHash);
    for (const changed of [
      sourceRelationExplanationPlan(context({ type: "extends" }), "en"),
      sourceRelationExplanationPlan(context(), "pt-BR"),
      sourceRelationExplanationPlan(
        context({ source: side(ids.high, "Zeta review", "Retrieval improves recall.", "More.") }),
        "en"
      ),
      sourceRelationExplanationPlan(
        context({ target: side(ids.low, "Renamed study", "Feedback qualified the benefit.") }),
        "en"
      )
    ])
      expect(changed.inputHash).not.toBe(plan.inputHash);
  });

  it("orders a symmetric relation by content, never by its stored endpoints or IDs", () => {
    const stored = context({ type: "similar_to" });
    const reversed = context({ type: "similar_to", source: stored.target, target: stored.source });
    const plan = sourceRelationExplanationPlan(stored, "en");
    expect(plan.direction).toBe("symmetric");
    expect(plan.first.title).toBe("Alpha study");
    expect(sourceRelationExplanationPlan(reversed, "en")).toEqual(plan);
  });

  it("explains only relations without stored prose, not rejected, with current evidence on both sides", () => {
    expect(sourceRelationExplainable(context())).toBe(true);
    expect(sourceRelationExplainable(context({ status: "rejected" }))).toBe(false);
    expect(sourceRelationExplainable(context({ hasProse: true }))).toBe(false);
    expect(sourceRelationExplainable(context({ target: side(ids.low, "Alpha study") }))).toBe(
      false
    );
  });
});

describe("source relation explanation repository", () => {
  const recording = (relations: QueryResultRow[], passages: QueryResultRow[]) => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
        queries.push({ text, values });
        const rows = text.includes("cross join lateral") ? passages : relations;
        return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
      }
    };
    return { db, queries };
  };
  const relationRow = (stored: QueryResultRow | null = null) => ({
    relationId: ids.relation,
    type: "supports",
    status: "accepted",
    hasProse: false,
    sourceId: ids.high,
    targetId: ids.low,
    sourceTitle: "Zeta review",
    targetTitle: "Alpha study",
    stored
  });
  const passage = (side: string, chunkId: string, chunkIndex: number, content: string) => ({
    relationId: ids.relation,
    side,
    chunkId,
    chunkIndex,
    content
  });

  it("reads current passages per side in document order, distinct and bounded", async () => {
    const { db, queries } = recording(
      [relationRow()],
      [
        passage("source", "s-3", 3, "Third."),
        passage("source", "s-1", 1, "First."),
        passage("source", "s-1", 1, "First."),
        passage("source", "s-2", 2, "Second."),
        passage("target", "t-1", 0, "Target.")
      ]
    );
    const read = await createSourceRelationExplanationRepository(db).readContext(ids.relation);
    expect(read?.source.passages.map((item) => item.content)).toEqual(["First.", "Second."]);
    expect(read?.target.passages.map((item) => item.chunkId)).toEqual(["t-1"]);
    expect(queries[1]!.text).toContain(currentSourceRelationEvidenceSql);
    expect(queries.every((query) => query.values[0] instanceof Array)).toBe(true);
  });

  it("shows a written explanation only while its inputs and language still hold", async () => {
    const passages = [
      passage("source", "s-1", 0, "First."),
      passage("target", "t-1", 0, "Target.")
    ];
    const { db } = recording([relationRow()], passages);
    const repository = createSourceRelationExplanationRepository(db);
    const live = (await repository.readContext(ids.relation))!;
    const hash = sourceRelationExplanationPlan(live, "pt-BR").inputHash;
    const stored = (inputHash: string) => ({
      text: `<source-ref id="${ids.high}" /> supports it.`,
      inputHash,
      model: "writer",
      writtenAt: "2026-10-15T10:00:00.000Z"
    });
    const current = createSourceRelationExplanationRepository(
      recording([relationRow(stored(hash))], passages).db
    );
    expect(await current.currentExplanations([ids.relation], "pt-BR")).toEqual(
      new Map([[ids.relation, { text: stored(hash).text, writtenBy: "writer" }]])
    );
    expect((await current.currentExplanations([ids.relation], "en")).size).toBe(0);
    const stale = createSourceRelationExplanationRepository(
      recording([relationRow(stored("old"))], passages).db
    );
    expect((await stale.currentExplanations([ids.relation], "pt-BR")).size).toBe(0);
    expect(await repository.currentExplanations([], "en")).toEqual(new Map());
  });

  it("stores an explanation only while the relation exists", () => {
    const { db } = recording([], []);
    const { save } = createSourceRelationExplanationRepository(db).statements;
    expect(save).toContain("where exists (select 1 from source_relations where id = $1::uuid)");
    expect(save).toContain("on conflict (relation_id) do update");
  });
});
