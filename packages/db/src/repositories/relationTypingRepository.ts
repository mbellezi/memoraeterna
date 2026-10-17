import type { QueryResultRow } from "pg";

import type { NoteRelationTyping } from "@app/domain";

import { relationDecisionPair } from "./relationDecisionRepository.js";
import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/**
 * The typer's verdicts (F3 D20) on unordered note pairs, keyed by pair and typer key. A verdict is
 * reused only while both notes' rendered inputs are unchanged; `none` is a veto that keeps its row
 * (no relation is persisted), so neither recalibration nor a later link job asks again.
 */
export interface RelationTypingVerdict {
  pairKey: string;
  typerKey: string;
  loHash: string;
  hiHash: string;
  relationType: NoteRelationTyping;
  /** Null exactly for `none`. */
  direction: "lo_to_hi" | "hi_to_lo" | "symmetric" | null;
  aiTaskRunId: string | null;
  decidedAt: Date;
}

export interface RelationTypingInput {
  loAtomicNoteId: string;
  hiAtomicNoteId: string;
  typerKey: string;
  loHash: string;
  hiHash: string;
  relationType: NoteRelationTyping;
  direction: "lo_to_hi" | "hi_to_lo" | "symmetric" | null;
  aiTaskRunId: string | null;
}

interface TypingRow extends QueryResultRow {
  pairKey: string;
  typerKey: string;
  loHash: string;
  hiHash: string;
  relationType: NoteRelationTyping;
  direction: RelationTypingVerdict["direction"];
  aiTaskRunId: string | null;
  decidedAt: unknown;
}

const columns = `pair_key as "pairKey", typer_key as "typerKey", lo_hash as "loHash",
  hi_hash as "hiHash", relation_type as "relationType", direction, ai_task_run_id as "aiTaskRunId",
  decided_at as "decidedAt"`;

const mapTyping = (row: TypingRow): RelationTypingVerdict => ({
  ...row,
  decidedAt: mapTimestamp(row.decidedAt)
});

export function createRelationTypingRepository(db: Queryable) {
  return {
    /** Records (or replaces) the typer's verdict on a pair; the pair must be canonical. */
    async record(input: RelationTypingInput): Promise<RelationTypingVerdict> {
      const pair = relationDecisionPair(input.loAtomicNoteId, input.hiAtomicNoteId);
      if (pair.lo !== input.loAtomicNoteId)
        throw new Error("A relation typing needs the canonical pair (lo < hi).");
      const row = (
        await db.query<TypingRow>(
          `insert into relation_typings (pair_key, typer_key, lo_hash, hi_hash, relation_type,
             direction, ai_task_run_id, decided_at)
           values ($1, $2, $3, $4, $5, $6, $7::uuid, clock_timestamp())
           on conflict (pair_key, typer_key) do update set
             lo_hash = excluded.lo_hash, hi_hash = excluded.hi_hash,
             relation_type = excluded.relation_type, direction = excluded.direction,
             ai_task_run_id = excluded.ai_task_run_id, decided_at = excluded.decided_at
           returning ${columns}`,
          [
            pair.key,
            input.typerKey,
            input.loHash,
            input.hiHash,
            input.relationType,
            input.direction,
            input.aiTaskRunId
          ]
        )
      ).rows[0];
      if (!row) throw new Error("Relation typing insert returned no row.");
      return mapTyping(row);
    },

    /**
     * Stored verdicts of this typer for these pairs, keyed by pair key, only where both rendered
     * input hashes are unchanged.
     */
    async find(input: {
      typerKey: string;
      pairs: ReadonlyArray<{
        loAtomicNoteId: string;
        hiAtomicNoteId: string;
        loHash: string;
        hiHash: string;
      }>;
    }): Promise<Map<string, RelationTypingVerdict>> {
      const verdicts = new Map<string, RelationTypingVerdict>();
      if (!input.pairs.length) return verdicts;
      const wanted = new Map(
        input.pairs.map((pair) => {
          const canonical = relationDecisionPair(pair.loAtomicNoteId, pair.hiAtomicNoteId);
          const hashes =
            canonical.lo === pair.loAtomicNoteId
              ? { lo: pair.loHash, hi: pair.hiHash }
              : { lo: pair.hiHash, hi: pair.loHash };
          return [canonical.key, hashes] as const;
        })
      );
      const result = await db.query<TypingRow>(
        `select ${columns} from relation_typings where typer_key = $1 and pair_key = any($2::text[])`,
        [input.typerKey, [...wanted.keys()]]
      );
      for (const row of result.rows) {
        const hashes = wanted.get(row.pairKey);
        if (hashes && hashes.lo === row.loHash && hashes.hi === row.hiHash)
          verdicts.set(row.pairKey, mapTyping(row));
      }
      return verdicts;
    }
  };
}
