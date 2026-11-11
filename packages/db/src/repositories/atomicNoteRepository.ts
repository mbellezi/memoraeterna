import type { PgClient } from "../client.js";
import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import { createJobRepository } from "./jobRepository.js";
import {
  noteCandidateColumns,
  noteRetrievableIdsStatement,
  noteTextCandidatesStatement,
  noteVectorCandidatesStatement,
  withVectorScanSettings
} from "./noteRetrievalSql.js";
import type {
  NoteRetrievableIdsInput,
  NoteTextCandidatesInput,
  NoteVectorCandidatesInput
} from "./noteRetrievalSql.js";
import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { AtomicNoteRecord, AtomicNoteStatus, JsonObject, Queryable } from "./types.js";

export * from "./noteRetrievalSql.js";

interface AtomicNoteRow extends QueryResultRow {
  id: string;
  generationId: string | null;
  supersessionStatus: string;
  ownership: "source" | "knowledge";
  title: string;
  bodyMarkdown: string;
  ideaStatement: string;
  language: string;
  status: AtomicNoteStatus;
  createdFromSourceItemId: string;
  sourceSpanId: string | null;
  evidenceChunkId: string;
  generationProfileId: string | null;
  aiTaskRunId: string | null;
  generationProvider: string;
  generationModel: string;
  generationRuntime: string;
  generationPromptVersion: string;
  generationKey: string;
  metadata: unknown;
  reviewedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface AtomicNoteCandidateRecord {
  note: AtomicNoteRecord;
  textScore: number;
  vectorScore: number;
  /**
   * Whether the candidate has a vector in the embedding space it was scored in. Set only by
   * `scoreMatchingCandidates`: a candidate without one has a vector score of 0 that means
   * "unknown", not "dissimilar".
   */
  hasVector?: boolean;
}

export interface AtomicNoteGraphInputRecord {
  id: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
  evidenceChunkIds: string[];
}

export interface CreateGeneratedAtomicNoteInput {
  generationId?: string;
  title: string;
  bodyMarkdown: string;
  ideaStatement: string;
  language?: string;
  sourceItemId: string;
  evidenceChunkId: string;
  sourceSpanId?: string | null;
  evidenceLinks: Array<{ chunkId: string; sourceSpanId?: string | null }>;
  generationProfileId?: string | null;
  aiTaskRunId?: string | null;
  generationProvider: string;
  generationModel: string;
  generationRuntime: string;
  generationPromptVersion: string;
  generationKey: string;
  metadata?: JsonObject;
}

const returning = `ownership, id, generation_id as "generationId", supersession_status as "supersessionStatus",
  title, body_markdown as "bodyMarkdown", idea_statement as "ideaStatement",
  language, status, created_from_source_item_id as "createdFromSourceItemId",
  source_span_id as "sourceSpanId", evidence_chunk_id as "evidenceChunkId",
  generation_profile_id as "generationProfileId", ai_task_run_id as "aiTaskRunId",
  generation_provider as "generationProvider", generation_model as "generationModel",
  generation_runtime as "generationRuntime", generation_prompt_version as "generationPromptVersion",
  generation_key as "generationKey", metadata, reviewed_at as "reviewedAt",
  created_at as "createdAt", updated_at as "updatedAt"`;

function mapNote(row: AtomicNoteRow): AtomicNoteRecord {
  return {
    ...row,
    metadata: asJsonObject(row.metadata),
    reviewedAt: mapNullableTimestamp(row.reviewedAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

/** What an upsert did to the note: wrote a new row, rewrote its row, or left a protected row as it was. */
export type GeneratedNoteOutcome = "created" | "updated" | "unchanged";

export function createAtomicNoteRepository(db: Queryable) {
  const upsertGeneratedWithOutcome = async (
    input: CreateGeneratedAtomicNoteInput
  ): Promise<{ note: AtomicNoteRecord; outcome: GeneratedNoteOutcome }> => {
    const connection = await acquireConnection(db);
    try {
      await connection.query("begin");
      const generationId = input.generationId ?? (await ensureLegacyGeneration(connection, input));
      const result = await connection.query<AtomicNoteRow & { inserted?: boolean }>(
        // The status is the column default: a generated note is active at birth. Leaving it out
        // keeps this insert valid on a database that has not reached migration 0045 yet.
        `insert into atomic_notes (
             title, body_markdown, idea_statement, language,
             created_from_source_item_id, source_span_id, evidence_chunk_id,
             generation_profile_id, ai_task_run_id, generation_provider,
             generation_model, generation_runtime, generation_prompt_version,
             generation_key, metadata, generation_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                     $10, $11, $12, $13, $14, $15, $16)
           on conflict (created_from_source_item_id, generation_id, generation_key) do update set
             title = excluded.title,
             body_markdown = excluded.body_markdown,
             idea_statement = excluded.idea_statement,
             language = excluded.language,
             source_span_id = excluded.source_span_id,
             evidence_chunk_id = excluded.evidence_chunk_id,
             generation_profile_id = excluded.generation_profile_id,
             ai_task_run_id = excluded.ai_task_run_id,
             generation_provider = excluded.generation_provider,
             generation_model = excluded.generation_model,
             generation_runtime = excluded.generation_runtime,
             metadata = excluded.metadata,
             updated_at = now()
           where atomic_notes.ownership = 'source'
             and atomic_notes.status::text in ('active', 'pending_review')
             and atomic_notes.metadata->>'humanProtected' is distinct from 'true'
           returning ${returning}, (xmax = 0) as inserted`,
        [
          input.title,
          input.bodyMarkdown,
          input.ideaStatement,
          input.language ?? "und",
          input.sourceItemId,
          input.sourceSpanId ?? null,
          input.evidenceChunkId,
          input.generationProfileId ?? null,
          input.aiTaskRunId ?? null,
          input.generationProvider,
          input.generationModel,
          input.generationRuntime,
          input.generationPromptVersion,
          input.generationKey,
          input.metadata ?? {},
          generationId
        ]
      );
      const written = result.rows[0];
      let row: AtomicNoteRow | undefined = written;
      if (!row) {
        const existing = await connection.query<AtomicNoteRow>(
          `select ${returning} from atomic_notes
             where created_from_source_item_id = $1 and generation_id = $2 and generation_key = $3`,
          [input.sourceItemId, generationId, input.generationKey]
        );
        row = existing.rows[0];
      }
      if (!row) throw new Error("Atomic note upsert returned no row.");
      for (const link of result.rows.length ? input.evidenceLinks : []) {
        await connection.query(
          `insert into atomic_note_source_links (
               atomic_note_id, source_item_id, chunk_id, source_span_id, relation_type, confidence
             ) values ($1, $2, $3, $4, 'derived_from', 1)
             on conflict (atomic_note_id, chunk_id) do update set
               source_span_id = excluded.source_span_id,
               confidence = excluded.confidence`,
          [row.id, input.sourceItemId, link.chunkId, link.sourceSpanId ?? null]
        );
      }
      await connection.query("commit");
      const { inserted, ...columns } = row as AtomicNoteRow & { inserted?: boolean };
      void inserted;
      return {
        note: mapNote(columns),
        outcome: !written ? "unchanged" : written.inserted === false ? "updated" : "created"
      };
    } catch (error) {
      await connection.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      connection.release?.();
    }
  };

  return {
    async upsertGenerated(input: CreateGeneratedAtomicNoteInput): Promise<AtomicNoteRecord> {
      return (await upsertGeneratedWithOutcome(input)).note;
    },

    /** `upsertGenerated`, saying whether the row was inserted, rewritten or left alone (human-protected, approved). */
    upsertGeneratedWithOutcome,

    async findById(id: string): Promise<AtomicNoteRecord | null> {
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes where id = $1`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapNote(row) : null;
    },

    /** The notes of these IDs (any state), in no particular order; an unknown ID is absent. */
    async findManyByIds(ids: readonly string[]): Promise<AtomicNoteRecord[]> {
      if (ids.length === 0) return [];
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes where id = any($1::uuid[])`,
        [[...new Set(ids)]]
      );
      return result.rows.map(mapNote);
    },

    async listBySourceItem(sourceItemId: string): Promise<AtomicNoteRecord[]> {
      const retained =
        (await db.query("select to_regclass('public.atomic_note_evidence') is not null available"))
          .rows[0]?.available === true;
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes
         where (created_from_source_item_id = $1 or exists(select 1 from atomic_note_source_links l where l.atomic_note_id=atomic_notes.id and l.source_item_id=$1) ${retained ? "or exists(select 1 from atomic_note_evidence e where e.note_id=atomic_notes.id and e.source_id=$1)" : ""}) and status <> 'rejected'
         order by created_at`,
        [sourceItemId]
      );
      return result.rows.map(mapNote);
    },

    async listGraphInputsBySourceItem(sourceItemId: string): Promise<AtomicNoteGraphInputRecord[]> {
      const result = await db.query<QueryResultRow & AtomicNoteGraphInputRecord>(
        `select n.id, n.title, n.idea_statement as "ideaStatement", n.body_markdown as "bodyMarkdown",
                array_agg(l.chunk_id::text order by c.chunk_index nulls last, l.chunk_id) as "evidenceChunkIds"
           from atomic_notes n
           join atomic_note_source_links l on l.atomic_note_id = n.id
           left join chunks c on c.id = l.chunk_id
          where n.created_from_source_item_id = $1 and n.status <> 'rejected'
          group by n.id, n.title, n.idea_statement, n.body_markdown, n.created_at
          order by n.created_at, n.title, n.idea_statement, n.id`,
        [sourceItemId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        ideaStatement: row.ideaStatement,
        bodyMarkdown: row.bodyMarkdown,
        evidenceChunkIds: Array.isArray(row.evidenceChunkIds) ? row.evidenceChunkIds : []
      }));
    },

    /** Notes nobody has approved or discarded yet (review is optional, never a gate). */
    async listPending(limit = 100): Promise<AtomicNoteRecord[]> {
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes
         where status in ('active', 'pending_review') order by created_at limit $1`,
        [limit]
      );
      return result.rows.map(mapNote);
    },

    async review(
      input: {
        id: string;
        action: "approve" | "edit" | "discard";
        title?: string | undefined;
        bodyMarkdown?: string | undefined;
        ideaStatement?: string | undefined;
        expectedUpdatedAt?: string | undefined;
      },
      transaction?: PgClient
    ): Promise<AtomicNoteRecord | null> {
      if (
        input.action === "edit" &&
        ((input.title !== undefined && !input.title.trim()) ||
          (input.bodyMarkdown !== undefined && !input.bodyMarkdown.trim()))
      )
        throw new Error("errors.common.validationFailed");
      const connection: Queryable & { release?: () => void } =
        transaction ?? (await acquireConnection(db));
      try {
        if (!transaction) await connection.query("begin");
        const before = await connection.query<AtomicNoteRow>(
          `select ${returning} from atomic_notes where id = $1 for update`,
          [input.id]
        );
        const current = before.rows[0];
        if (!current) {
          if (!transaction) await connection.query("rollback");
          return null;
        }
        if (
          input.expectedUpdatedAt &&
          mapTimestamp(current.updatedAt).toISOString() !== input.expectedUpdatedAt
        )
          throw new Error("sourceWorkspace.conflict");
        const nextStatus: AtomicNoteStatus =
          input.action === "approve"
            ? "approved"
            : input.action === "discard"
              ? "rejected"
              : current.status;
        const updated = await connection.query<AtomicNoteRow>(
          `update atomic_notes set
             title = coalesce($2, title),
             body_markdown = coalesce($3, body_markdown),
             idea_statement = coalesce($4, idea_statement),
             status = $5,
             metadata = case when $6::text = 'edit' then metadata || '{"humanProtected":true,"evidenceReview":"needs_review"}'::jsonb else metadata end,
             reviewed_at = case when $6::text in ('approve', 'discard') then now() else reviewed_at end,
             updated_at = greatest(clock_timestamp(), date_trunc('milliseconds',updated_at)+interval '1 millisecond')
           where id = $1 returning ${returning}`,
          [
            input.id,
            input.title ?? null,
            input.bodyMarkdown ?? null,
            input.ideaStatement ?? null,
            nextStatus,
            input.action
          ]
        );
        await connection.query(
          `insert into atomic_note_review_events (
             atomic_note_id, action, previous_status, next_status, metadata
           ) values ($1, $2, $3, $4, $5)`,
          [
            input.id,
            input.action,
            current.status,
            nextStatus,
            {
              titleChanged: input.title !== undefined,
              bodyChanged: input.bodyMarkdown !== undefined,
              ideaChanged: input.ideaStatement !== undefined
            }
          ]
        );
        if (input.action === "edit") {
          for (const dimensions of [256, 768, 1024])
            await connection.query(
              `delete from embeddings_${dimensions} where target_type='atomic_note' and target_id=$1`,
              [input.id]
            );
          // The embedding is derived from the text: rebuilding it is ordinary background work.
          // Discarded and archived notes never take part in matching, so they are not rebuilt.
          if (nextStatus !== "rejected" && nextStatus !== "archived")
            await createJobRepository(connection).enqueueNoteEmbedding({
              atomicNoteId: input.id,
              sourceItemId: current.createdFromSourceItemId
            });
        }
        if (input.action === "edit")
          await connection.query(
            "insert into atomic_note_revisions(note_id,previous,current) values($1,$2,$3)",
            [input.id, current, updated.rows[0]]
          );
        if (!transaction) await connection.query("commit");
        const row = updated.rows[0];
        return row ? mapNote(row) : null;
      } catch (error) {
        if (!transaction) await connection.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        if (!transaction) connection.release?.();
      }
    },

    async setStatus(id: string, status: AtomicNoteStatus): Promise<AtomicNoteRecord | null> {
      const result = await db.query<AtomicNoteRow>(
        `update atomic_notes set status = $2, updated_at = now()
         where id = $1 returning ${returning}`,
        [id, status]
      );
      const row = result.rows[0];
      return row ? mapNote(row) : null;
    },

    async findTextMatchingCandidates(
      input: NoteTextCandidatesInput
    ): Promise<AtomicNoteCandidateRecord[]> {
      const statement = noteTextCandidatesStatement(input);
      const result = await db.query<AtomicNoteRow & { textScore: number; vectorScore: number }>(
        statement.text,
        statement.values
      );
      return result.rows.map((row) => ({
        note: mapNote(row),
        textScore: Number(row.textScore),
        vectorScore: 0
      }));
    },

    async findVectorMatchingCandidates(
      input: NoteVectorCandidatesInput
    ): Promise<AtomicNoteCandidateRecord[]> {
      const statement = noteVectorCandidatesStatement(input);
      const result = await withVectorScanSettings(db, (connection) =>
        connection.query<AtomicNoteRow & { textScore: number; vectorScore: number }>(
          statement.text,
          statement.values
        )
      );
      return result.rows.map((row) => ({
        note: mapNote(row),
        textScore: 0,
        vectorScore: Number(row.vectorScore)
      }));
    },

    async filterRetrievableCandidateIds(input: NoteRetrievableIdsInput): Promise<Set<string>> {
      if (input.candidateIds.length === 0) return new Set();
      const statement = noteRetrievableIdsStatement(input);
      const result = await db.query<{ id: string }>(statement.text, statement.values);
      return new Set(result.rows.map((row) => row.id));
    },

    async scoreMatchingCandidates(input: {
      noteId: string;
      candidateIds: string[];
      embedding?: number[];
      embeddingModel?: string;
      embeddingSpaceKey?: string | undefined;
      embeddingProvider?: string | undefined;
      embeddingRuntime?: string | undefined;
    }): Promise<AtomicNoteCandidateRecord[]> {
      if (input.candidateIds.length === 0) return [];
      const dimensions = input.embedding?.length;
      if (
        dimensions !== undefined &&
        dimensions !== 256 &&
        dimensions !== 768 &&
        dimensions !== 1_024
      ) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      const vectorJoin = dimensions
        ? `left join embeddings_${dimensions} e
             on e.target_type = 'atomic_note' and e.target_id = candidate.id
            and ($4::text is null or e.model = $4) and e.strategy='native-v2:' || $5::text and e.provider=$6 and e.runtime=$7`
        : "";
      const vectorScore = dimensions
        ? "coalesce(greatest(0, 1 - (e.embedding <=> $3::vector)), 0)"
        : "0::double precision";
      const hasVector = dimensions ? "(e.embedding is not null)" : "false";
      const result = await db.query<
        AtomicNoteRow & { textScore: number; vectorScore: number; hasVector: boolean }
      >(
        `select ${noteCandidateColumns},
                least(1, greatest(
                  similarity(unaccent(candidate.idea_statement), unaccent(source.idea_statement)),
                  similarity(unaccent(candidate.title), unaccent(source.title)),
                  ts_rank_cd(
                    to_tsvector('simple', unaccent(candidate.title || ' ' || candidate.idea_statement || ' ' || candidate.body_markdown)),
                    plainto_tsquery('simple', unaccent(source.idea_statement))
                  )
                )) as "textScore",
                ${vectorScore} as "vectorScore",
                ${hasVector} as "hasVector"
         from atomic_notes source
         join atomic_notes candidate on candidate.id <> source.id and candidate.status <> 'rejected'
         ${vectorJoin}
         where source.id = $1 and candidate.id = any($2::uuid[])`,
        dimensions
          ? [
              input.noteId,
              input.candidateIds,
              `[${input.embedding?.join(",")}]`,
              input.embeddingModel ?? null,
              input.embeddingSpaceKey ?? null,
              input.embeddingProvider ?? null,
              input.embeddingRuntime ?? null
            ]
          : [input.noteId, input.candidateIds]
      );
      return result.rows.map((row) => ({
        note: mapNote(row),
        textScore: Number(row.textScore),
        vectorScore: Number(row.vectorScore),
        hasVector: row.hasVector === true
      }));
    },

    async findMatchingCandidates(input: {
      noteId: string;
      embedding?: number[];
      embeddingModel?: string;
      embeddingSpaceKey?: string | undefined;
      embeddingProvider?: string | undefined;
      embeddingRuntime?: string | undefined;
      limit?: number;
    }): Promise<AtomicNoteCandidateRecord[]> {
      const dimensions = input.embedding?.length;
      if (
        dimensions !== undefined &&
        dimensions !== 256 &&
        dimensions !== 768 &&
        dimensions !== 1_024
      ) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      const vectorJoin = dimensions
        ? `left join embeddings_${dimensions} e
             on e.target_type = 'atomic_note' and e.target_id = candidate.id
            and ($3::text is null or e.model = $3) and e.strategy='native-v2:' || $5::text and e.provider=$6 and e.runtime=$7`
        : "";
      const vectorScore = dimensions
        ? "coalesce(greatest(0, 1 - (e.embedding <=> $2::vector)), 0)"
        : "0::double precision";
      const result = await db.query<AtomicNoteRow & { textScore: number; vectorScore: number }>(
        `select ${noteCandidateColumns},
                least(1, greatest(
                  similarity(unaccent(candidate.idea_statement), unaccent(source.idea_statement)),
                  similarity(unaccent(candidate.title), unaccent(source.title)),
                  ts_rank_cd(
                    to_tsvector('simple', unaccent(candidate.title || ' ' || candidate.idea_statement || ' ' || candidate.body_markdown)),
                    plainto_tsquery('simple', unaccent(source.idea_statement))
                  )
                )) as "textScore",
                ${vectorScore} as "vectorScore"
         from atomic_notes source
         join atomic_notes candidate on candidate.id <> source.id and candidate.status <> 'rejected'
         ${vectorJoin}
         where source.id = $1
         order by ((least(1, greatest(
                    similarity(unaccent(candidate.idea_statement), unaccent(source.idea_statement)),
                    similarity(unaccent(candidate.title), unaccent(source.title))
                  )) * 0.4) + (${vectorScore} * 0.6)) desc,
                  candidate.title, candidate.idea_statement, candidate.id
         limit ${dimensions ? "$4" : "$2"}`,
        dimensions
          ? [
              input.noteId,
              `[${input.embedding?.join(",")}]`,
              input.embeddingModel ?? null,
              input.limit ?? 20,
              input.embeddingSpaceKey ?? null,
              input.embeddingProvider ?? null,
              input.embeddingRuntime ?? null
            ]
          : [input.noteId, input.limit ?? 20]
      );
      return result.rows.map((row) => ({
        note: mapNote(row),
        textScore: Number(row.textScore),
        vectorScore: Number(row.vectorScore)
      }));
    }
  };
}

interface RepositoryConnection extends Queryable {
  release?: () => void;
}

async function ensureLegacyGeneration(
  connection: RepositoryConnection,
  input: CreateGeneratedAtomicNoteInput
): Promise<string> {
  const hash = createHash("sha256")
    .update(`${input.sourceItemId}:atomicNotes:${input.generationPromptVersion}`)
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  await connection.query(
    `insert into knowledge_generations (id, source_item_id, stage, status, metadata)
     values ($1, $2, 'atomicNotes', 'current', jsonb_build_object('legacy', true))
     on conflict (id) do nothing`,
    [id, input.sourceItemId]
  );
  return id;
}

async function acquireConnection(db: Queryable): Promise<RepositoryConnection> {
  if ("connect" in db && typeof db.connect === "function") {
    return await (db.connect as () => Promise<RepositoryConnection>)();
  }
  return db;
}
