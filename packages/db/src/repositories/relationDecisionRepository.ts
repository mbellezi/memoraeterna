import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

/** One direction of a decided pair: the decider's raw score and relation type. */
export interface RelationDecisionVerdict {
  score: number;
  relationType: string;
}

export interface RelationDecisionInput {
  /** The decided direction is always source -> target. */
  sourceAtomicNoteId: string;
  targetAtomicNoteId: string;
  sourceContentHash: string;
  targetContentHash: string;
  /** Model identity, prompt/contract version and decision-relevant parameters. */
  deciderKey: string;
  score: number;
  relationType: string;
  /** The AI run that produced this direction's verdict; the other direction keeps its own. */
  aiTaskRunId: string | null;
}

/**
 * A ranker's raw scores of both directions of a pair (F3 D12, D13): log-odds as the ranker answered
 * them, before any calibration, with no per-direction type. `loInputHash`/`hiInputHash` are the
 * SHA-256 of the exact text the decider saw for each note (its rendered input), and `deciderKey` the
 * decider cache key; a stored score is reused only while all three match.
 */
export interface RankerScoresInput {
  loAtomicNoteId: string;
  hiAtomicNoteId: string;
  loInputHash: string;
  hiInputHash: string;
  deciderKey: string;
  /** Raw log-odds of lo -> hi and hi -> lo; a direction not scored by this call is null. */
  loToHi: number | null;
  hiToLo: number | null;
  aiTaskRunId: string | null;
}

/** Stored raw log-odds of a pair, per direction (null when that direction was never scored). */
export interface RankerScores {
  loToHi: number | null;
  hiToLo: number | null;
}

export interface RankerScoresLookup {
  deciderKey: string;
  pairs: ReadonlyArray<{
    loAtomicNoteId: string;
    hiAtomicNoteId: string;
    loInputHash: string;
    hiInputHash: string;
  }>;
}

interface RelationDecisionRow extends QueryResultRow {
  loId: string;
  hiId: string;
  loHash: string;
  hiHash: string;
  loToHiScore: number | null;
  loToHiRelationType: string | null;
  hiToLoScore: number | null;
  hiToLoRelationType: string | null;
}

/** The unordered pair key: both note IDs in ascending order (storage only, never a prompt). */
export function relationDecisionPair(left: string, right: string) {
  if (left === right) throw new Error("A relation decision needs two different notes.");
  const [lo, hi] = left < right ? [left, right] : [right, left];
  return { lo, hi, key: `${lo}:${hi}` };
}

const sameContent =
  "d.lo_content_hash = excluded.lo_content_hash and d.hi_content_hash = excluded.hi_content_hash";

/**
 * The SET clauses of one direction on conflict (static column names, never input). The verdict is
 * kept while the content is unchanged unless this call records the direction; its AI run and time
 * follow the recording call, so the other direction keeps its own.
 */
function directionAssignments(direction: "lo_to_hi" | "hi_to_lo"): string {
  const verdict = (column: string) =>
    `${column} = case when ${sameContent}
             then coalesce(excluded.${column}, d.${column}) else excluded.${column} end`;
  const audit = (column: string) =>
    `${column} = case when excluded.${direction}_score is not null then excluded.${column}
             when ${sameContent} then d.${column} end`;
  return [
    verdict(`${direction}_score`),
    verdict(`${direction}_relation_type`),
    audit(`${direction}_ai_task_run_id`),
    audit(`${direction}_decided_at`)
  ].join(",\n           ");
}

interface VerdictLookup {
  sourceAtomicNoteId: string;
  sourceContentHash: string;
  deciderKey: string;
  targets: ReadonlyArray<{ atomicNoteId: string; contentHash: string }>;
}

/**
 * The verdicts of one direction for the pair of `source` and each target, on the current content
 * of both notes. `forward` reads source -> target, `reverse` reads target -> source. Keys are the
 * target IDs either way.
 */
async function readVerdicts(
  db: Queryable,
  input: VerdictLookup,
  direction: "forward" | "reverse"
): Promise<Map<string, RelationDecisionVerdict>> {
  const verdicts = new Map<string, RelationDecisionVerdict>();
  const targets = input.targets.filter(
    (target) => target.atomicNoteId !== input.sourceAtomicNoteId
  );
  if (!targets.length) return verdicts;
  const result = await db.query<RelationDecisionRow>(
    `select lo_atomic_note_id as "loId", hi_atomic_note_id as "hiId",
       lo_content_hash as "loHash", hi_content_hash as "hiHash",
       lo_to_hi_score as "loToHiScore", lo_to_hi_relation_type as "loToHiRelationType",
       hi_to_lo_score as "hiToLoScore", hi_to_lo_relation_type as "hiToLoRelationType"
     from relation_decisions
     where decider_key = $1 and pair_key = any($2::text[]) and score_scale = 'probability'`,
    [
      input.deciderKey,
      targets.map(
        (target) => relationDecisionPair(input.sourceAtomicNoteId, target.atomicNoteId).key
      )
    ]
  );
  const rows = new Map(result.rows.map((row) => [`${row.loId}:${row.hiId}`, row]));
  for (const target of targets) {
    const pair = relationDecisionPair(input.sourceAtomicNoteId, target.atomicNoteId);
    const row = rows.get(pair.key);
    if (!row) continue;
    const sourceIsLo = pair.lo === input.sourceAtomicNoteId;
    const sameContent = sourceIsLo
      ? row.loHash === input.sourceContentHash && row.hiHash === target.contentHash
      : row.hiHash === input.sourceContentHash && row.loHash === target.contentHash;
    // Source -> target is the lo -> hi column when the source is lo; the reverse reads the other one.
    const loToHi = sourceIsLo === (direction === "forward");
    const score = loToHi ? row.loToHiScore : row.hiToLoScore;
    const relationType = loToHi ? row.loToHiRelationType : row.hiToLoRelationType;
    if (sameContent && score !== null && relationType !== null)
      verdicts.set(target.atomicNoteId, { score: Number(score), relationType });
  }
  return verdicts;
}

export function createRelationDecisionRepository(db: Queryable) {
  return {
    /**
     * Verdicts already recorded for `source -> target` by this decider on the current content of
     * both notes. A verdict for the reverse direction or for older content is not returned.
     */
    findVerdicts(input: VerdictLookup): Promise<Map<string, RelationDecisionVerdict>> {
      return readVerdicts(db, input, "forward");
    },

    /**
     * Verdicts recorded for `target -> source`, the reverse of the direction being decided, by this
     * decider on the current content of both notes, keyed by the target. A generative decider
     * judges an unordered pair once, so matching reuses these instead of asking again. The type
     * belongs to `target -> source`: the caller keeps that direction with it.
     */
    findReverseVerdicts(input: VerdictLookup): Promise<Map<string, RelationDecisionVerdict>> {
      return readVerdicts(db, input, "reverse");
    },

    /**
     * Records one direction with its own AI run and time. The other direction's verdict, run and
     * time are kept while both content hashes are unchanged and discarded when either note changed,
     * so a row never mixes content versions. The pair-level outcome of the pre-F3 matcher is gone
     * (F3 D12 stopped writing it, migration 0063 dropped it): acceptance is calibration's, outside
     * this raw table.
     */
    async record(input: RelationDecisionInput): Promise<void> {
      const pair = relationDecisionPair(input.sourceAtomicNoteId, input.targetAtomicNoteId);
      const sourceIsLo = pair.lo === input.sourceAtomicNoteId;
      const verdict = [input.score, input.relationType, input.aiTaskRunId];
      const result = await db.query(
        `insert into relation_decisions as d (
           pair_key, lo_atomic_note_id, hi_atomic_note_id, lo_content_hash, hi_content_hash,
           decider_key, lo_to_hi_score, lo_to_hi_relation_type, lo_to_hi_ai_task_run_id,
           lo_to_hi_decided_at, hi_to_lo_score, hi_to_lo_relation_type, hi_to_lo_ai_task_run_id,
           hi_to_lo_decided_at, score_scale
         ) values ($1, $2, $3, $4, $5, $6, $7::double precision, $8, $9::uuid,
           case when $7::double precision is not null then now() end,
           $10::double precision, $11, $12::uuid,
           case when $10::double precision is not null then now() end, 'probability')
         on conflict (pair_key, decider_key) do update set
           ${directionAssignments("lo_to_hi")},
           ${directionAssignments("hi_to_lo")},
           lo_content_hash = excluded.lo_content_hash,
           hi_content_hash = excluded.hi_content_hash
         where d.score_scale = excluded.score_scale
         returning 1`,
        [
          pair.key,
          pair.lo,
          pair.hi,
          sourceIsLo ? input.sourceContentHash : input.targetContentHash,
          sourceIsLo ? input.targetContentHash : input.sourceContentHash,
          input.deciderKey,
          ...(sourceIsLo ? verdict : [null, null, null]),
          ...(sourceIsLo ? [null, null, null] : verdict)
        ]
      );
      if (result.rowCount === 0)
        throw new Error("A relation decider key cannot record verdicts on two score scales.");
    },

    /**
     * Records a ranker's raw log-odds for one or both directions of a pair (`score_scale =
     * log_odds`, no type). A direction this call does not score keeps its stored score while both
     * rendered-input hashes are unchanged, and is discarded when either changed.
     */
    async recordRankerScores(input: RankerScoresInput): Promise<void> {
      const pair = relationDecisionPair(input.loAtomicNoteId, input.hiAtomicNoteId);
      if (pair.lo !== input.loAtomicNoteId)
        throw new Error("Ranker scores need the canonical pair (lo < hi).");
      if (input.loToHi === null && input.hiToLo === null)
        throw new Error("Ranker scores need at least one scored direction.");
      for (const score of [input.loToHi, input.hiToLo])
        if (score !== null && !Number.isFinite(score))
          throw new Error("A ranker score must be a finite log-odds value.");
      const result = await db.query(
        `insert into relation_decisions as d (
           pair_key, lo_atomic_note_id, hi_atomic_note_id, lo_content_hash, hi_content_hash,
           decider_key, lo_to_hi_score, lo_to_hi_ai_task_run_id, lo_to_hi_decided_at,
           hi_to_lo_score, hi_to_lo_ai_task_run_id, hi_to_lo_decided_at, score_scale
         ) values ($1, $2, $3, $4, $5, $6, $7::double precision,
           case when $7::double precision is not null then $9::uuid end,
           case when $7::double precision is not null then now() end,
           $8::double precision,
           case when $8::double precision is not null then $9::uuid end,
           case when $8::double precision is not null then now() end, 'log_odds')
         on conflict (pair_key, decider_key) do update set
           ${directionAssignments("lo_to_hi")},
           ${directionAssignments("hi_to_lo")},
           lo_content_hash = excluded.lo_content_hash,
           hi_content_hash = excluded.hi_content_hash
         where d.score_scale = excluded.score_scale
         returning 1`,
        [
          pair.key,
          pair.lo,
          pair.hi,
          input.loInputHash,
          input.hiInputHash,
          input.deciderKey,
          input.loToHi,
          input.hiToLo,
          input.aiTaskRunId
        ]
      );
      if (result.rowCount === 0)
        throw new Error("A relation decider key cannot record verdicts on two score scales.");
    },

    /**
     * The notes each given note was decided against under this decider: the other endpoint of every
     * pair that has a stored direction, in ascending ID order, at most `limit` per note (200 by
     * default). It is a note's decided neighbourhood in the request design of the Decisions API
     * decider (plan decision 30): its own list and the notes whose lists hold it.
     */
    async findDecidedPartners(lookup: {
      deciderKey: string;
      noteIds: readonly string[];
      limit?: number;
    }): Promise<Map<string, string[]>> {
      const partners = new Map<string, string[]>();
      const wanted = new Set(lookup.noteIds);
      if (wanted.size === 0) return partners;
      const limit = lookup.limit ?? 200;
      const result = await db.query<{ loId: string; hiId: string }>(
        `select lo_atomic_note_id as "loId", hi_atomic_note_id as "hiId"
         from relation_decisions
         where decider_key = $1 and score_scale = 'log_odds'
           and (lo_to_hi_score is not null or hi_to_lo_score is not null)
           and (lo_atomic_note_id = any($2::uuid[]) or hi_atomic_note_id = any($2::uuid[]))
         order by pair_key`,
        [lookup.deciderKey, [...wanted]]
      );
      const add = (note: string, partner: string) => {
        const list = partners.get(note) ?? [];
        if (list.length < limit) list.push(partner);
        partners.set(note, list);
      };
      for (const row of result.rows) {
        if (wanted.has(row.loId)) add(row.loId, row.hiId);
        if (wanted.has(row.hiId)) add(row.hiId, row.loId);
      }
      return partners;
    },

    /**
     * Stored ranker scores of these pairs by this decider, keyed by pair key (`lo:hi`), only where
     * both rendered-input hashes still match (D13). Pairs never scored are absent.
     */
    async findRankerScores(lookup: RankerScoresLookup): Promise<Map<string, RankerScores>> {
      const scores = new Map<string, RankerScores>();
      if (!lookup.pairs.length) return scores;
      const wanted = new Map(
        lookup.pairs.map((pair) => [
          relationDecisionPair(pair.loAtomicNoteId, pair.hiAtomicNoteId).key,
          pair
        ])
      );
      const result = await db.query<RelationDecisionRow>(
        `select lo_atomic_note_id as "loId", hi_atomic_note_id as "hiId",
           lo_content_hash as "loHash", hi_content_hash as "hiHash",
           lo_to_hi_score as "loToHiScore", hi_to_lo_score as "hiToLoScore"
         from relation_decisions
         where decider_key = $1 and pair_key = any($2::text[]) and score_scale = 'log_odds'`,
        [lookup.deciderKey, [...wanted.keys()]]
      );
      for (const row of result.rows) {
        const key = `${row.loId}:${row.hiId}`;
        const pair = wanted.get(key);
        if (!pair) continue;
        const [loHash, hiHash] =
          pair.loAtomicNoteId === row.loId
            ? [pair.loInputHash, pair.hiInputHash]
            : [pair.hiInputHash, pair.loInputHash];
        if (row.loHash !== loHash || row.hiHash !== hiHash) continue;
        scores.set(key, {
          loToHi: row.loToHiScore === null ? null : Number(row.loToHiScore),
          hiToLo: row.hiToLoScore === null ? null : Number(row.hiToLoScore)
        });
      }
      return scores;
    }
  };
}
