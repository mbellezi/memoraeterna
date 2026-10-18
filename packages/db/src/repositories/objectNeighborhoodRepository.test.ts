import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { ObjectNeighborhoodSchema, objectNeighborhoodLimits } from "@app/domain";
import type { PgPool } from "../client.js";
import {
  currentNoteSql,
  noteRelationStateLabelSql,
  noteRelationStateSql,
  shownNoteRelationSql
} from "./note-relation-sql.js";
import {
  createObjectNeighborhoodRepository,
  secondRingReserve
} from "./objectNeighborhoodRepository.js";

// The SQL runs against a real database in `object-neighborhood.sidecar.test.ts` (answers) and
// `scripts/objects/note-page-benchmark.ts` (latency); these tests pin the transaction, the
// statements' order and inputs, how rows become the contract and the choice of the second ring.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const facts = (n: number) => ({
  id: id(n),
  title: `Note ${n}`,
  ideaStatement: `Idea ${n}.`,
  language: n % 2 === 0 ? "en" : null
});
const edge = (n: number, lo: number, hi: number, overrides: Record<string, unknown> = {}) => ({
  id: id(100 + n),
  lo: id(lo),
  hi: id(hi),
  type: "supports",
  direction: "lo_to_hi",
  band: "suggest",
  state: "suggested",
  ...overrides
});

interface Answers {
  neighbours?: QueryResultRow;
  secondRing?: QueryResultRow[];
  edges?: QueryResultRow[];
  fail?: "edges";
}

function setup(answers: Answers = {}) {
  const statements: Array<{ name: string | undefined; text: string; values: unknown[] }> = [];
  const answer = (name: string | undefined, text: string): QueryResultRow[] => {
    if (/^\s*(begin|commit|rollback)/i.test(text)) return [];
    if (name === "object-neighborhood-neighbours")
      return [answers.neighbours ?? { focus: facts(1), total: 0, neighbours: [] }];
    if (name === "object-neighborhood-second-ring") return answers.secondRing ?? [];
    if (answers.fail === "edges") throw new Error("boom");
    return answers.edges ?? [];
  };
  const query = vi.fn(
    async <T extends QueryResultRow>(
      config: string | { name?: string; text: string; values?: unknown[] }
    ) => {
      const call = typeof config === "string" ? { text: config } : config;
      statements.push({
        name: (call as { name?: string }).name,
        text: call.text,
        values: (call as { values?: unknown[] }).values ?? []
      });
      return {
        rows: answer((call as { name?: string }).name, call.text)
      } as unknown as QueryResult<T>;
    }
  );
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as PgPool;
  return { repository: createObjectNeighborhoodRepository(pool), statements, release };
}

const names = (statements: Array<{ name: string | undefined; text: string }>) =>
  statements.map((s) => s.name ?? s.text.trim().split(/\s+/).slice(0, 1).join(" "));

describe("the neighbourhood repository", () => {
  it("answers null for a note that does not exist, after one read and a commit", async () => {
    const { repository, statements, release } = setup({
      neighbours: { focus: null, total: 0, neighbours: [] }
    });
    expect(await repository.read({ objectId: id(1), depth: 1, limit: 40 })).toBeNull();
    expect(names(statements)).toEqual(["begin", "object-neighborhood-neighbours", "commit"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads depth 1 in one read-only repeatable-read transaction: the focus, its ranked notes and their edges", async () => {
    const { repository, statements, release } = setup({
      neighbours: { focus: facts(1), total: "2", neighbours: [facts(2), facts(3)] },
      edges: [edge(1, 1, 2), edge(2, 1, 3, { band: null, state: "applied" }), edge(3, 2, 3)]
    });
    const answer = await repository.read({ objectId: id(1), depth: 1, limit: 40 });
    expect(names(statements)).toEqual([
      "begin",
      "object-neighborhood-neighbours",
      "object-neighborhood-edges",
      "commit"
    ]);
    expect(statements[0]!.text).toContain("repeatable read, read only");
    expect(statements[1]!.values).toEqual([id(1), 39]);
    expect(statements[2]!.values).toEqual([[id(1), id(2), id(3)]]);
    expect(ObjectNeighborhoodSchema.parse(answer)).toEqual({
      focus: id(1),
      depth: 1,
      nodes: [
        {
          id: id(1),
          kind: "note",
          title: "Note 1",
          ideaStatement: "Idea 1.",
          language: null,
          depth: 0
        },
        {
          id: id(2),
          kind: "note",
          title: "Note 2",
          ideaStatement: "Idea 2.",
          language: "en",
          depth: 1
        },
        {
          id: id(3),
          kind: "note",
          title: "Note 3",
          ideaStatement: "Idea 3.",
          language: null,
          depth: 1
        }
      ],
      edges: [edge(1, 1, 2), edge(2, 1, 3, { band: null, state: "applied" }), edge(3, 2, 3)],
      neighbourTotal: 2,
      truncated: false
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads no edges for a note with no shown relation, and says when notes were left out", async () => {
    const lone = setup();
    const answer = await lone.repository.read({ objectId: id(1), depth: 2, limit: 40 });
    expect(names(lone.statements)).toEqual(["begin", "object-neighborhood-neighbours", "commit"]);
    expect(answer).toMatchObject({ nodes: [{ id: id(1), depth: 0 }], edges: [], truncated: false });

    const hub = setup({
      neighbours: { focus: facts(1), total: 57, neighbours: [facts(2), facts(3)] }
    });
    expect(await hub.repository.read({ objectId: id(1), depth: 1, limit: 3 })).toMatchObject({
      neighbourTotal: 57,
      truncated: true
    });
    expect(hub.statements[1]!.values).toEqual([id(1), 2]);
  });

  it("never draws a state that is not applied, kept or suggested", async () => {
    const { repository } = setup({
      neighbours: { focus: facts(1), total: 2, neighbours: [facts(2), facts(3)] },
      edges: [
        edge(1, 1, 2, { state: "withdrawn" }),
        edge(2, 1, 3, { state: "removed" }),
        edge(3, 2, 3, { state: "kept", band: null })
      ]
    });
    const answer = await repository.read({ objectId: id(1), depth: 1, limit: 40 });
    expect(answer!.edges.map((entry) => entry.state)).toEqual(["kept"]);
  });

  it("adds the second ring at depth 2 from the strongest depth-1 notes only", async () => {
    const neighbours = Array.from({ length: 20 }, (_, n) => facts(n + 2));
    const { repository, statements } = setup({
      neighbours: { focus: facts(1), total: 20, neighbours },
      secondRing: [
        { seedRank: 1, probability: 0.9, finalScore: 0.9, note: facts(50) },
        { seedRank: 2, probability: 0.95, finalScore: 0.9, note: facts(51) },
        // Already a depth-1 note, and the focus: never a second-ring note.
        { seedRank: 2, probability: 0.99, finalScore: 0.9, note: facts(5) },
        { seedRank: 3, probability: 0.99, finalScore: 0.9, note: facts(1) }
      ]
    });
    const answer = await repository.read({ objectId: id(1), depth: 2, limit: 40 });
    expect(names(statements)).toEqual([
      "begin",
      "object-neighborhood-neighbours",
      "object-neighborhood-second-ring",
      "object-neighborhood-edges",
      "commit"
    ]);
    // The seeds are the 12 strongest depth-1 notes, in rank order.
    expect(statements[2]!.values).toEqual([
      id(1),
      neighbours.slice(0, objectNeighborhoodLimits.seeds).map((entry) => entry.id),
      objectNeighborhoodLimits.seedPool,
      objectNeighborhoodLimits.perSeed
    ]);
    expect(answer!.nodes.map((entry) => [entry.id, entry.depth])).toEqual([
      [id(1), 0],
      ...neighbours.map((entry) => [entry.id, 1]),
      [id(51), 2],
      [id(50), 2]
    ]);
    expect(statements[3]!.values[0]).toHaveLength(23);
  });

  it("keeps a quarter of the nodes for the second ring and gives unused slots back to depth 1", async () => {
    const neighbours = Array.from({ length: 39 }, (_, n) => facts(n + 2));
    const withRing = setup({
      neighbours: { focus: facts(1), total: 60, neighbours },
      secondRing: [{ seedRank: 1, probability: 0.9, finalScore: 0.9, note: facts(90) }]
    });
    const some = await withRing.repository.read({ objectId: id(1), depth: 2, limit: 40 });
    // One second-ring note; the depth-1 notes keep the other 38 slots, in rank order.
    expect(some!.nodes).toHaveLength(40);
    expect(some!.nodes.filter((entry) => entry.depth === 1)).toHaveLength(38);
    expect(some!.nodes.at(-1)).toMatchObject({ id: id(90), depth: 2 });
    expect(some!.truncated).toBe(true);

    const none = setup({ neighbours: { focus: facts(1), total: 60, neighbours } });
    const bare = await none.repository.read({ objectId: id(1), depth: 2, limit: 40 });
    expect(bare!.nodes.filter((entry) => entry.depth === 1)).toHaveLength(39);
    expect(secondRingReserve(40)).toBe(9);
    expect(secondRingReserve(1)).toBe(0);

    const full = setup({
      neighbours: { focus: facts(1), total: 60, neighbours },
      secondRing: Array.from({ length: 12 }, (_, n) => ({
        seedRank: 1,
        probability: 0.9 - n / 100,
        finalScore: 0.5,
        note: facts(100 + n)
      }))
    });
    const crowded = await full.repository.read({ objectId: id(1), depth: 2, limit: 40 });
    expect(crowded!.nodes.filter((entry) => entry.depth === 2)).toHaveLength(9);
    expect(crowded!.nodes.filter((entry) => entry.depth === 1)).toHaveLength(30);
    expect(crowded!.nodes).toHaveLength(40);
  });

  it("rolls back and releases the connection when a statement fails", async () => {
    const { repository, statements, release } = setup({
      neighbours: { focus: facts(1), total: 1, neighbours: [facts(2)] },
      fail: "edges"
    });
    await expect(repository.read({ objectId: id(1), depth: 1, limit: 40 })).rejects.toThrow("boom");
    expect(names(statements).at(-1)).toBe("rollback");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads relations through the predicates of note-relation-sql.ts alone", () => {
    const { repository } = setup();
    const { neighbours, secondRing, edges } = repository.statements;
    expect(neighbours).toContain(
      shownNoteRelationSql("r", [
        { alias: "s", current: "s.current" },
        { alias: "o", current: "o.current" }
      ])
    );
    expect(neighbours).toContain(currentNoteSql("o"));
    expect(secondRing).toContain(noteRelationStateSql.shown("r"));
    expect(secondRing).toContain(
      shownNoteRelationSql("x", ["sn", { alias: "o", current: "o.current" }])
    );
    expect(edges).toContain(shownNoteRelationSql("r", ["ln", "hn"]));
    expect(edges).toContain(noteRelationStateLabelSql("r"));
    // Reads only: nothing here can write.
    for (const text of Object.values(repository.statements))
      expect(text).not.toMatch(/\b(insert|update|delete|truncate)\b/iu);
  });
});
