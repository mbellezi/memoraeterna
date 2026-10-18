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

  it("no longer writes the pair-level outcome, and reads generative verdicts on the probability scale", async () => {
    const { repository, query } = setup([storedRow()]);
    await repository.record(decision(lo, hi, null));
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    const normalized = sql.replace(/\s+/g, " ");
    expect(normalized).not.toMatch(/(?<![a-z_])accepted/);
    expect(normalized).not.toMatch(/(?<![a-z_.])relation_type(?![a-z_])/);
    expect(normalized).toContain("'probability')");
    expect(normalized).toContain("where d.score_scale = excluded.score_scale");
    expect(values).toHaveLength(12);
    await repository.findVerdicts(lookup(lo, hi));
    expect((query.mock.calls[1] as unknown as [string])[0]).toContain(
      "score_scale = 'probability'"
    );
  });
});

describe("ranker scores (F3 D12, D13)", () => {
  const scores = (overrides: Record<string, unknown> = {}) => ({
    loAtomicNoteId: lo,
    hiAtomicNoteId: hi,
    loInputHash: "render-lo",
    hiInputHash: "render-hi",
    deciderKey: "ranker-cache-key",
    loToHi: 4.5,
    hiToLo: -2.25,
    aiTaskRunId: "run-1",
    ...overrides
  });

  it("stores raw log-odds of both directions with no type, on the log-odds scale", async () => {
    const { repository, query } = setup();
    await repository.recordRankerScores(scores());
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql.replace(/\s+/g, " ")).toContain("'log_odds')");
    expect(sql).not.toContain("lo_to_hi_relation_type, lo_to_hi_ai_task_run_id");
    expect(values).toEqual([
      `${lo}:${hi}`,
      lo,
      hi,
      "render-lo",
      "render-hi",
      "ranker-cache-key",
      4.5,
      -2.25,
      "run-1"
    ]);
  });

  it("refuses an unsorted pair, no score and a score that is not a finite number", async () => {
    const { repository, query } = setup();
    await expect(
      repository.recordRankerScores(scores({ loAtomicNoteId: hi, hiAtomicNoteId: lo }))
    ).rejects.toThrow("canonical");
    await expect(
      repository.recordRankerScores(scores({ loToHi: null, hiToLo: null }))
    ).rejects.toThrow("at least one");
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN])
      await expect(repository.recordRankerScores(scores({ loToHi: bad }))).rejects.toThrow(
        "finite"
      );
    expect(query).not.toHaveBeenCalled();
  });

  it("reuses a stored score only with the decider key and both rendered-input hashes unchanged", async () => {
    const row = {
      loId: lo,
      hiId: hi,
      loHash: "render-lo",
      hiHash: "render-hi",
      loToHiScore: 4.5,
      hiToLoScore: -2.25
    };
    const pair = {
      loAtomicNoteId: lo,
      hiAtomicNoteId: hi,
      loInputHash: "render-lo",
      hiInputHash: "render-hi"
    };
    const { repository, query } = setup([row]);
    expect(
      Object.fromEntries(await repository.findRankerScores({ deciderKey: "k", pairs: [pair] }))
    ).toEqual({ [`${lo}:${hi}`]: { loToHi: 4.5, hiToLo: -2.25 } });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("score_scale = 'log_odds'");
    expect(values).toEqual(["k", [`${lo}:${hi}`]]);
    // Named in the other order, the hashes follow their notes.
    expect(
      (
        await repository.findRankerScores({
          deciderKey: "k",
          pairs: [
            {
              loAtomicNoteId: hi,
              hiAtomicNoteId: lo,
              loInputHash: "render-hi",
              hiInputHash: "render-lo"
            }
          ]
        })
      ).size
    ).toBe(1);
    expect(
      (
        await repository.findRankerScores({
          deciderKey: "k",
          pairs: [{ ...pair, hiInputHash: "render-hi-edited" }]
        })
      ).size
    ).toBe(0);
    expect((await repository.findRankerScores({ deciderKey: "k", pairs: [] })).size).toBe(0);
  });

  it("reads a note's decided partners from either side of a pair, under one key, capped per note", async () => {
    const third = "00000000-0000-4000-8000-000000000003";
    const { repository, query } = setup([
      { loId: lo, hiId: hi },
      { loId: lo, hiId: third },
      { loId: hi, hiId: third }
    ]);
    const partners = await repository.findDecidedPartners({
      deciderKey: "k",
      noteIds: [hi, lo, hi]
    });
    expect(Object.fromEntries(partners)).toEqual({
      [lo]: [hi, third],
      [hi]: [lo, third]
    });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("score_scale = 'log_odds'");
    expect(sql).toContain("lo_to_hi_score is not null or hi_to_lo_score is not null");
    expect(values).toEqual(["k", [hi, lo]]);
    const capped = await repository.findDecidedPartners({
      deciderKey: "k",
      noteIds: [lo],
      limit: 1
    });
    expect(capped.get(lo)).toEqual([hi]);
    // Nobody asked for: no query.
    query.mockClear();
    expect((await repository.findDecidedPartners({ deciderKey: "k", noteIds: [] })).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
