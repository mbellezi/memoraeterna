/**
 * Which note relations the evaluator counts, as SQL boolean expressions over an
 * `atomic_note_relations` alias. This file is the swap point of the F3 measurement harness (T43);
 * since T48 its bodies are the relations v2 predicates of
 * `packages/db/src/repositories/note-relation-sql.ts` (decision D9), the one place that reads the
 * visibility columns.
 *
 *   shown    what the Note page lists: applied plus suggested (the accept band, decision D23)
 *   applied  what automation applied or the owner kept
 *
 * A library restored from a backup taken before relations v2 has no `band` or `vetoed_at`: the
 * legacy reading holds there, and a relation whose status is in the counted list is both shown and
 * applied. Endpoint currency is the evaluator's note filter (both notes current), so only the state
 * part of each predicate is used here (it also runs on the evaluator's minimal test schemas).
 */
import { legacyCountedNoteRelationSql, noteRelationStateSql, noteRelationStatuses } from "@app/db";

export interface RelationVisibility {
  id: "legacy-status" | "v2-band";
  /** `table.column` names the clause reads; the reader checks they exist before choosing it. */
  requires: readonly string[];
  shown(alias: string): string;
  applied(alias: string): string;
}

export const knownRelationStatuses = noteRelationStatuses;

/** The pre-F3 reading: the counted statuses are the whole predicate. */
export function legacyVisibility(statuses: readonly string[]): RelationVisibility {
  // Refuses unknown statuses now, not at the first query.
  legacyCountedNoteRelationSql("r", statuses);
  const clause = (alias: string) => legacyCountedNoteRelationSql(alias, statuses);
  return { id: "legacy-status", requires: [], shown: clause, applied: clause };
}

/**
 * Decision D9 for databases that have the v2 columns. Applied: a human `accepted`, or a
 * `pending_review` relation that is not vetoed and has band `apply` or no band (legacy rows).
 * Shown: applied, or a `pending_review` relation that is not vetoed with band `suggest`.
 */
export function bandVisibility(): RelationVisibility {
  return {
    id: "v2-band",
    requires: ["atomic_note_relations.band", "atomic_note_relations.vetoed_at"],
    shown: (alias) => noteRelationStateSql.shown(alias),
    applied: (alias) => noteRelationStateSql.applied(alias)
  };
}

/** The v2 reading when the library has the columns, the legacy one otherwise. */
export function chooseVisibility(
  has: (table: string, column: string) => boolean,
  statuses: readonly string[]
): RelationVisibility {
  const v2 = bandVisibility();
  const available = v2.requires.every((entry) => {
    const [table, column] = entry.split(".") as [string, string];
    return has(table, column);
  });
  return available ? v2 : legacyVisibility(statuses);
}
