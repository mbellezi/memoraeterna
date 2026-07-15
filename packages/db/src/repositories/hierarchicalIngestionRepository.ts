import { createHash } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import type { PgPool } from "../client.js";
import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { JsonObject, SourceItemType } from "./types.js";

export interface DivisionPersistenceInput {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  level: number;
  position: number;
  startSelector: JsonObject;
  endSelector: JsonObject;
  startPage?: number | undefined;
  endPage?: number | undefined;
  markdownStart?: number | undefined;
  markdownEnd?: number | undefined;
  contentHash?: string | undefined;
  confidence: number;
  evidence: unknown[];
  reviewStatus: "proposed" | "accepted" | "rejected" | "edited";
  isProcessable: boolean;
  metadata: JsonObject;
}

export interface DocumentDivisionRecord extends DivisionPersistenceInput {
  rowId: string;
  structureId: string;
  childSourceItemId: string | null;
  childDocumentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentStructureRecord {
  id: string;
  rootSourceItemId: string;
  rootDocumentId: string;
  format: string;
  detectorVersion: string;
  status: "draft" | "in_review" | "confirmed" | "materialized" | "superseded";
  overallConfidence: number;
  revision: number;
  rawEvidence: JsonObject;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  supersedesStructureId: string | null;
  createdAt: Date;
  updatedAt: Date;
  divisions: DocumentDivisionRecord[];
}

interface StructureRow extends QueryResultRow {
  id: string;
  rootSourceItemId: string;
  rootDocumentId: string;
  format: string;
  detectorVersion: string;
  status: DocumentStructureRecord["status"];
  overallConfidence: number;
  revision: number;
  rawEvidence: unknown;
  confirmedAt: unknown;
  confirmedBy: string | null;
  supersedesStructureId: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

interface DivisionRow extends QueryResultRow {
  id: string;
  rowId: string;
  structureId: string;
  parentId: string | null;
  childSourceItemId: string | null;
  childDocumentId: string | null;
  kind: string;
  title: string;
  level: number;
  position: number;
  startSelector: unknown;
  endSelector: unknown;
  startPage: number | null;
  endPage: number | null;
  markdownStart: number | null;
  markdownEnd: number | null;
  contentHash: string | null;
  confidence: number;
  evidence: unknown;
  reviewStatus: DivisionPersistenceInput["reviewStatus"];
  isProcessable: boolean;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface ProcessingBatchRecord {
  id: string;
  trigger: string;
  requestedPlan: JsonObject;
  effectivePlan: JsonObject;
  reingestionPolicy: string;
  status: string;
  progress: number;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: Date;
  updatedAt: Date;
}

interface BatchRow extends QueryResultRow {
  id: string;
  trigger: string;
  requestedPlan: unknown;
  effectivePlan: unknown;
  reingestionPolicy: string;
  status: string;
  progress: number;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: unknown;
  updatedAt: unknown;
}

const structureColumns = `id, root_source_item_id as "rootSourceItemId", root_document_id as "rootDocumentId",
  format, detector_version as "detectorVersion", status, overall_confidence as "overallConfidence", revision,
  raw_evidence as "rawEvidence", confirmed_at as "confirmedAt", confirmed_by as "confirmedBy",
  supersedes_structure_id as "supersedesStructureId", created_at as "createdAt", updated_at as "updatedAt"`;

const divisionColumns = `division.stable_id as id, division.id as "rowId", division.structure_id as "structureId",
  parent.stable_id as "parentId", division.child_source_item_id as "childSourceItemId",
  division.child_document_id as "childDocumentId", division.kind, division.title, division.level, division.position,
  division.start_selector as "startSelector", division.end_selector as "endSelector",
  division.start_page as "startPage", division.end_page as "endPage",
  division.markdown_start as "markdownStart", division.markdown_end as "markdownEnd",
  division.content_hash as "contentHash", division.confidence, division.evidence,
  division.review_status as "reviewStatus", division.is_processable as "isProcessable", division.metadata,
  division.created_at as "createdAt", division.updated_at as "updatedAt"`;

const batchColumns = `id, trigger, requested_plan as "requestedPlan", effective_plan as "effectivePlan",
  reingestion_policy as "reingestionPolicy", status, progress, total_items as "totalItems",
  completed_items as "completedItems", failed_items as "failedItems", created_at as "createdAt", updated_at as "updatedAt"`;

export function createHierarchicalIngestionRepository(pool: PgPool) {
  return {
    async createDraft(input: {
      rootSourceItemId: string;
      rootDocumentId: string;
      format: string;
      detectorVersion: string;
      overallConfidence: number;
      rawEvidence: JsonObject;
      divisions: DivisionPersistenceInput[];
    }): Promise<DocumentStructureRecord> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const previousResult = await client.query<{ id: string }>(
          `select id from document_structures
           where root_source_item_id = $1 and status in ('confirmed', 'materialized')
           order by revision desc limit 1`,
          [input.rootSourceItemId]
        );
        const previousStructureId = previousResult.rows[0]?.id ?? null;
        await client.query(
          `update document_structures set status = 'superseded', updated_at = now()
           where root_source_item_id = $1 and status in ('draft', 'in_review')`,
          [input.rootSourceItemId]
        );
        const revisionResult = await client.query<{ revision: number }>(
          `select coalesce(max(revision), 0) + 1 as revision from document_structures where root_source_item_id = $1`,
          [input.rootSourceItemId]
        );
        const revision = Number(revisionResult.rows[0]?.revision ?? 1);
        const structureResult = await client.query<StructureRow>(
          `insert into document_structures
             (root_source_item_id, root_document_id, format, detector_version, status, overall_confidence, revision, raw_evidence)
           values ($1, $2, $3, $4, 'in_review', $5, $6, $7::jsonb)
           returning ${structureColumns}`,
          [input.rootSourceItemId, input.rootDocumentId, input.format, input.detectorVersion,
            input.overallConfidence, revision, input.rawEvidence]
        );
        const structure = structureResult.rows[0];
        if (!structure) throw new Error("document_structure_insert_failed");
        await replaceDivisions(client, structure.id, input.divisions);
        if (previousStructureId) {
          await client.query(
            `update document_divisions current set
               child_source_item_id = previous.child_source_item_id,
               child_document_id = previous.child_document_id,
               content_hash = previous.content_hash,
               updated_at = now()
             from document_divisions previous
             where current.structure_id = $1 and previous.structure_id = $2
               and current.stable_id = previous.stable_id`,
            [structure.id, previousStructureId]
          );
        }
        await client.query("commit");
        return (await this.findById(structure.id))!;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async findById(id: string): Promise<DocumentStructureRecord | null> {
      const result = await pool.query<StructureRow>(`select ${structureColumns} from document_structures where id = $1`, [id]);
      const row = result.rows[0];
      if (!row) return null;
      const divisions = await pool.query<DivisionRow>(
        `select ${divisionColumns} from document_divisions division
         left join document_divisions parent on parent.id = division.parent_division_id
         where division.structure_id = $1 order by division.position asc`, [id]
      );
      return mapStructure(row, divisions.rows.map(mapDivision));
    },

    async findCurrentByRoot(rootSourceItemId: string): Promise<DocumentStructureRecord | null> {
      const result = await pool.query<StructureRow>(
        `select ${structureColumns} from document_structures
         where root_source_item_id = $1 and status <> 'superseded' order by revision desc limit 1`,
        [rootSourceItemId]
      );
      const row = result.rows[0];
      return row ? this.findById(row.id) : null;
    },

    async saveDraft(id: string, divisions: DivisionPersistenceInput[]): Promise<DocumentStructureRecord | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const status = await client.query<{ status: string }>("select status from document_structures where id = $1 for update", [id]);
        if (!status.rows[0] || !["draft", "in_review"].includes(status.rows[0].status)) {
          await client.query("rollback");
          return null;
        }
        await client.query("delete from document_divisions where structure_id = $1", [id]);
        await replaceDivisions(client, id, divisions);
        await client.query("update document_structures set status = 'in_review', updated_at = now() where id = $1", [id]);
        await client.query("commit");
        return this.findById(id);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async confirm(id: string, confirmedBy = "local-user"): Promise<DocumentStructureRecord | null> {
      await pool.query(
        `update document_structures set status = 'confirmed', confirmed_at = now(), confirmed_by = $2, updated_at = now()
         where id = $1 and status in ('draft', 'in_review', 'confirmed')`,
        [id, confirmedBy]
      );
      return this.findById(id);
    },

    async markMaterialized(id: string): Promise<void> {
      await pool.query("update document_structures set status = 'materialized', updated_at = now() where id = $1", [id]);
    },

    async materializeStructure(id: string): Promise<Array<{ sourceItemId: string; documentId: string; divisionId: string }>> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const structureResult = await client.query<{
          rootSourceItemId: string;
          rootDocumentId: string;
          rootType: SourceItemType;
          language: string;
          markdown: string;
        }>(
          `select structure.root_source_item_id as "rootSourceItemId", structure.root_document_id as "rootDocumentId",
                  source.type as "rootType", source.language, document.canonical_markdown as markdown
           from document_structures structure
           join source_items source on source.id = structure.root_source_item_id
           join documents document on document.id = structure.root_document_id
           where structure.id = $1 and structure.status in ('confirmed', 'materialized') for update`,
          [id]
        );
        const structure = structureResult.rows[0];
        if (!structure) throw new Error("document_structure_not_confirmed");
        const divisionResult = await client.query<DivisionRow>(
          `select ${divisionColumns} from document_divisions division
           left join document_divisions parent on parent.id = division.parent_division_id
           where division.structure_id = $1 order by division.position asc for update of division`,
          [id]
        );
        const materialized: Array<{ sourceItemId: string; documentId: string; divisionId: string }> = [];
        const sourceByDivision = new Map<string, string>();
        for (const row of divisionResult.rows) {
          const division = mapDivision(row);
          if (!division.isProcessable || division.reviewStatus === "rejected") continue;
          const start = division.markdownStart ?? 0;
          const end = division.markdownEnd ?? structure.markdown.length;
          const markdown = structure.markdown.slice(start, end).trim();
          if (!markdown) continue;
          const contentHash = createHash("sha256").update(markdown).digest("hex");
          const childType = childTypeForRoot(structure.rootType);
          const parentSourceItemId = division.parentId
            ? sourceByDivision.get(division.parentId) ?? structure.rootSourceItemId
            : structure.rootSourceItemId;
          let sourceItemId = division.childSourceItemId;
          if (sourceItemId) {
            await client.query(
              `update source_items set type = $2, title = $3, parent_source_item_id = $4, content_hash = $5,
                 metadata = metadata || $6::jsonb, updated_at = now() where id = $1`,
              [sourceItemId, childType, division.title, parentSourceItemId, contentHash,
                { divisionId: division.id, structureId: id, startPage: division.startPage, endPage: division.endPage }]
            );
          } else {
            const sourceResult = await client.query<{ id: string }>(
              `insert into source_items
                 (type, title, source_origin, parent_source_item_id, content_hash, language, metadata)
               values ($1::source_item_type, $2, 'file_upload', $3, $4, $5, $6::jsonb) returning id`,
              [childType, division.title, parentSourceItemId, contentHash, structure.language,
                { divisionId: division.id, structureId: id, startPage: division.startPage, endPage: division.endPage }]
            );
            sourceItemId = sourceResult.rows[0]?.id ?? null;
          }
          if (!sourceItemId) throw new Error("division_source_materialization_failed");

          let documentId = division.childDocumentId;
          const currentDocument = documentId
            ? await client.query<{ contentHash: string }>("select content_hash as \"contentHash\" from documents where id = $1", [documentId])
            : null;
          if (!documentId || currentDocument?.rows[0]?.contentHash !== contentHash) {
            if (documentId) {
              await client.query("update document_revisions set is_current = false where document_id = $1 and is_current = true", [documentId]);
            }
            const documentResult = await client.query<{ id: string }>(
              `insert into documents (source_item_id, title, canonical_markdown, content_hash, language, metadata)
               values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
              [sourceItemId, division.title, markdown, contentHash, structure.language,
                { derivedFromDocumentId: structure.rootDocumentId, divisionId: division.id, structureId: id,
                  startSelector: division.startSelector, endSelector: division.endSelector }]
            );
            documentId = documentResult.rows[0]?.id ?? null;
            if (!documentId) throw new Error("division_document_materialization_failed");
            const revisionResult = await client.query<{ revision: number }>(
              `select coalesce(max(revision), 0) + 1 as revision from document_revisions
               where document_id in (select id from documents where source_item_id = $1)`,
              [sourceItemId]
            );
            await client.query(
              `insert into document_revisions
                 (document_id, revision, is_current, content_hash, structure_hash, reason, metadata)
               values ($1, $2, true, $3, $4, 'structure_materialization', $5::jsonb)`,
              [documentId, Number(revisionResult.rows[0]?.revision ?? 1), contentHash,
                createHash("sha256").update(`${id}:${division.id}`).digest("hex"), { structureId: id, divisionId: division.id }]
            );
          }
          await client.query(
            `update document_divisions set child_source_item_id = $3, child_document_id = $4,
               content_hash = $5, updated_at = now() where structure_id = $1 and stable_id = $2`,
            [id, division.id, sourceItemId, documentId, contentHash]
          );
          sourceByDivision.set(division.id, sourceItemId);
          materialized.push({ sourceItemId, documentId, divisionId: division.id });
        }
        await client.query("update document_structures set status = 'materialized', updated_at = now() where id = $1", [id]);
        await client.query("commit");
        return materialized;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async linkMaterializedDivision(structureId: string, stableId: string, childSourceItemId: string, childDocumentId: string, contentHash: string): Promise<void> {
      await pool.query(
        `update document_divisions set child_source_item_id = $2, child_document_id = $3, content_hash = $4, updated_at = now()
         where structure_id = $1 and stable_id = $5`,
        [structureId, childSourceItemId, childDocumentId, contentHash, stableId]
      );
    },

    async createBatch(input: {
      trigger: string;
      requestedPlan: JsonObject;
      effectivePlan: JsonObject;
      reingestionPolicy: string;
      targetSourceItemIds: string[];
    }): Promise<ProcessingBatchRecord> {
      const result = await pool.query<BatchRow>(
        `insert into processing_batches
           (trigger, requested_plan, effective_plan, reingestion_policy, total_items, metadata)
         values ($1, $2::jsonb, $3::jsonb, $4, $5, jsonb_build_object('targetSourceItemIds', $6::jsonb))
         returning ${batchColumns}`,
        [input.trigger, input.requestedPlan, input.effectivePlan, input.reingestionPolicy,
          input.targetSourceItemIds.length, JSON.stringify(input.targetSourceItemIds)]
      );
      const row = result.rows[0];
      if (!row) throw new Error("processing_batch_insert_failed");
      return mapBatch(row);
    },

    async listBatches(limit = 100): Promise<ProcessingBatchRecord[]> {
      const result = await pool.query<BatchRow>(`select ${batchColumns} from processing_batches order by created_at desc limit $1`, [limit]);
      return result.rows.map(mapBatch);
    },

    async refreshBatch(batchId: string): Promise<ProcessingBatchRecord | null> {
      const result = await pool.query<BatchRow>(
        `with aggregate as (
           select count(*) filter (where status = 'succeeded')::int as completed,
                  count(*) filter (where status = 'failed')::int as failed,
                  count(*) filter (where status in ('pending', 'running'))::int as active,
                  count(*)::int as total
           from ingestion_runs where batch_id = $1
         )
         update processing_batches batch set
           completed_items = aggregate.completed, failed_items = aggregate.failed,
           progress = case when aggregate.total = 0 then 0 else round((aggregate.completed + aggregate.failed)::numeric / aggregate.total * 10000)::int end,
           status = case
             when aggregate.active > 0 then 'running'::processing_batch_status
             when aggregate.failed > 0 and aggregate.completed > 0 then 'partial'::processing_batch_status
             when aggregate.failed > 0 then 'failed'::processing_batch_status
             when aggregate.total > 0 then 'succeeded'::processing_batch_status
             else 'pending'::processing_batch_status end,
           started_at = coalesce(batch.started_at, now()),
           completed_at = case when aggregate.active = 0 and aggregate.total > 0 then now() else null end,
           updated_at = now()
         from aggregate where batch.id = $1 returning ${batchColumns}`,
        [batchId]
      );
      const row = result.rows[0];
      return row ? mapBatch(row) : null;
    },

    async listDescendants(rootSourceItemId: string): Promise<Array<{ id: string; type: SourceItemType; title: string; parentSourceItemId: string | null }>> {
      const result = await pool.query<{ id: string; type: SourceItemType; title: string; parentSourceItemId: string | null }>(
        `with recursive tree as (
           select id, type, title, parent_source_item_id, 0 as depth from source_items where id = $1
           union all
           select child.id, child.type, child.title, child.parent_source_item_id, tree.depth + 1
           from source_items child join tree on child.parent_source_item_id = tree.id
         )
         select id, type, title, parent_source_item_id as "parentSourceItemId" from tree where depth > 0 order by depth, title`,
        [rootSourceItemId]
      );
      return [...result.rows];
    },

    async getBreadcrumbs(sourceItemIds: string[]): Promise<Map<string, Array<{ id: string; title: string }>>> {
      const breadcrumbs = new Map<string, Array<{ id: string; title: string }>>();
      if (sourceItemIds.length === 0) return breadcrumbs;
      const result = await pool.query<{ originId: string; id: string; title: string; depth: number }>(
        `with recursive ancestors as (
           select source.id as origin_id, source.id, source.title, source.parent_source_item_id, 0 as depth
           from source_items source where source.id = any($1::uuid[])
           union all
           select ancestors.origin_id, parent.id, parent.title, parent.parent_source_item_id, ancestors.depth + 1
           from ancestors join source_items parent on parent.id = ancestors.parent_source_item_id
         )
         select origin_id as "originId", id, title, depth from ancestors order by origin_id, depth desc`,
        [sourceItemIds]
      );
      for (const row of result.rows) {
        breadcrumbs.set(row.originId, [...(breadcrumbs.get(row.originId) ?? []), { id: row.id, title: row.title }]);
      }
      return breadcrumbs;
    },

    async ensureCurrentDocumentRevision(documentId: string, contentHash: string, reason = "initial"): Promise<string> {
      const current = await pool.query<{ id: string }>(
        "select id from document_revisions where document_id = $1 and is_current = true limit 1", [documentId]
      );
      if (current.rows[0]) return current.rows[0].id;
      const result = await pool.query<{ id: string }>(
        `insert into document_revisions (document_id, revision, is_current, content_hash, reason)
         values ($1, 1, true, $2, $3) returning id`,
        [documentId, contentHash, reason]
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("document_revision_insert_failed");
      return id;
    },

    async getArtifactState(sourceItemId: string, documentId: string): Promise<Record<string, boolean>> {
      const result = await pool.query<QueryResultRow & Record<string, boolean>>(
        `select
           true as conversion,
           exists(select 1 from document_divisions division where division.child_document_id = $2) as materialization,
           exists(select 1 from chunks where document_id = $2) as chunking,
           exists(select 1 from embeddings_256 embedding join chunks chunk on chunk.id = embedding.chunk_id where chunk.document_id = $2)
             or exists(select 1 from embeddings_768 embedding join chunks chunk on chunk.id = embedding.chunk_id where chunk.document_id = $2)
             or exists(select 1 from embeddings_1024 embedding join chunks chunk on chunk.id = embedding.chunk_id where chunk.document_id = $2) as embedding,
           exists(select 1 from source_summaries where source_item_id = $1 and is_current = true) as summarization,
           exists(select 1 from atomic_notes where created_from_source_item_id = $1 and supersession_status = 'current') as "atomicNotes",
           exists(select 1 from entity_mentions where source_item_id = $1)
             or exists(select 1 from claims where source_item_id = $1) as "knowledgeGraph",
           exists(select 1 from atomic_note_relations relation
             join atomic_notes note on note.id in (relation.source_atomic_note_id, relation.target_atomic_note_id)
             where note.created_from_source_item_id = $1) as "atomicNoteMatching",
           exists(select 1 from obsidian_sync_files where source_item_id = $1 and status = 'synced') as "obsidianProjection"`,
        [sourceItemId, documentId]
      );
      return result.rows[0] ?? {};
    },

    async createKnowledgeGeneration(input: {
      sourceItemId: string;
      documentRevisionId?: string | null;
      stage: string;
      ingestionRunId?: string | null;
      jobId?: string | null;
      aiTaskRunId?: string | null;
      inputHash?: string | null;
      metadata?: JsonObject;
    }): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `insert into knowledge_generations
           (source_item_id, document_revision_id, stage, ingestion_run_id, job_id, ai_task_run_id, input_hash, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         on conflict (ingestion_run_id, stage) where ingestion_run_id is not null do update
         set ai_task_run_id = coalesce(excluded.ai_task_run_id, knowledge_generations.ai_task_run_id),
             metadata = knowledge_generations.metadata || excluded.metadata, updated_at = now()
         returning id`,
        [input.sourceItemId, input.documentRevisionId ?? null, input.stage, input.ingestionRunId ?? null,
          input.jobId ?? null, input.aiTaskRunId ?? null, input.inputHash ?? null, input.metadata ?? {}]
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("knowledge_generation_insert_failed");
      return id;
    }
  };
}

async function replaceDivisions(client: PoolClient, structureId: string, divisions: DivisionPersistenceInput[]): Promise<void> {
  const pending = [...divisions];
  const inserted = new Map<string, string>();
  while (pending.length > 0) {
    const ready = pending.filter((division) => !division.parentId || inserted.has(division.parentId));
    if (ready.length === 0) throw new Error("document_division_cycle_or_missing_parent");
    for (const division of ready) {
      const result = await client.query<{ id: string }>(
        `insert into document_divisions
           (stable_id, structure_id, parent_division_id, kind, title, level, position, start_selector, end_selector,
            start_page, end_page, markdown_start, markdown_end, content_hash, confidence, evidence, review_status,
            is_processable, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb,
                 $17::document_division_review_status, $18, $19::jsonb) returning id`,
        [division.id, structureId, division.parentId ? inserted.get(division.parentId) : null, division.kind, division.title, division.level, division.position,
          division.startSelector, division.endSelector, division.startPage ?? null, division.endPage ?? null,
          division.markdownStart ?? null, division.markdownEnd ?? null, division.contentHash ?? null,
          division.confidence, division.evidence, division.reviewStatus, division.isProcessable, division.metadata]
      );
      const rowId = result.rows[0]?.id;
      if (!rowId) throw new Error("document_division_insert_failed");
      inserted.set(division.id, rowId);
      pending.splice(pending.indexOf(division), 1);
    }
  }
}

function mapStructure(row: StructureRow, divisions: DocumentDivisionRecord[]): DocumentStructureRecord {
  return {
    ...row,
    overallConfidence: Number(row.overallConfidence),
    revision: Number(row.revision),
    rawEvidence: asJsonObject(row.rawEvidence),
    confirmedAt: mapNullableTimestamp(row.confirmedAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt),
    divisions
  };
}

function mapDivision(row: DivisionRow): DocumentDivisionRecord {
  return {
    id: row.id, rowId: row.rowId, structureId: row.structureId, parentId: row.parentId,
    childSourceItemId: row.childSourceItemId, childDocumentId: row.childDocumentId,
    kind: row.kind, title: row.title, level: Number(row.level), position: Number(row.position),
    startSelector: asJsonObject(row.startSelector), endSelector: asJsonObject(row.endSelector),
    ...(row.startPage === null ? {} : { startPage: Number(row.startPage) }),
    ...(row.endPage === null ? {} : { endPage: Number(row.endPage) }),
    ...(row.markdownStart === null ? {} : { markdownStart: Number(row.markdownStart) }),
    ...(row.markdownEnd === null ? {} : { markdownEnd: Number(row.markdownEnd) }),
    ...(row.contentHash === null ? {} : { contentHash: row.contentHash }),
    confidence: Number(row.confidence), evidence: Array.isArray(row.evidence) ? row.evidence : [],
    reviewStatus: row.reviewStatus, isProcessable: row.isProcessable, metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt), updatedAt: mapTimestamp(row.updatedAt)
  };
}

function mapBatch(row: BatchRow): ProcessingBatchRecord {
  return {
    ...row,
    requestedPlan: asJsonObject(row.requestedPlan), effectivePlan: asJsonObject(row.effectivePlan),
    progress: Number(row.progress) / 10_000, totalItems: Number(row.totalItems),
    completedItems: Number(row.completedItems), failedItems: Number(row.failedItems),
    createdAt: mapTimestamp(row.createdAt), updatedAt: mapTimestamp(row.updatedAt)
  };
}

function childTypeForRoot(rootType: SourceItemType): SourceItemType {
  if (rootType === "Book") return "BookChapter";
  if (rootType === "PeriodicalIssue") return "StandaloneArticle";
  if (rootType === "AcademicPaper") return "DocumentSection";
  return "DocumentSection";
}
