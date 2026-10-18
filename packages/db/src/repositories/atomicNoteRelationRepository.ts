import type { QueryResultRow } from "pg";

import {
  noteRelationPair,
  type NoteRelationBand,
  type NoteRelationDirection,
  type NoteRelationVetoSource
} from "@app/domain";

import {
  appliedNoteRelationSql,
  noteRelationStateLabelSql,
  noteRelationStateSql,
  shownNoteRelationSql,
  type NoteRelationStateLabel
} from "./note-relation-sql.js";
import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type {
  AtomicNoteRelationRecord,
  AtomicNoteRelationStatus,
  JsonObject,
  Queryable
} from "./types.js";

interface AtomicNoteRelationRow extends QueryResultRow {
  id: string;
  sourceAtomicNoteId: string;
  targetAtomicNoteId: string;
  relationType: string | null;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  status: AtomicNoteRelationStatus;
  matchingProfileId: string | null;
  matchingModel: string | null;
  metadata: unknown;
  direction: NoteRelationDirection;
  band: NoteRelationBand | null;
  probability: number | null;
  deciderKey: string | null;
  typerKey: string | null;
  vetoedAt: unknown;
  vetoSource: NoteRelationVetoSource | null;
  createdAt: unknown;
  updatedAt: unknown;
}

const columns = (r: string) => `${r}.id, ${r}.source_atomic_note_id as "sourceAtomicNoteId",
  ${r}.target_atomic_note_id as "targetAtomicNoteId", ${r}.relation_type as "relationType",
  ${r}.vector_score as "vectorScore", ${r}.graph_score as "graphScore",
  ${r}.rerank_score as "rerankScore", ${r}.final_score as "finalScore", ${r}.explanation,
  ${r}.status, ${r}.matching_profile_id as "matchingProfileId", ${r}.matching_model as "matchingModel",
  ${r}.metadata, ${r}.direction, ${r}.band, ${r}.probability, ${r}.decider_key as "deciderKey",
  ${r}.typer_key as "typerKey", ${r}.vetoed_at as "vetoedAt", ${r}.veto_source as "vetoSource",
  ${r}.created_at as "createdAt", ${r}.updated_at as "updatedAt"`;

function mapRelation(row: AtomicNoteRelationRow): AtomicNoteRelationRecord {
  return {
    id: row.id,
    sourceAtomicNoteId: row.sourceAtomicNoteId,
    targetAtomicNoteId: row.targetAtomicNoteId,
    relationType: row.relationType,
    vectorScore: row.vectorScore === null ? null : Number(row.vectorScore),
    graphScore: row.graphScore === null ? null : Number(row.graphScore),
    rerankScore: row.rerankScore === null ? null : Number(row.rerankScore),
    finalScore: Number(row.finalScore),
    explanation: row.explanation,
    status: row.status,
    matchingProfileId: row.matchingProfileId,
    matchingModel: row.matchingModel,
    metadata: asJsonObject(row.metadata),
    direction: row.direction,
    band: row.band,
    probability: row.probability === null ? null : Number(row.probability),
    deciderKey: row.deciderKey,
    typerKey: row.typerKey,
    vetoedAt: mapNullableTimestamp(row.vetoedAt),
    vetoSource: row.vetoSource,
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

/**
 * A decided note pair to store (F3 D8). The pair is canonical: `loAtomicNoteId < hiAtomicNoteId`
 * by UUID, with the direction it reads in (`noteRelationPair` of `@app/domain` builds both from a
 * decided subject and object). No direction is ever written into `metadata`.
 */
export interface NoteRelationUpsert {
  loAtomicNoteId: string;
  hiAtomicNoteId: string;
  direction: Exclude<NoteRelationDirection, "unknown">;
  /** Null for an untyped relations v2 row (D20). */
  relationType: string | null;
  /**
   * Automation's band (D9). Null only for the interim generative matcher's rows, which read as
   * applied like the legacy rows until the relations v2 matcher replaces it.
   */
  band: NoteRelationBand | null;
  probability?: number | null;
  deciderKey?: string | null;
  typerKey?: string | null;
  vectorScore?: number | null;
  graphScore?: number | null;
  rerankScore?: number | null;
  finalScore: number;
  explanation: string;
  matchingProfileId?: string | null;
  matchingModel?: string | null;
  metadata?: JsonObject;
  /**
   * The status of a newly created row (fixtures and verification); never changed on conflict.
   * Human verdicts are written by the review writer.
   */
  status?: AtomicNoteRelationStatus;
  /**
   * The `relation_match_runs` row this write belongs to (D14). A write that changes the row records
   * its one `relation_events` row in the same statement. Required for every banded (relations v2)
   * write; only the interim generative matcher's band-null rows and fixtures omit it, and record no
   * event.
   */
  runId?: string | null;
}

/**
 * What an upsert did. `reviewed`: the pair has a human verdict, which automation never changes
 * (I-R3), so nothing was written. `before` and `after` are the row images (`to_jsonb` of the row)
 * the relation event holds (`before` is null for a creation); `eventId` is that event, null when
 * nothing was written or no run was given.
 */
export interface NoteRelationWriteResult {
  relation: AtomicNoteRelationRecord;
  change: "created" | "updated" | "unchanged" | "reviewed";
  before: JsonObject | null;
  after: JsonObject;
  eventId: string | null;
}

interface WriteRow extends AtomicNoteRelationRow {
  before: unknown;
  after: unknown;
  written: boolean;
  eventId: string | null;
}

/** The pair key of a note relation's events: the canonical pair, as relation decisions key it. */
const eventPairKey = (r: string) =>
  `${r}.source_atomic_note_id::text || ':' || ${r}.target_atomic_note_id::text`;

export const atomicNoteRelationSql = {
  /**
   * $1 lo, $2 hi, then the written columns, $18 the run. On conflict a row without a human verdict
   * takes the new type, direction, band, probability, keys and scores; a reviewed row is left as it
   * is. Nothing is rewritten when every value is unchanged. A written row with a run records one
   * event in the same statement (D14), its kind from the change: a reconcile run's `reconciled`;
   * a creation `untyped` without a type, else `suggested` or `applied` by band; a change of type or
   * direction `typed` (`untyped` when the type is cleared); any other change `suggested` or
   * `applied` by band.
   */
  upsert: `
with prior as (
  select to_jsonb(p) as image from atomic_note_relations p
   where p.source_atomic_note_id = $1::uuid and p.target_atomic_note_id = $2::uuid
),
written as (
  insert into atomic_note_relations as r (
    source_atomic_note_id, target_atomic_note_id, direction, relation_type, band, probability,
    decider_key, typer_key, vector_score, graph_score, rerank_score, final_score, explanation,
    status, matching_profile_id, matching_model, metadata
  ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14::atomic_note_relation_status, $15::uuid, $16, $17::jsonb)
  on conflict (source_atomic_note_id, target_atomic_note_id) do update set
    direction = excluded.direction, relation_type = excluded.relation_type, band = excluded.band,
    probability = excluded.probability, decider_key = excluded.decider_key,
    typer_key = excluded.typer_key, vector_score = excluded.vector_score,
    graph_score = excluded.graph_score, rerank_score = excluded.rerank_score,
    final_score = excluded.final_score, explanation = excluded.explanation,
    matching_profile_id = excluded.matching_profile_id, matching_model = excluded.matching_model,
    metadata = excluded.metadata, updated_at = now()
  where ${noteRelationStateSql.undecidedByHuman("r")}
    and (r.direction, r.relation_type, r.band, r.probability, r.decider_key, r.typer_key,
         r.vector_score, r.graph_score, r.rerank_score, r.final_score, r.explanation,
         r.matching_profile_id, r.matching_model, r.metadata)
        is distinct from
        (excluded.direction, excluded.relation_type, excluded.band, excluded.probability,
         excluded.decider_key, excluded.typer_key, excluded.vector_score, excluded.graph_score,
         excluded.rerank_score, excluded.final_score, excluded.explanation,
         excluded.matching_profile_id, excluded.matching_model, excluded.metadata)
  returning r.*
),
event as (
  insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
  select $18::uuid, 'note', w.id, ${eventPairKey("w")},
         case when run.kind = 'reconcile' then 'reconciled'
              when prior.image is null and w.relation_type is null then 'untyped'
              when prior.image is not null
                and (prior.image->>'relation_type' is distinct from w.relation_type
                     or prior.image->>'direction' <> w.direction)
                then case when w.relation_type is null then 'untyped' else 'typed' end
              when w.band = 'suggest' then 'suggested' else 'applied' end,
         prior.image, to_jsonb(w)
    from written w
    left join prior on true
    left join relation_match_runs run on run.id = $18::uuid
   where $18::uuid is not null
  returning id
),
result as (
  select w.*, true as written, to_jsonb(w) as after from written w
  union all
  select p.*, false, to_jsonb(p) from atomic_note_relations p
   where p.source_atomic_note_id = $1::uuid and p.target_atomic_note_id = $2::uuid
     and not exists (select 1 from written)
)
select ${columns("result")}, result.written, result.after, (select image from prior) as before,
       (select id from event) as "eventId"
  from result`,

  /**
   * $1 relation ID, $2 veto source, $3 the run. Withdraws a relation that has no human verdict and
   * no veto, with its `vetoed` event in the same statement (D14).
   */
  veto: `
with prior as (select to_jsonb(p) as image from atomic_note_relations p where p.id = $1::uuid),
written as (
  update atomic_note_relations r set vetoed_at = clock_timestamp(), veto_source = $2, updated_at = now()
   where r.id = $1::uuid and ${noteRelationStateSql.vetoable("r")}
  returning r.*
),
event as (
  insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
  select $3::uuid, 'note', w.id, ${eventPairKey("w")}, 'vetoed', (select image from prior), to_jsonb(w)
    from written w
  returning id
)
select ${columns("w")}, true as written, to_jsonb(w) as after, (select image from prior) as before,
       (select id from event) as "eventId"
  from written w`,

  /**
   * $1 relation ID, $2 the new status (`accepted` or `rejected`), $3 the run, $4 whether the verdict
   * clears the veto (keep), $5 the event kind (`kept` or `removed`). The owner's verdict on a
   * relation that has none, with its event in the same statement (D14, D15). A relation that
   * already has a human verdict is returned as it is (the first verdict stays final, I-R2, I-R3).
   */
  review: `
with prior as (select to_jsonb(p) as image from atomic_note_relations p where p.id = $1::uuid),
written as (
  update atomic_note_relations r set status = $2::atomic_note_relation_status,
         vetoed_at = case when $4::boolean then null else r.vetoed_at end,
         veto_source = case when $4::boolean then null else r.veto_source end,
         updated_at = now()
   where r.id = $1::uuid and ${noteRelationStateSql.undecidedByHuman("r")}
  returning r.*
),
event as (
  insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
  select $3::uuid, 'note', w.id, ${eventPairKey("w")}, $5, (select image from prior), to_jsonb(w)
    from written w
  returning id
),
result as (
  select w.*, true as written, to_jsonb(w) as after from written w
  union all
  select p.*, false, to_jsonb(p) from atomic_note_relations p
   where p.id = $1::uuid and not exists (select 1 from written)
)
select ${columns("result")}, result.written, result.after, (select image from prior) as before,
       (select id from event) as "eventId"
  from result`
};

function writeResult(row: WriteRow, created: boolean): NoteRelationWriteResult {
  const relation = mapRelation(row);
  const before = row.before === null ? null : asJsonObject(row.before);
  const change = row.written
    ? created
      ? "created"
      : "updated"
    : relation.status === "pending_review"
      ? "unchanged"
      : "reviewed";
  return { relation, change, before, after: asJsonObject(row.after), eventId: row.eventId };
}

export function createAtomicNoteRelationRepository(db: Queryable) {
  const repository = {
    /** The status of the relation that already links `noteId` to each candidate (one row per pair). */
    async pairStatuses(
      noteId: string,
      candidateIds: string[]
    ): Promise<Map<string, AtomicNoteRelationStatus>> {
      if (!candidateIds.length) return new Map();
      const result = await db.query<{ target: string; status: AtomicNoteRelationStatus }>(
        `select case when source_atomic_note_id = $1
        then target_atomic_note_id else source_atomic_note_id end as target, status
        from atomic_note_relations where
          (source_atomic_note_id = $1 and target_atomic_note_id = any($2::uuid[]))
          or (target_atomic_note_id = $1 and source_atomic_note_id = any($2::uuid[]))`,
        [noteId, candidateIds]
      );
      return new Map(result.rows.map((row) => [row.target, row.status]));
    },

    /**
     * Stores a decided pair once (the canonical upsert of F3 D8) and records the matching relation
     * event of its run in the same statement (D14, I-R8). Refuses a self pair, an unsorted pair, an
     * unknown direction (legacy rows only) and a banded write without its run; a pair with a human
     * verdict is never changed.
     */
    async upsert(input: NoteRelationUpsert): Promise<NoteRelationWriteResult> {
      const lo = input.loAtomicNoteId.toLowerCase(),
        hi = input.hiAtomicNoteId.toLowerCase();
      if (lo === hi) throw new Error("Atomic note relation cannot point to itself.");
      if (lo > hi) throw new Error("Atomic note relation pair must be sorted (lo < hi).");
      if ((input.direction as string) === "unknown")
        throw new Error("A new note relation needs a known direction.");
      if (input.band !== null && !input.runId)
        throw new Error("A banded note relation write records its event: it needs its run (D14).");
      const result = await db.query<WriteRow>(atomicNoteRelationSql.upsert, [
        lo,
        hi,
        input.direction,
        input.relationType,
        input.band,
        input.probability ?? null,
        input.deciderKey ?? null,
        input.typerKey ?? null,
        input.vectorScore ?? null,
        input.graphScore ?? null,
        input.rerankScore ?? null,
        input.finalScore,
        input.explanation,
        input.status ?? "pending_review",
        input.matchingProfileId ?? null,
        input.matchingModel ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.runId ?? null
      ]);
      const row = result.rows[0];
      if (!row) throw new Error("Atomic note relation upsert returned no row.");
      return writeResult(row, row.before === null);
    },

    /**
     * `upsert` for a pair decided from `subjectAtomicNoteId` to `objectAtomicNoteId`: the canonical
     * pair and its direction come from `noteRelationPair` (symmetric and untyped types read both
     * ways).
     */
    upsertDecided(
      input: Omit<NoteRelationUpsert, "loAtomicNoteId" | "hiAtomicNoteId" | "direction"> & {
        subjectAtomicNoteId: string;
        objectAtomicNoteId: string;
      }
    ): Promise<NoteRelationWriteResult> {
      const { subjectAtomicNoteId, objectAtomicNoteId, ...rest } = input;
      const pair = noteRelationPair(subjectAtomicNoteId, objectAtomicNoteId, input.relationType);
      return repository.upsert({
        ...rest,
        loAtomicNoteId: pair.lo,
        hiAtomicNoteId: pair.hi,
        direction: pair.direction
      });
    },

    /**
     * Withdraws a relation automatically (D9: `vetoed_at`, `veto_source`) with its `vetoed` event in
     * run `runId` (D14). Resolves to null when the relation is gone, has a human verdict or is
     * already withdrawn: nothing is written then.
     */
    async veto(
      relationId: string,
      source: NoteRelationVetoSource,
      runId: string
    ): Promise<NoteRelationWriteResult | null> {
      if (!runId) throw new Error("A veto records its event: it needs its run (D14).");
      const row = (
        await db.query<WriteRow>(atomicNoteRelationSql.veto, [relationId, source, runId])
      ).rows[0];
      return row ? writeResult(row, false) : null;
    },

    /**
     * Locks a relation's row until the transaction ends (`select ... for update`) and says whether
     * the relation exists. The review's first step: under READ COMMITTED the statement that follows
     * takes its snapshot after the lock, so its before image and the verdict it answers when it
     * writes nothing are the newest committed version of the row, not the one a writer replaced
     * while this one waited (D14, I-R8). It means nothing outside a transaction.
     */
    async lockForReview(relationId: string): Promise<boolean> {
      const result = await db.query(
        "select 1 from atomic_note_relations where id = $1::uuid for update",
        [relationId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * The owner's verdict on a relation (D15): `keep` accepts it and clears any veto, `remove`
     * rejects it. The verdict and its `kept` or `removed` event in run `runId` are one statement
     * (D14). Final in both directions: a relation that already has a human verdict is returned
     * unchanged (`change` is `reviewed`), and automation never changes either verdict. Resolves to
     * null when the relation is gone. Call `lockForReview` first in the same transaction: without
     * the lock a concurrent writer can leave a stale before image and a stale answer.
     */
    async review(
      relationId: string,
      verdict: "keep" | "remove",
      runId: string
    ): Promise<NoteRelationWriteResult | null> {
      if (!runId) throw new Error("A review records its event: it needs its run (D14).");
      const keep = verdict === "keep";
      const row = (
        await db.query<WriteRow>(atomicNoteRelationSql.review, [
          relationId,
          keep ? "accepted" : "rejected",
          runId,
          keep,
          keep ? "kept" : "removed"
        ])
      ).rows[0];
      return row ? writeResult(row, false) : null;
    },

    /**
     * Every relation touching a source's notes, with whether it is shown and applied (D9). The
     * stored endpoints are sorted by ID; `direction` says how the relation reads.
     */
    async listBySourceItem(sourceItemId: string): Promise<
      Array<
        AtomicNoteRelationRecord & {
          sourceStatus: string;
          targetStatus: string;
          sourceTitle: string;
          targetTitle: string;
          shown: boolean;
          applied: boolean;
          /** What the relation is now, from the same predicates (a removed one included). */
          state: NoteRelationStateLabel;
        }
      >
    > {
      const result = await db.query<
        AtomicNoteRelationRow & {
          sourceStatus: string;
          targetStatus: string;
          sourceTitle: string;
          targetTitle: string;
          shown: boolean;
          applied: boolean;
          state: NoteRelationStateLabel;
        }
      >(
        `select ${columns("relation")},
                lo_note.status as "sourceStatus", hi_note.status as "targetStatus",
                lo_note.title as "sourceTitle", hi_note.title as "targetTitle",
                ${shownNoteRelationSql("relation", ["lo_note", "hi_note"])} as shown,
                ${appliedNoteRelationSql("relation", ["lo_note", "hi_note"])} as applied,
                ${noteRelationStateLabelSql("relation")} as state
         from atomic_note_relations relation
         join atomic_notes lo_note on lo_note.id = relation.source_atomic_note_id
         join atomic_notes hi_note on hi_note.id = relation.target_atomic_note_id
         where lo_note.created_from_source_item_id = $1 or hi_note.created_from_source_item_id = $1
         order by relation.final_score desc, relation.id`,
        [sourceItemId]
      );
      return result.rows.map((row) => ({
        ...mapRelation(row),
        sourceStatus: row.sourceStatus,
        targetStatus: row.targetStatus,
        sourceTitle: row.sourceTitle,
        targetTitle: row.targetTitle,
        shown: row.shown,
        applied: row.applied,
        state: row.state
      }));
    }
  };
  return repository;
}
