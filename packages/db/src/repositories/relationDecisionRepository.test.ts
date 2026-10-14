import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { createRelationDecisionRepository } from "./relationDecisionRepository.js";
import type { Queryable } from "./types.js";

// The real SQL runs in `npm run db:relation-decisions:verify`; this pins how a recorded direction
// is mapped onto the columns, and that a direction keeps its own AI run and time.
const lo = "00000000-0000-4000-8000-000000000001";
const hi = "00000000-0000-4000-8000-000000000002";

function setup() {
  const query = vi.fn(
    async <T extends QueryResultRow>() => ({ rows: [], rowCount: 1 }) as unknown as QueryResult<T>
  );
  const db: Queryable = { query };
  return { repository: createRelationDecisionRepository(db), query };
}

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
});
