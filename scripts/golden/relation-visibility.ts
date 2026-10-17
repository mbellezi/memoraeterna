/**
 * Which note relations the evaluator counts, as SQL boolean expressions over an
 * `atomic_note_relations` alias. This file is the single swap point of the F3 measurement harness
 * (T43): T48 replaces the bodies with `appliedNoteRelationSql` and `shownNoteRelationSql` of
 * `packages/db/src/repositories/note-relation-sql.ts` (decision D9) and keeps the interface.
 *
 *   shown    what the Note page lists: applied plus suggested (the accept band, decision D23)
 *   applied  what automation applied or the owner kept
 *
 * Until the relations v2 columns exist (`band`, `vetoed_at`) the legacy reading holds: a relation
 * whose status is in the counted list is both shown and applied.
 */

export interface RelationVisibility {
  id: "legacy-status" | "v2-band";
  /** `table.column` names the clause reads; the reader checks they exist before choosing it. */
  requires: readonly string[];
  shown(alias: string): string;
  applied(alias: string): string;
}

export const knownRelationStatuses = ["accepted", "pending_review", "rejected"] as const;

const safeAlias = (alias: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error(`Unsafe SQL alias "${alias}".`);
  return alias;
};

/** The pre-F3 reading: the counted statuses are the whole predicate. */
export function legacyVisibility(statuses: readonly string[]): RelationVisibility {
  const counted = statuses.filter((status): status is (typeof knownRelationStatuses)[number] =>
    (knownRelationStatuses as readonly string[]).includes(status)
  );
  if (counted.length !== statuses.length)
    throw new Error(`Relation statuses must be among ${knownRelationStatuses.join(", ")}.`);
  const clause = (alias: string) =>
    counted.length
      ? `${safeAlias(alias)}.status::text in (${counted.map((status) => `'${status}'`).join(", ")})`
      : "false";
  return { id: "legacy-status", requires: [], shown: clause, applied: clause };
}

/**
 * Decision D9 for databases that have the v2 columns. Applied: a human `accepted`, or a
 * `pending_review` relation that is not vetoed and has band `apply` or no band (legacy rows).
 * Shown: applied, or a `pending_review` relation that is not vetoed with band `suggest`.
 * Endpoint currency is handled by the evaluator's note filter (both notes current).
 */
export function bandVisibility(): RelationVisibility {
  const applied = (alias: string) => {
    const a = safeAlias(alias);
    return `(${a}.status::text = 'accepted' or (${a}.status::text = 'pending_review' and ${a}.vetoed_at is null and (${a}.band = 'apply' or ${a}.band is null)))`;
  };
  const suggested = (alias: string) => {
    const a = safeAlias(alias);
    return `(${a}.status::text = 'pending_review' and ${a}.vetoed_at is null and ${a}.band = 'suggest')`;
  };
  return {
    id: "v2-band",
    requires: ["atomic_note_relations.band", "atomic_note_relations.vetoed_at"],
    shown: (alias) => `(${applied(alias)} or ${suggested(alias)})`,
    applied
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
