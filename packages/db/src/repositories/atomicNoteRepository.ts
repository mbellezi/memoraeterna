import type { QueryResultRow } from "pg";

import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type {
  AtomicNoteRecord,
  AtomicNoteStatus,
  JsonObject,
  Queryable
} from "./types.js";

interface AtomicNoteRow extends QueryResultRow {
  id: string;
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
}

export interface CreateGeneratedAtomicNoteInput {
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

const returning = `id, title, body_markdown as "bodyMarkdown", idea_statement as "ideaStatement",
  language, status, created_from_source_item_id as "createdFromSourceItemId",
  source_span_id as "sourceSpanId", evidence_chunk_id as "evidenceChunkId",
  generation_profile_id as "generationProfileId", ai_task_run_id as "aiTaskRunId",
  generation_provider as "generationProvider", generation_model as "generationModel",
  generation_runtime as "generationRuntime", generation_prompt_version as "generationPromptVersion",
  generation_key as "generationKey", metadata, reviewed_at as "reviewedAt",
  created_at as "createdAt", updated_at as "updatedAt"`;

const candidateReturning = `candidate.id, candidate.title,
  candidate.body_markdown as "bodyMarkdown", candidate.idea_statement as "ideaStatement",
  candidate.language, candidate.status,
  candidate.created_from_source_item_id as "createdFromSourceItemId",
  candidate.source_span_id as "sourceSpanId", candidate.evidence_chunk_id as "evidenceChunkId",
  candidate.generation_profile_id as "generationProfileId",
  candidate.ai_task_run_id as "aiTaskRunId",
  candidate.generation_provider as "generationProvider",
  candidate.generation_model as "generationModel",
  candidate.generation_runtime as "generationRuntime",
  candidate.generation_prompt_version as "generationPromptVersion",
  candidate.generation_key as "generationKey", candidate.metadata,
  candidate.reviewed_at as "reviewedAt", candidate.created_at as "createdAt",
  candidate.updated_at as "updatedAt"`;

function mapNote(row: AtomicNoteRow): AtomicNoteRecord {
  return {
    ...row,
    metadata: asJsonObject(row.metadata),
    reviewedAt: mapNullableTimestamp(row.reviewedAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createAtomicNoteRepository(db: Queryable) {
  return {
    async upsertGenerated(input: CreateGeneratedAtomicNoteInput): Promise<AtomicNoteRecord> {
      const connection = await acquireConnection(db);
      try {
        await connection.query("begin");
        const result = await connection.query<AtomicNoteRow>(
          `insert into atomic_notes (
             title, body_markdown, idea_statement, language, status,
             created_from_source_item_id, source_span_id, evidence_chunk_id,
             generation_profile_id, ai_task_run_id, generation_provider,
             generation_model, generation_runtime, generation_prompt_version,
             generation_key, metadata
           ) values ($1, $2, $3, $4, 'pending_review', $5, $6, $7, $8, $9,
                     $10, $11, $12, $13, $14, $15)
           on conflict (created_from_source_item_id, generation_key) do update set
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
           where atomic_notes.status = 'pending_review'
           returning ${returning}`,
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
            input.metadata ?? {}
          ]
        );
        let row = result.rows[0];
        if (!row) {
          const existing = await connection.query<AtomicNoteRow>(
            `select ${returning} from atomic_notes
             where created_from_source_item_id = $1 and generation_key = $2`,
            [input.sourceItemId, input.generationKey]
          );
          row = existing.rows[0];
        }
        if (!row) throw new Error("Atomic note upsert returned no row.");
        for (const link of input.evidenceLinks) {
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
        return mapNote(row);
      } catch (error) {
        await connection.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        connection.release?.();
      }
    },

    async findById(id: string): Promise<AtomicNoteRecord | null> {
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes where id = $1`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapNote(row) : null;
    },

    async listBySourceItem(sourceItemId: string): Promise<AtomicNoteRecord[]> {
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes
         where created_from_source_item_id = $1 and status <> 'rejected'
         order by created_at`,
        [sourceItemId]
      );
      return result.rows.map(mapNote);
    },

    async listPending(limit = 100): Promise<AtomicNoteRecord[]> {
      const result = await db.query<AtomicNoteRow>(
        `select ${returning} from atomic_notes
         where status = 'pending_review' order by created_at limit $1`,
        [limit]
      );
      return result.rows.map(mapNote);
    },

    async review(input: {
      id: string;
      action: "approve" | "edit" | "discard";
      title?: string | undefined;
      bodyMarkdown?: string | undefined;
      ideaStatement?: string | undefined;
    }): Promise<AtomicNoteRecord | null> {
      const connection = await acquireConnection(db);
      try {
        await connection.query("begin");
        const before = await connection.query<AtomicNoteRow>(
          `select ${returning} from atomic_notes where id = $1 for update`,
          [input.id]
        );
        const current = before.rows[0];
        if (!current) {
          await connection.query("rollback");
          return null;
        }
        const nextStatus: AtomicNoteStatus = input.action === "approve"
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
             reviewed_at = case when $6::text in ('approve', 'discard') then now() else reviewed_at end,
             updated_at = now()
           where id = $1 returning ${returning}`,
          [input.id, input.title ?? null, input.bodyMarkdown ?? null, input.ideaStatement ?? null, nextStatus, input.action]
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
        await connection.query("commit");
        const row = updated.rows[0];
        return row ? mapNote(row) : null;
      } catch (error) {
        await connection.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        connection.release?.();
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

    async findMatchingCandidates(input: {
      noteId: string;
      embedding?: number[];
      embeddingModel?: string;
      limit?: number;
    }): Promise<AtomicNoteCandidateRecord[]> {
      const dimensions = input.embedding?.length;
      if (dimensions !== undefined && dimensions !== 256 && dimensions !== 768) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      const vectorJoin = dimensions
        ? `left join embeddings_${dimensions} e
             on e.target_type = 'atomic_note' and e.target_id = candidate.id
            and ($3::text is null or e.model = $3)`
        : "";
      const vectorScore = dimensions
        ? "coalesce(greatest(0, 1 - (e.embedding <=> $2::vector)), 0)"
        : "0::double precision";
      const result = await db.query<AtomicNoteRow & { textScore: number; vectorScore: number }>(
        `select ${candidateReturning},
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
                  )) * 0.4) + (${vectorScore} * 0.6)) desc
         limit ${dimensions ? "$4" : "$2"}`,
        dimensions
          ? [input.noteId, `[${input.embedding?.join(",")}]`, input.embeddingModel ?? null, input.limit ?? 20]
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

async function acquireConnection(db: Queryable): Promise<RepositoryConnection> {
  if ("connect" in db && typeof db.connect === "function") {
    return await (db.connect as () => Promise<RepositoryConnection>)();
  }
  return db;
}
