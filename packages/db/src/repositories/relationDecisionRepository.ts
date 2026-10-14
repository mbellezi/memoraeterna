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
  /** Whether matching accepted the pair when this verdict was recorded. */
  accepted: boolean;
  /** The AI run that produced this direction's verdict; the other direction keeps its own. */
  aiTaskRunId: string | null;
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

export function createRelationDecisionRepository(db: Queryable) {
  return {
    /**
     * Verdicts already recorded for `source -> target` by this decider on the current content of
     * both notes. A verdict for the reverse direction or for older content is not returned.
     */
    async findVerdicts(input: {
      sourceAtomicNoteId: string;
      sourceContentHash: string;
      deciderKey: string;
      targets: ReadonlyArray<{ atomicNoteId: string; contentHash: string }>;
    }): Promise<Map<string, RelationDecisionVerdict>> {
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
         where decider_key = $1 and pair_key = any($2::text[])`,
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
        const score = sourceIsLo ? row.loToHiScore : row.hiToLoScore;
        const relationType = sourceIsLo ? row.loToHiRelationType : row.hiToLoRelationType;
        if (sameContent && score !== null && relationType !== null)
          verdicts.set(target.atomicNoteId, { score: Number(score), relationType });
      }
      return verdicts;
    },

    /**
     * Records one direction with its own AI run and time. The other direction's verdict, run and
     * time are kept while both content hashes are unchanged and discarded when either note changed,
     * so a row never mixes content versions.
     */
    async record(input: RelationDecisionInput): Promise<void> {
      const pair = relationDecisionPair(input.sourceAtomicNoteId, input.targetAtomicNoteId);
      const sourceIsLo = pair.lo === input.sourceAtomicNoteId;
      const verdict = [input.score, input.relationType, input.aiTaskRunId];
      await db.query(
        `insert into relation_decisions as d (
           pair_key, lo_atomic_note_id, hi_atomic_note_id, lo_content_hash, hi_content_hash,
           decider_key, lo_to_hi_score, lo_to_hi_relation_type, lo_to_hi_ai_task_run_id,
           lo_to_hi_decided_at, hi_to_lo_score, hi_to_lo_relation_type, hi_to_lo_ai_task_run_id,
           hi_to_lo_decided_at, relation_type, accepted
         ) values ($1, $2, $3, $4, $5, $6, $7::double precision, $8, $9::uuid,
           case when $7::double precision is not null then now() end,
           $10::double precision, $11, $12::uuid,
           case when $10::double precision is not null then now() end, $13, $14)
         on conflict (pair_key, decider_key) do update set
           ${directionAssignments("lo_to_hi")},
           ${directionAssignments("hi_to_lo")},
           relation_type = case when ${sameContent} and d.accepted
             then d.relation_type else excluded.relation_type end,
           accepted = case when ${sameContent}
             then d.accepted or excluded.accepted else excluded.accepted end,
           lo_content_hash = excluded.lo_content_hash,
           hi_content_hash = excluded.hi_content_hash`,
        [
          pair.key,
          pair.lo,
          pair.hi,
          sourceIsLo ? input.sourceContentHash : input.targetContentHash,
          sourceIsLo ? input.targetContentHash : input.sourceContentHash,
          input.deciderKey,
          ...(sourceIsLo ? verdict : [null, null, null]),
          ...(sourceIsLo ? [null, null, null] : verdict),
          input.accepted ? input.relationType : null,
          input.accepted
        ]
      );
    }
  };
}
