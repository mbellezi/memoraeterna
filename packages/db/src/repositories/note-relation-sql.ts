/**
 * Visibility of note relations (F3 decision D9): the one module that reads
 * `atomic_note_relations.status`, `band`, `vetoed_at` and `direction_source` to say what a relation
 * is and which direction it may be shown in (decision 31b). `status` keeps
 * its human meaning (`pending_review` = no human verdict); automation's outcome is the band
 * (`apply`, `suggest`; null on legacy rows) and an automatic veto (`vetoed_at`).
 *
 *   applied     a human `accepted`, or `pending_review`, not vetoed, band `apply` or a legacy null band
 *   suggested   `pending_review`, not vetoed, band `suggest`
 *   shown       applied or suggested (the accept band of D23)
 *   withdrawn   `pending_review` and vetoed (Keep and Remove on the Note page)
 *
 * Each full predicate also requires both endpoints current (not rejected or archived,
 * `supersession_status = current`) with current primary evidence (the note's evidence chunk belongs
 * to a non-superseded document): the rule's "supported by evidence from both endpoints". A fifth,
 * Note-page-only predicate lists applied relations to an earlier version of a note (or to a note
 * whose evidence is gone), never shown, drawn, promoted or counted. `note-relation-visibility.test.ts`
 * forbids any other filter on these columns in repositories, scripts and the main process.
 *
 * Every function returns a SQL expression over trusted aliases (checked here); no input value is
 * ever interpolated.
 */

import { directedNoteRelationTypes } from "@app/domain";

const aliasPattern = /^[a-z_][a-z0-9_]*$/u;

function alias(name: string): string {
  if (!aliasPattern.test(name)) throw new Error(`Unsafe SQL alias "${name}".`);
  return name;
}

/**
 * The state part of each predicate, over a relation alias only. Callers that already require both
 * endpoints current with at least the same conditions (the source-matching joins, the evaluator's
 * note filter) combine these with their own endpoint checks.
 */
export const noteRelationStateSql = {
  applied(relation: string): string {
    const r = alias(relation);
    return `(${r}.status = 'accepted' or (${r}.status = 'pending_review' and ${r}.vetoed_at is null and (${r}.band = 'apply' or ${r}.band is null)))`;
  },
  suggested(relation: string): string {
    const r = alias(relation);
    return `(${r}.status = 'pending_review' and ${r}.vetoed_at is null and ${r}.band = 'suggest')`;
  },
  shown(relation: string): string {
    return `(${noteRelationStateSql.applied(relation)} or ${noteRelationStateSql.suggested(relation)})`;
  },
  withdrawn(relation: string): string {
    const r = alias(relation);
    return `(${r}.status = 'pending_review' and ${r}.vetoed_at is not null)`;
  },
  /** The owner kept it (the review writer, D15): automation never changes it again (I-R3). */
  kept(relation: string): string {
    return `(${alias(relation)}.status = 'accepted')`;
  },
  /** The owner removed it (the review writer, D15): listed nowhere, never made again (I-R3). */
  removed(relation: string): string {
    return `(${alias(relation)}.status = 'rejected')`;
  },
  /** A human verdict (kept or removed): automation never changes the relation again (I-R2, I-R3). */
  reviewed(relation: string): string {
    return `(${alias(relation)}.status <> 'pending_review')`;
  },
  /** No human verdict: automation may still decide, type or band the pair again. */
  undecidedByHuman(relation: string): string {
    return `(${alias(relation)}.status = 'pending_review')`;
  },
  /** No human verdict and no veto yet: an explanation or the typer may withdraw it. */
  vetoable(relation: string): string {
    const r = alias(relation);
    return `(${r}.status = 'pending_review' and ${r}.vetoed_at is null)`;
  }
} as const;

const directedTypesSql = directedNoteRelationTypes.map((type) => `'${type}'`).join(",");

/**
 * The direction a relation may be shown in (plan decision 31b): `lo_to_hi` or `hi_to_lo` for a
 * legacy row (no band; it reads as it was decided) and for a banded one whose direction the owner
 * chose or the Decisions decider gave (`direction_source`); `symmetric` for a type that reads both
 * ways; otherwise `unknown`, which readers show as linked with no arrow, no subject and no verb:
 * the typer's guess from note position, a generative fallback's judged direction, and the owner's
 * "no direction" on a directed type. Every reader of a note relation's direction goes through this
 * expression or `noteRelationSubjectSql`; the raw `direction` is the audit record.
 */
export function noteRelationDirectionSql(relation: string): string {
  const r = alias(relation);
  return `(case when ${r}.band is null then ${r}.direction
               when ${r}.direction in ('lo_to_hi','hi_to_lo')
                 then case when ${r}.direction_source in ('decider','owner') then ${r}.direction else 'unknown' end
               when ${r}.relation_type in (${directedTypesSql}) then 'unknown'
               else ${r}.direction end)`;
}

/** Who gave the direction `noteRelationDirectionSql` shows (`decider` or `owner`), else null. */
export function noteRelationDirectionSourceSql(relation: string): string {
  const r = alias(relation);
  return `(case when ${noteRelationDirectionSql(r)} in ('lo_to_hi','hi_to_lo') then ${r}.direction_source end)`;
}

/**
 * The owner may give this relation a direction on Keep (decision 31b): an automatic (banded)
 * relation of a directed type. Any other relation keeps the direction it has.
 */
export function ownerDirectableNoteRelationSql(relation: string): string {
  const r = alias(relation);
  return `(${r}.band is not null and ${r}.relation_type in (${directedTypesSql}))`;
}

/** The subject note of a relation shown with a direction (`noteRelationDirectionSql`), else null. */
export function noteRelationSubjectSql(relation: string): string {
  const r = alias(relation);
  const shown = noteRelationDirectionSql(r);
  return `(case ${shown} when 'lo_to_hi' then ${r}.source_atomic_note_id
                         when 'hi_to_lo' then ${r}.target_atomic_note_id end)`;
}

/**
 * A note that counts as an endpoint: neither discarded nor archived, the current version, and its
 * primary evidence passage in a document that has not been superseded.
 */
export function currentNoteSql(note: string): string {
  const n = alias(note);
  // Scalar subqueries by primary key: the planner runs them per row on the indexes, where an EXISTS
  // under an OR may be planned as a hash of every chunk and document.
  return `(${n}.status not in ('rejected','archived') and ${n}.supersession_status = 'current'
    and coalesce((select nrv_document.metadata->>'supersededByDocumentId' is null
                    from chunks nrv_chunk join documents nrv_document on nrv_document.id = nrv_chunk.document_id
                   where nrv_chunk.id = ${n}.evidence_chunk_id), false))`;
}

/**
 * An endpoint note the query already joined: the alias of its `atomic_notes` row, or that alias
 * with `current`, a boolean column the query computed once as `currentNoteSql(alias)` (a page's
 * own note, read once for all its relations).
 */
export type NoteEndpoint = string | { alias: string; current: string };

const columnPattern = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/u;

function endpointAlias(endpoint: NoteEndpoint): string {
  return alias(typeof endpoint === "string" ? endpoint : endpoint.alias);
}

function endpointCurrentSql(endpoint: NoteEndpoint): string {
  if (typeof endpoint === "string") return currentNoteSql(endpoint);
  if (!columnPattern.test(endpoint.current))
    throw new Error(`Unsafe SQL column "${endpoint.current}".`);
  alias(endpoint.alias);
  return `(${endpoint.current} is true)`;
}

type Endpoints = readonly [NoteEndpoint, NoteEndpoint];

/**
 * Both endpoints of `relation` are current. Pass the two endpoint notes when the query already
 * joined them (in either order); otherwise each endpoint is looked up by primary key.
 */
export function currentNoteEndpointsSql(relation: string, endpoints?: Endpoints): string {
  if (endpoints)
    return `(${endpointCurrentSql(endpoints[0])} and ${endpointCurrentSql(endpoints[1])})`;
  const r = alias(relation);
  const endpoint = (column: "source_atomic_note_id" | "target_atomic_note_id") =>
    `coalesce((select ${currentNoteSql("nrv_note")} from atomic_notes nrv_note where nrv_note.id = ${r}.${column}), false)`;
  return `(${endpoint("source_atomic_note_id")} and ${endpoint("target_atomic_note_id")})`;
}

/** Applied, between current endpoints (D9). */
export function appliedNoteRelationSql(relation: string, endpoints?: Endpoints): string {
  return `(${noteRelationStateSql.applied(relation)} and ${currentNoteEndpointsSql(relation, endpoints)})`;
}

/** Suggested, between current endpoints (D9). */
export function suggestedNoteRelationSql(relation: string, endpoints?: Endpoints): string {
  return `(${noteRelationStateSql.suggested(relation)} and ${currentNoteEndpointsSql(relation, endpoints)})`;
}

/** Shown (applied or suggested), between current endpoints (D9, D23). */
export function shownNoteRelationSql(relation: string, endpoints?: Endpoints): string {
  return `(${noteRelationStateSql.shown(relation)} and ${currentNoteEndpointsSql(relation, endpoints)})`;
}

/** Withdrawn by an automatic veto and not yet reviewed, between current endpoints (D9, D22). */
export function withdrawnNoteRelationSql(relation: string, endpoints?: Endpoints): string {
  return `(${noteRelationStateSql.withdrawn(relation)} and ${currentNoteEndpointsSql(relation, endpoints)})`;
}

/**
 * Note page only (D9's fifth predicate): an applied relation where an endpoint is not current
 * although neither is discarded or archived: an earlier (superseded) version of a note, or a
 * knowledge-owned note whose primary evidence is gone with its source. The page keeps listing it
 * as F1b did (the other note carries its `superseded` flag); it is never shown, drawn, promoted or
 * counted. `self` and `other` are the two endpoint notes.
 */
export function earlierVersionNoteRelationSql(
  relation: string,
  self: NoteEndpoint,
  other: NoteEndpoint
): string {
  const [s, o] = [endpointAlias(self), endpointAlias(other)];
  return `(${noteRelationStateSql.applied(relation)}
    and ${s}.status not in ('rejected','archived') and ${o}.status not in ('rejected','archived')
    and not (${endpointCurrentSql(self)} and ${endpointCurrentSql(other)}))`;
}

export type NoteRelationStateLabel = "kept" | "withdrawn" | "suggested" | "removed" | "applied";

/**
 * What a relation is now, as text: `kept` (the owner kept it), `withdrawn` (an automatic veto is not
 * yet reviewed), `suggested` (the suggest band), `removed` (the owner removed it) or `applied` (the
 * rest, legacy rows included). Total over the stored states, so a caller that does not filter on
 * the visibility predicates first never reads a removed relation as applied.
 */
export function noteRelationStateLabelSql(relation: string): string {
  return `(case when ${noteRelationStateSql.kept(relation)} then 'kept'
               when ${noteRelationStateSql.withdrawn(relation)} then 'withdrawn'
               when ${noteRelationStateSql.suggested(relation)} then 'suggested'
               when ${noteRelationStateSql.removed(relation)} then 'removed'
               else 'applied' end)`;
}

export const noteRelationStatuses = ["accepted", "pending_review", "rejected"] as const;

/**
 * The pre-F3 reading, for libraries restored from a backup without the v2 columns: a relation
 * whose status is among `statuses` counts (the evaluator's `--statuses`).
 */
export function legacyCountedNoteRelationSql(
  relation: string,
  statuses: readonly string[]
): string {
  const r = alias(relation);
  const counted = statuses.filter((status): status is (typeof noteRelationStatuses)[number] =>
    (noteRelationStatuses as readonly string[]).includes(status)
  );
  if (counted.length !== statuses.length)
    throw new Error(`Relation statuses must be among ${noteRelationStatuses.join(", ")}.`);
  return counted.length
    ? `${r}.status::text in (${counted.map((status) => `'${status}'`).join(", ")})`
    : "false";
}
