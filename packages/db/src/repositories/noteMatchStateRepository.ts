import type { QueryResultRow } from "pg";

import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/**
 * Per-note matching state (F3 D19). After a note is decided, `kthCosine` is the cosine of its k-th
 * vector candidate: a later note includes an earlier note x among its candidates when x is within
 * its 2k nearest and `cos(x, note) >= x.kthCosine` (the reverse-neighbour guard).
 */
export interface NoteMatchState {
  noteId: string;
  deciderKey: string;
  spaceKey: string;
  /** Null when the note had fewer than k vector candidates (every later note is then closer). */
  kthCosine: number | null;
  matchedAt: Date;
}

interface StateRow extends QueryResultRow {
  noteId: string;
  deciderKey: string;
  spaceKey: string;
  kthCosine: number | null;
  matchedAt: unknown;
}

const columns = `note_id as "noteId", decider_key as "deciderKey", space_key as "spaceKey",
  kth_cosine as "kthCosine", matched_at as "matchedAt"`;

const mapState = (row: StateRow): NoteMatchState => ({
  ...row,
  kthCosine: row.kthCosine === null ? null : Number(row.kthCosine),
  matchedAt: mapTimestamp(row.matchedAt)
});

export function createNoteMatchStateRepository(db: Queryable) {
  return {
    /** Records that `noteId` was decided, replacing an earlier state. */
    async record(input: Omit<NoteMatchState, "matchedAt">): Promise<NoteMatchState> {
      if (input.kthCosine !== null && !(input.kthCosine >= -1 && input.kthCosine <= 1))
        throw new Error("A k-th cosine lies between -1 and 1.");
      const row = (
        await db.query<StateRow>(
          `insert into note_match_state (note_id, decider_key, space_key, kth_cosine, matched_at)
           values ($1::uuid, $2, $3, $4, clock_timestamp())
           on conflict (note_id) do update set decider_key = excluded.decider_key,
             space_key = excluded.space_key, kth_cosine = excluded.kth_cosine,
             matched_at = excluded.matched_at
           returning ${columns}`,
          [input.noteId, input.deciderKey, input.spaceKey, input.kthCosine]
        )
      ).rows[0];
      if (!row) throw new Error("Note match state insert returned no row.");
      return mapState(row);
    },

    /** The states of these notes in one embedding space, keyed by note ID (undecided notes absent). */
    async read(noteIds: readonly string[], spaceKey: string): Promise<Map<string, NoteMatchState>> {
      if (!noteIds.length) return new Map();
      const result = await db.query<StateRow>(
        `select ${columns} from note_match_state where note_id = any($1::uuid[]) and space_key = $2`,
        [noteIds, spaceKey]
      );
      return new Map(result.rows.map((row) => [row.noteId, mapState(row)]));
    }
  };
}
