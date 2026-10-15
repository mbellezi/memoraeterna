import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { createRelationDecisionRepository } from "./relationDecisionRepository.js";
import type { Queryable } from "./types.js";

// The real SQL runs in `npm run db:relation-decisions:verify`; this pins how a recorded direction
// is mapped onto the columns, and that a direction keeps its own AI run and time.
const lo = "00000000-0000-4000-8000-000000000001";
const hi = "00000000-0000-4000-8000-000000000002";

function setup(rows: QueryResultRow[] = []) {
  const query = vi.fn(
    async <T extends QueryResultRow>() => ({ rows, rowCount: 1 }) as unknown as QueryResult<T>
  );
  const db: Queryable = { query };
  return { repository: createRelationDecisionRepository(db), query };
}

/** A stored pair: lo -> hi scored 0.9 as "extends", hi -> lo not decided, on the given content. */
const storedRow = (overrides: Record<string, unknown> = {}) => ({
  loId: lo,
  hiId: hi,
  loHash: `hash-${lo}`,
  hiHash: `hash-${hi}`,
  loToHiScore: 0.9,
  loToHiRelationType: "extends",
  hiToLoScore: null,
  hiToLoRelationType: null,
  ...overrides
});
const lookup = (source: string, target: string) => ({
  sourceAtomicNoteId: source,
  sourceContentHash: `hash-${source}`,
  deciderKey: "decider",
  targets: [{ atomicNoteId: target, contentHash: `hash-${target}` }]
});

const decision = (source: string, target: string, aiTaskRunId: string | null) => ({
  sourceAtomicNoteId: source,
  targetAtomicNoteId: target,
  sourceContentHash: `hash-${source}`,
  targetContentHash: `hash-${target}`,
  deciderKey: "decider",
  score: 0.8,
  relationType: "supports",
  accepted: true,
  aiTaskRunId
});

describe("relation decision repository", () => {
  it("writes the AI run of a direction to that direction only", async () => {
    const { repository, query } = setup();
    await repository.record(decision(lo, hi, "run-lo-hi"));
    await repository.record(decision(hi, lo, "run-hi-lo"));
    const [, loToHi] = query.mock.calls[0] as unknown as [string, unknown[]];
    const [, hiToLo] = query.mock.calls[1] as unknown as [string, unknown[]];
    // Parameters 7-9 are the lo -> hi score, type and run; 10-12 are the hi -> lo ones.
    expect(loToHi.slice(6, 12)).toEqual([0.8, "supports", "run-lo-hi", null, null, null]);
    expect(hiToLo.slice(6, 12)).toEqual([null, null, null, 0.8, "supports", "run-hi-lo"]);
  });

  it("keeps the other direction's run and time while the content is unchanged, and drops them with it", async () => {
    const { repository, query } = setup();
    await repository.record(decision(lo, hi, null));
    const [sql] = query.mock.calls[0] as unknown as [string];
    const normalized = sql.replace(/\s+/g, " ");
    for (const direction of ["lo_to_hi", "hi_to_lo"]) {
      for (const column of [`${direction}_ai_task_run_id`, `${direction}_decided_at`]) {
        // The recording call wins for its own direction, even with a null run; the other keeps its
        // value only while both content hashes are unchanged, and never coalesces a new null in.
        expect(normalized).toContain(
          `${column} = case when excluded.${direction}_score is not null then excluded.${column} ` +
            `when d.lo_content_hash = excluded.lo_content_hash ` +
            `and d.hi_content_hash = excluded.hi_content_hash then d.${column} end`
        );
      }
    }
    // The pair-level audit columns no longer exist.
    expect(normalized).not.toMatch(/(?<![a-z_])ai_task_run_id = /);
    expect(normalized).not.toMatch(/(?<![a-z_])decided_at = now\(\)/);
  });

  it("reads the verdict of the direction being decided, and of its reverse, from the same pair row", async () => {
    // lo -> hi is decided; hi -> lo is not.
    const { repository } = setup([storedRow()]);
    // Deciding lo -> hi finds its own verdict and has nothing to reuse from the reverse.
    expect((await repository.findVerdicts(lookup(lo, hi))).get(hi)).toEqual({
      score: 0.9,
      relationType: "extends"
    });
    expect((await repository.findReverseVerdicts(lookup(lo, hi))).size).toBe(0);
    // Deciding hi -> lo has no verdict of its own and reuses lo -> hi.
    expect((await repository.findVerdicts(lookup(hi, lo))).size).toBe(0);
    expect((await repository.findReverseVerdicts(lookup(hi, lo))).get(lo)).toEqual({
      score: 0.9,
      relationType: "extends"
    });
  });

  it("reads the other column when the source is the higher ID", async () => {
    const { repository } = setup([
      storedRow({
        loToHiScore: null,
        loToHiRelationType: null,
        hiToLoScore: 0.7,
        hiToLoRelationType: "supports"
      })
    ]);
    expect((await repository.findReverseVerdicts(lookup(lo, hi))).get(hi)).toEqual({
      score: 0.7,
      relationType: "supports"
    });
    expect((await repository.findVerdicts(lookup(hi, lo))).get(lo)).toEqual({
      score: 0.7,
      relationType: "supports"
    });
  });

  it("never reuses a verdict recorded on other content, for either note", async () => {
    for (const stale of [{ loHash: "older" }, { hiHash: "older" }]) {
      const { repository } = setup([storedRow(stale)]);
      expect((await repository.findReverseVerdicts(lookup(hi, lo))).size).toBe(0);
    }
  });

  it("asks for the pair of the decider only, and never for a note against itself", async () => {
    const { repository, query } = setup([storedRow()]);
    await repository.findReverseVerdicts({
      ...lookup(hi, lo),
      targets: [
        { atomicNoteId: lo, contentHash: `hash-${lo}` },
        { atomicNoteId: hi, contentHash: `hash-${hi}` }
      ]
    });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("where decider_key = $1 and pair_key = any($2::text[])");
    expect(values).toEqual(["decider", [`${lo}:${hi}`]]);
    query.mockClear();
    expect((await repository.findReverseVerdicts({ ...lookup(hi, hi), targets: [] })).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
