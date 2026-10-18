import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

import {
  relationExplanationOrder,
  type AtomicNoteStatus,
  type RelationExplanationDirection
} from "@app/domain";

import {
  earlierVersionNoteRelationSql,
  noteRelationStateSql,
  shownNoteRelationSql,
  withdrawnNoteRelationSql
} from "./note-relation-sql.js";
import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/**
 * Explanations of note relations written on demand (docs/plan.md decision 16), cached beside the
 * relation with their provenance and the key of the inputs they were written from. A cached
 * explanation whose inputs changed is stale: it is rewritten the next time the relation is opened.
 *
 * The key (F3 D22) is the hash of the facts the text says (both ideas and evidence passages, type,
 * direction, content language), a dot, and the hash of the writer (the effective prompt revision and
 * the model identity). A reader that does not know the writer matches on the facts alone.
 */
export const relationExplanationInputVersion = "relation-explanation-input-v3";

/** Who writes an explanation: the effective `relations.explain` prompt and the writer model. */
export interface RelationExplanationWriter {
  /** The identity of the effective prompt: its text, as shipped or edited by the owner. */
  promptRevision: string;
  /** The model identity: provider, model, runtime and, for a local model, its artifact. */
  model: string;
}

/** The part of the key that says who wrote the explanation. */
export function relationExplanationWriterHash(writer: RelationExplanationWriter): string {
  return createHash("sha256")
    .update(JSON.stringify([writer.promptRevision, writer.model]))
    .digest("hex")
    .slice(0, 16);
}

export interface RelationExplanationInputs {
  type: string;
  direction: RelationExplanationDirection;
  /** The content language the text is written in: another language is another explanation. */
  language: string;
  first: { ideaStatement: string; passageHash: string | null };
  second: { ideaStatement: string; passageHash: string | null };
}

/**
 * What the text of an explanation says: both ideas and evidence passages, the type, the direction
 * and the content language it is written in.
 */
export function relationExplanationInputHash(input: RelationExplanationInputs): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        relationExplanationInputVersion,
        input.type,
        input.direction,
        input.language,
        input.first.ideaStatement,
        input.first.passageHash,
        input.second.ideaStatement,
        input.second.passageHash
      ])
    )
    .digest("hex");
}

export interface RelationExplanationNote {
  id: string;
  title: string;
  ideaStatement: string;
  status: AtomicNoteStatus;
  language: string | null;
  /** The source the note was generated from; null when that source was deleted. */
  homeSourceId: string | null;
  /** The note's primary evidence passage; null when its chunk is gone. */
  passage: { chunkId: string; content: string; contentHash: string } | null;
}

export interface StoredRelationExplanation {
  text: string;
  inputHash: string;
  model: string;
  writtenAt: Date;
}

export interface RelationExplanationContext {
  relationId: string;
  type: string;
  status: string;
  /** The decided subject of a directed relation, from its stored direction; null otherwise. */
  semanticSourceId: string | null;
  /** The Note page lists the relation (D9): only a listed relation is explained. */
  listed: boolean;
  /** No human verdict and no veto yet: an explanation that finds the notes unrelated may withdraw it. */
  vetoable: boolean;
  /** Withdrawn by a veto and not yet reviewed (D9). */
  withdrawn: boolean;
  /** What withdrew it (`explainer` or `typer`); null when not vetoed. */
  vetoSource: string | null;
  a: RelationExplanationNote;
  b: RelationExplanationNote;
  stored: StoredRelationExplanation | null;
}

/** The notes in prompt order with the direction, and the hash of what the explanation depends on. */
export function relationExplanationPlan<
  T extends {
    id: string;
    title: string;
    ideaStatement: string;
    passage: { contentHash: string } | null;
  }
>(context: {
  type: string;
  semanticSourceId: string | null | undefined;
  /** The content language the explanation is (to be) written in. */
  language: string;
  /** Who writes it; absent when the caller does not know (a reader that matches on the facts). */
  writer?: RelationExplanationWriter | null | undefined;
  a: T;
  b: T;
}) {
  const order = relationExplanationOrder(context);
  const factsHash = relationExplanationInputHash({
    type: context.type,
    direction: order.direction,
    language: context.language,
    first: {
      ideaStatement: order.first.ideaStatement,
      passageHash: order.first.passage?.contentHash ?? null
    },
    second: {
      ideaStatement: order.second.ideaStatement,
      passageHash: order.second.passage?.contentHash ?? null
    }
  });
  const inputHash = context.writer
    ? `${factsHash}.${relationExplanationWriterHash(context.writer)}`
    : factsHash;
  return {
    ...order,
    factsHash,
    /** The key a written explanation is stored under (the facts alone without a writer). */
    inputHash,
    /** Whether the key names the writer: a reader without one matches on the facts alone. */
    writerKnown: Boolean(context.writer)
  };
}

/**
 * Whether a stored key is current for a plan: the same facts and, when the plan knows its writer,
 * the same writer. Without a writer, an explanation of the same facts counts whoever wrote it.
 */
export function relationExplanationIsCurrent(
  storedKey: string,
  plan: { factsHash: string; inputHash: string; writerKnown: boolean }
): boolean {
  return plan.writerKnown
    ? storedKey === plan.inputHash
    : storedKey === plan.factsHash || storedKey.startsWith(`${plan.factsHash}.`);
}

interface ContextRow extends QueryResultRow {
  relationId: string;
  type: string;
  status: string;
  semanticSourceId: string | null;
  listed: boolean;
  vetoable: boolean;
  withdrawn: boolean;
  vetoSource: string | null;
  a: RelationExplanationNote;
  b: RelationExplanationNote;
  stored: { text: string; inputHash: string; model: string; writtenAt: string } | null;
}

const noteJson = (alias: string, chunk: string) => `jsonb_build_object(
    'id', ${alias}.id, 'title', ${alias}.title, 'ideaStatement', ${alias}.idea_statement,
    'status', ${alias}.status, 'language', nullif(${alias}.language, 'und'),
    'homeSourceId', (select s.id from source_items s where s.id = ${alias}.created_from_source_item_id),
    'passage', case when ${chunk}.id is null then null else jsonb_build_object(
      'chunkId', ${chunk}.id, 'content', ${chunk}.content, 'contentHash', ${chunk}.content_hash) end)`;

/**
 * $1 relation ID. One row by primary keys: the relation, both notes, their passages and the cache.
 * The subject of a directed relation comes from its stored direction (F3 D8); an untyped relation
 * reads as neutral. `listed`: the Note page lists the relation (shown, withdrawn, or to an earlier
 * version of a note), which is what may be explained.
 */
const contextSql = `
select r.id as "relationId", coalesce(r.relation_type, 'related') as type, r.status::text as status,
       (case r.direction when 'lo_to_hi' then r.source_atomic_note_id
                         when 'hi_to_lo' then r.target_atomic_note_id end)::text as "semanticSourceId",
       (${shownNoteRelationSql("r", ["a", "b"])} or ${withdrawnNoteRelationSql("r", ["a", "b"])}
        or ${earlierVersionNoteRelationSql("r", "a", "b")}) as listed,
       ${noteRelationStateSql.vetoable("r")} as vetoable,
       ${withdrawnNoteRelationSql("r", ["a", "b"])} as withdrawn, r.veto_source as "vetoSource",
       ${noteJson("a", "ac")} as a, ${noteJson("b", "bc")} as b,
       case when x.relation_id is null then null else jsonb_build_object(
         'text', x.text, 'inputHash', x.input_hash, 'model', x.model, 'writtenAt', x.written_at) end as stored
  from atomic_note_relations r
  join atomic_notes a on a.id = r.source_atomic_note_id
  join atomic_notes b on b.id = r.target_atomic_note_id
  left join chunks ac on ac.id = a.evidence_chunk_id
  left join chunks bc on bc.id = b.evidence_chunk_id
  left join atomic_note_relation_explanations x on x.relation_id = r.id
 where r.id = $1::uuid`;

const saveSql = `
insert into atomic_note_relation_explanations
  (relation_id, text, input_hash, prompt_version, provider, model, runtime, ai_task_run_id, language, written_at)
select $1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, clock_timestamp()
 where exists (select 1 from atomic_note_relations where id = $1::uuid)
on conflict (relation_id) do update set
  text = excluded.text, input_hash = excluded.input_hash, prompt_version = excluded.prompt_version,
  provider = excluded.provider, model = excluded.model, runtime = excluded.runtime,
  ai_task_run_id = excluded.ai_task_run_id, language = excluded.language, written_at = excluded.written_at
returning written_at as "writtenAt"`;

export interface SaveRelationExplanationInput {
  relationId: string;
  text: string;
  inputHash: string;
  promptVersion: string;
  provider: string;
  model: string;
  runtime: string;
  aiTaskRunId: string | null;
  language: string;
}

export function createRelationExplanationRepository(db: Queryable) {
  return {
    /** Everything an explanation is written from; null when the relation does not exist. */
    async readContext(relationId: string): Promise<RelationExplanationContext | null> {
      const row = (await db.query<ContextRow>(contextSql, [relationId])).rows[0];
      if (!row) return null;
      return {
        relationId: row.relationId,
        type: row.type,
        status: row.status,
        semanticSourceId: row.semanticSourceId,
        listed: row.listed,
        vetoable: row.vetoable,
        withdrawn: row.withdrawn,
        vetoSource: row.vetoSource,
        a: row.a,
        b: row.b,
        stored: row.stored
          ? {
              text: row.stored.text,
              inputHash: row.stored.inputHash,
              model: row.stored.model,
              writtenAt: mapTimestamp(row.stored.writtenAt)
            }
          : null
      };
    },

    /**
     * Caches an explanation for the inputs it was written from, replacing an earlier one. Resolves
     * to null when the relation was removed meanwhile (nothing is stored).
     */
    async save(input: SaveRelationExplanationInput): Promise<{ writtenAt: Date } | null> {
      const row = (
        await db.query<{ writtenAt: Date | string }>(saveSql, [
          input.relationId,
          input.text,
          input.inputHash,
          input.promptVersion,
          input.provider,
          input.model,
          input.runtime,
          input.aiTaskRunId,
          input.language
        ])
      ).rows[0];
      return row ? { writtenAt: mapTimestamp(row.writtenAt) } : null;
    },

    statements: { context: contextSql, save: saveSql }
  };
}
