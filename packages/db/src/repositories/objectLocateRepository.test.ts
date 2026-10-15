import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import {
  ObjectLocateResultSchema,
  objectLocateListLimit,
  objectLocatePathLimit,
  objectLocateTopicPathLimit
} from "@app/domain";
import { createObjectLocateRepository } from "./objectLocateRepository.js";
import type { Queryable } from "./types.js";

// The SQL runs against a real database in `npm run db:object-locate:verify` (answers) and
// `scripts/objects/locate-benchmark.ts` (latency); these tests pin how a row becomes the contract
// and that the statements can never write.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup(rows: QueryResultRow[]) {
  const query = vi.fn(
    async <T extends QueryResultRow>() => ({ rows }) as unknown as QueryResult<T>
  );
  const db: Queryable = { query };
  return { repository: createObjectLocateRepository(db), query };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  title: "Section",
  path: [
    { id: id(1), title: "Book" },
    { id: id(2), title: "Section" }
  ],
  topicPath: [
    { id: id(30), title: "" },
    { id: id(31), title: "Memory" }
  ],
  alsoIn: [{ kind: "topic", id: id(5), title: "Learning", extra: "dropped" }],
  citedBy: [{ kind: "note", id: id(6), title: "Another note", extra: "dropped" }],
  // pg returns count(*)::int as a number and bigint as a string; both are accepted.
  alsoInCount: "1",
  citedByCount: 1,
  notes: "3",
  passages: 8,
  children: 0,
  ...overrides
});

describe("object locate repository", () => {
  it("asks for one source in one bounded statement", async () => {
    const { repository, query } = setup([row()]);
    await repository.locateSource(id(2));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      id(2),
      objectLocateListLimit,
      objectLocatePathLimit - 1
    ]);
  });

  it("walks one ancestor less for a note, which takes the last slot of the path itself", async () => {
    // The stub honours the depth bound the statement applies ($3), over a 40-deep chain.
    const chain = Array.from({ length: 40 }, (_, n) => ({ id: id(100 + n), title: `Level ${n}` }));
    const query = vi.fn(
      async <T extends QueryResultRow>(_text: string, values?: readonly unknown[]) =>
        ({
          rows: [
            row({
              title: "Deep",
              topicPath: [],
              path: chain.slice(0, Number(values?.[2]) + 1)
            })
          ]
        }) as unknown as QueryResult<T>
    );
    const repository = createObjectLocateRepository({ query });
    const note = await repository.locateNote(id(9));
    expect(query.mock.calls[0]?.[1]).toEqual([
      id(9),
      objectLocateListLimit,
      objectLocatePathLimit - 2
    ]);
    expect(note?.primaryPath).toHaveLength(objectLocatePathLimit);
    expect(note?.primaryPath.at(-1)).toEqual({ kind: "note", id: id(9), title: "Deep" });
    expect(ObjectLocateResultSchema.safeParse(note).success).toBe(true);
    const source = await repository.locateSource(id(9));
    expect(source?.primaryPath).toHaveLength(objectLocatePathLimit);
    expect(ObjectLocateResultSchema.safeParse(source).success).toBe(true);
  });

  it("turns a source row into the contract: its topics, then its chain ending with the source", async () => {
    const { repository } = setup([row()]);
    expect(await repository.locateSource(id(2))).toEqual({
      object: { kind: "source", id: id(2), title: "Section" },
      primaryPath: [
        { kind: "topic", id: id(30), title: "" },
        { kind: "topic", id: id(31), title: "Memory" },
        { kind: "source", id: id(1), title: "Book" },
        { kind: "source", id: id(2), title: "Section" }
      ],
      alsoIn: [{ kind: "topic", id: id(5), title: "Learning" }],
      citedBy: [{ kind: "note", id: id(6), title: "Another note" }],
      counts: { alsoIn: 1, citedBy: 1, notes: 3, passages: 8, children: 0 }
    });
  });

  it("puts the topics of a note in front of the chain of its source and ends the path with the note", async () => {
    const { repository } = setup([row({ title: "A note", path: [{ id: id(1), title: "Book" }] })]);
    const located = await repository.locateNote(id(9));
    expect(located?.primaryPath).toEqual([
      { kind: "topic", id: id(30), title: "" },
      { kind: "topic", id: id(31), title: "Memory" },
      { kind: "source", id: id(1), title: "Book" },
      { kind: "note", id: id(9), title: "A note" }
    ]);
    expect(located?.object).toEqual({ kind: "note", id: id(9), title: "A note" });
    expect(ObjectLocateResultSchema.safeParse(located).success).toBe(true);
  });

  it("keeps an object the tree does not hold: its path is the source chain alone", async () => {
    const { repository } = setup([row({ topicPath: [], alsoIn: [], alsoInCount: 0 })]);
    expect((await repository.locateSource(id(2)))?.primaryPath.map(({ kind }) => kind)).toEqual([
      "source",
      "source"
    ]);
  });

  it("keeps a note whose source is gone: its path is its topics and the note", async () => {
    const { repository } = setup([row({ title: "Orphan", path: [] })]);
    expect((await repository.locateNote(id(9)))?.primaryPath).toEqual([
      { kind: "topic", id: id(30), title: "" },
      { kind: "topic", id: id(31), title: "Memory" },
      { kind: "note", id: id(9), title: "Orphan" }
    ]);
    const bare = setup([row({ title: "Orphan", path: [], topicPath: [] })]);
    expect((await bare.repository.locateNote(id(9)))?.primaryPath).toEqual([
      { kind: "note", id: id(9), title: "Orphan" }
    ]);
  });

  it("fits the longest topic path and the longest source chain in the contract", async () => {
    const topics = Array.from({ length: objectLocateTopicPathLimit }, (_, n) => ({
      id: id(200 + n),
      title: n === 0 ? "" : `Level ${n}`
    }));
    const sources = Array.from({ length: objectLocatePathLimit - 1 }, (_, n) => ({
      id: id(300 + n),
      title: `Source ${n}`
    }));
    const { repository } = setup([row({ title: "Deep", topicPath: topics, path: sources })]);
    const note = await repository.locateNote(id(9));
    expect(note?.primaryPath).toHaveLength(objectLocateTopicPathLimit + objectLocatePathLimit);
    expect(ObjectLocateResultSchema.safeParse(note).success).toBe(true);
  });

  it("walks the topics up to the depth cap and no further, and finds the note and source by their own indexes", () => {
    const { statements } = setup([]).repository;
    for (const statement of Object.values(statements)) {
      expect(statement).toContain(`topic_chain.depth < ${objectLocateTopicPathLimit - 1}`);
      expect(statement).toContain("tree.status = 'active'");
      expect(statement).toContain("t.retired_at is null");
      expect(statement).not.toMatch(/\bwiki_\w+|\borganization_\w+/);
    }
    expect(statements.note).toContain("p.note_id = $1::uuid");
    expect(statements.source).toContain("p.source_item_id = (select c.id from chain c");
  });

  it("returns null when the object does not exist", async () => {
    expect(await setup([row({ title: null })]).repository.locateSource(id(2))).toBeNull();
    expect(await setup([]).repository.locateNote(id(9))).toBeNull();
  });

  it("only reads: no statement writes, locks or changes the schema", () => {
    const { repository } = setup([]);
    for (const statement of Object.values(repository.statements)) {
      expect(statement).not.toMatch(/\b(insert|update|delete|truncate|create|drop|alter|grant)\b/i);
      expect(statement).not.toMatch(/for\s+(update|share|no key update)/i);
      expect(statement.trimStart().toLowerCase().startsWith("with recursive")).toBe(true);
    }
  });

  it("filters out what is no longer current: rejected, archived and superseded notes and old chunks", () => {
    const { statements } = setup([]).repository;
    expect(statements.source).toContain("supersession = 'current'");
    expect(statements.source).toContain("'rejected', 'archived'");
    expect(statements.source).toContain("supersededByDocumentId");
  });
});
