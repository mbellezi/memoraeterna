import { readFile, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { createKnowledgeGraphRepository, type PgPool } from "@app/db";
import type { StorageSettings } from "../../shared/ipc.js";
import { parseManagedMarkdown } from "./obsidian-projection.js";

interface IdRow {
  id: string;
}

interface AssetPathRow {
  storageBase: string;
  relativePath: string;
}

interface SyncPathRow {
  memoraId: string;
  relativePath: string;
}

export interface SourceDeletionResult {
  deletedSources: number;
  deletedAtomicNotes: number;
  deletedFiles: number;
  failedFiles: number;
  graphCleanupFailed: boolean;
}

export class SourceDeletionService {
  public constructor(private readonly options: {
    getPool: () => PgPool | null;
    getStorageSettings: () => Promise<StorageSettings>;
    userDataPath: string;
    removeGraphProjections?: (sourceItemIds: string[], entityIds: string[]) => Promise<void>;
    logger?: Pick<Console, "warn">;
  }) {}

  public async listSourceTreeIds(sourceItemId: string): Promise<string[]> {
    const result = await this.requirePool().query<IdRow>(sourceTreeQuery, [sourceItemId]);
    return result.rows.map((row) => row.id);
  }

  public async delete(sourceItemId: string): Promise<SourceDeletionResult> {
    const pool = this.requirePool();
    const settings = await this.options.getStorageSettings();
    const client = await pool.connect();
    let sourceItemIds: string[] = [];
    let atomicNoteIds: string[] = [];
    let deletedEntityIds: string[] = [];
    let assetPaths: AssetPathRow[] = [];
    let syncPaths: SyncPathRow[] = [];

    try {
      await client.query("begin");
      sourceItemIds = (await client.query<IdRow>(sourceTreeQuery, [sourceItemId])).rows.map((row) => row.id);
      if (sourceItemIds.length === 0) {
        await client.query("commit");
        return emptyResult();
      }

      const documentIds = (await client.query<IdRow>(
        `select id from documents where source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      )).rows.map((row) => row.id);
      atomicNoteIds = (await client.query<IdRow>(
        `select id from atomic_notes where created_from_source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      )).rows.map((row) => row.id);
      const chunkIds = (await client.query<IdRow>(
        `select id from chunks where source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      )).rows.map((row) => row.id);
      const relatedTargetIds = [...sourceItemIds, ...documentIds, ...atomicNoteIds, ...chunkIds];

      assetPaths = (await client.query<AssetPathRow>(
        `select distinct asset.storage_base as "storageBase", asset.relative_path as "relativePath"
         from document_assets asset
         left join documents document on document.id = asset.document_id
         where (asset.source_item_id = any($1::uuid[]) or document.source_item_id = any($1::uuid[]))
           and not exists (
             select 1 from document_assets other
             left join documents other_document on other_document.id = other.document_id
             where other.storage_base = asset.storage_base and other.relative_path = asset.relative_path
               and not (
                 coalesce(other.source_item_id = any($1::uuid[]), false)
                 or coalesce(other_document.source_item_id = any($1::uuid[]), false)
               )
           )`,
        [sourceItemIds]
      )).rows;
      syncPaths = (await client.query<SyncPathRow>(
        `select memora_id as "memoraId", relative_path as "relativePath"
         from obsidian_sync_files
         where source_item_id = any($1::uuid[])
            or document_id = any($2::uuid[])
            or entity_id = any($3::uuid[])`,
        [sourceItemIds, documentIds, [...sourceItemIds, ...atomicNoteIds]]
      )).rows;

      const ingestionRows = await client.query<{ id: string; jobId: string | null; batchId: string | null }>(
        `select id, job_id as "jobId", batch_id as "batchId"
         from ingestion_runs where source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      );
      const ingestionRunIds = ingestionRows.rows.map((row) => row.id);
      const batchIds = unique(ingestionRows.rows.flatMap((row) => row.batchId ? [row.batchId] : []));
      const jobIds = unique([
        ...ingestionRows.rows.flatMap((row) => row.jobId ? [row.jobId] : []),
        ...(await client.query<IdRow>(
          `select id from jobs where payload->>'sourceItemId' = any($1::text[])`,
          [sourceItemIds]
        )).rows.map((row) => row.id)
      ]);
      const aiTaskRunIds = unique((await client.query<IdRow>(
        `select ai_task_run_id::text as id from source_summaries
           where source_item_id = any($1::uuid[]) and ai_task_run_id is not null
         union select ai_task_run_id::text from atomic_notes
           where created_from_source_item_id = any($1::uuid[]) and ai_task_run_id is not null
         union select ai_task_run_id::text from knowledge_generations
           where source_item_id = any($1::uuid[]) and ai_task_run_id is not null
         union select execution.id
           from source_summaries summary
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(summary.metadata->'aiTaskRunIds') = 'array'
               then summary.metadata->'aiTaskRunIds' else '[]'::jsonb end
           ) execution(id)
           where summary.source_item_id = any($1::uuid[])
         union select execution.id
           from knowledge_generations generation
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(generation.metadata->'aiTaskRunIds') = 'array'
               then generation.metadata->'aiTaskRunIds' else '[]'::jsonb end
           ) execution(id)
           where generation.source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      )).rows.map((row) => row.id).filter(isUuid));
      const workIds = (await client.query<IdRow>(
        `select distinct work_id as id from source_item_bibliographic_links
         where source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      )).rows.map((row) => row.id);
      const instanceIds = (await client.query<IdRow>(
        `select distinct instance_id as id from source_item_bibliographic_links
         where source_item_id = any($1::uuid[]) and instance_id is not null`,
        [sourceItemIds]
      )).rows.map((row) => row.id);
      const debugRunIds = relatedTargetIds.length === 0 ? [] : (await client.query<IdRow>(
        `select distinct run.id
         from similarity_debug_runs run
         left join similarity_debug_results result on result.run_id = run.id
         where run.query_target_id = any($1::uuid[]) or result.target_id = any($1::uuid[])`,
        [relatedTargetIds]
      )).rows.map((row) => row.id);
      const entityIds = (await client.query<IdRow>(
        `select entity_id as id from entity_mentions where source_item_id = any($1::uuid[])
         union select link.entity_id from claim_entity_links link
           join claims claim on claim.id = link.claim_id where claim.source_item_id = any($1::uuid[])
         union select subject_entity_id from entity_relations where source_item_id = any($1::uuid[])
         union select object_entity_id from entity_relations where source_item_id = any($1::uuid[])
         union select link.entity_id from atomic_note_entity_links link
           join atomic_notes note on note.id = link.atomic_note_id
           where note.created_from_source_item_id = any($1::uuid[])`,
        [sourceItemIds]
      )).rows.map((row) => row.id);

      if (debugRunIds.length > 0) {
        await client.query(`delete from similarity_debug_runs where id = any($1::uuid[])`, [debugRunIds]);
      }
      for (const table of ["embeddings_256", "embeddings_768", "embeddings_1024"]) {
        await client.query(`delete from ${table} where target_id = any($1::uuid[])`, [relatedTargetIds]);
      }
      await client.query(
        `delete from obsidian_sync_files
         where source_item_id = any($1::uuid[])
            or document_id = any($2::uuid[])
            or entity_id = any($3::uuid[])`,
        [sourceItemIds, documentIds, [...sourceItemIds, ...atomicNoteIds]]
      );
      if (ingestionRunIds.length > 0) {
        await client.query(`delete from ingestion_runs where id = any($1::uuid[])`, [ingestionRunIds]);
      }
      if (jobIds.length > 0) await client.query(`delete from jobs where id = any($1::uuid[])`, [jobIds]);

      const deletedSources = await client.query(
        `delete from source_items where id = any($1::uuid[])`,
        [sourceItemIds]
      );

      if (aiTaskRunIds.length > 0) {
        await client.query(
          `delete from ai_task_runs run where run.id = any($1::uuid[])
             and not exists (select 1 from source_summaries summary where summary.ai_task_run_id = run.id)
             and not exists (select 1 from atomic_notes note where note.ai_task_run_id = run.id)`,
          [aiTaskRunIds]
        );
      }
      if (batchIds.length > 0) {
        await client.query(
          `delete from processing_batches batch where batch.id = any($1::uuid[])
             and not exists (select 1 from ingestion_runs run where run.batch_id = batch.id)`,
          [batchIds]
        );
      }
      if (instanceIds.length > 0) {
        await client.query(
          `delete from bibliographic_instances instance where instance.id = any($1::uuid[])
             and not exists (select 1 from source_item_bibliographic_links link where link.instance_id = instance.id)`,
          [instanceIds]
        );
      }
      if (workIds.length > 0) {
        await client.query(
          `delete from bibliographic_works work where work.id = any($1::uuid[])
             and not exists (select 1 from source_item_bibliographic_links link where link.work_id = work.id)
             and not exists (select 1 from bibliographic_instances instance where instance.work_id = work.id)`,
          [workIds]
        );
      }
      deletedEntityIds = (await client.query<IdRow>(
        `delete from entities entity
         where entity.id = any($1::uuid[])
           and not exists (select 1 from entity_mentions mention where mention.entity_id = entity.id)
           and not exists (select 1 from claim_entity_links link where link.entity_id = entity.id)
           and not exists (select 1 from atomic_note_entity_links link where link.entity_id = entity.id)
           and not exists (select 1 from entity_relations relation where relation.subject_entity_id = entity.id or relation.object_entity_id = entity.id)
         returning entity.id`,
        [entityIds]
      )).rows.map((row) => row.id);
      await client.query("commit");

      const graphCleanupFailed = await this.removeGraphProjections(pool, sourceItemIds, deletedEntityIds);
      const fileResults = await this.removeFiles(settings, assetPaths, syncPaths);
      return {
        deletedSources: deletedSources.rowCount ?? sourceItemIds.length,
        deletedAtomicNotes: atomicNoteIds.length,
        deletedFiles: fileResults.filter((result) => result.status === "fulfilled").length,
        failedFiles: fileResults.filter((result) => result.status === "rejected").length,
        graphCleanupFailed
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async removeGraphProjections(
    pool: PgPool,
    sourceItemIds: string[],
    entityIds: string[]
  ): Promise<boolean> {
    try {
      await (this.options.removeGraphProjections
        ? this.options.removeGraphProjections(sourceItemIds, entityIds)
        : createKnowledgeGraphRepository(pool).removeSourceProjections(sourceItemIds, entityIds));
      return false;
    } catch (error) {
      this.options.logger?.warn("Source graph projection cleanup failed", error);
      return true;
    }
  }

  private async removeFiles(
    settings: StorageSettings,
    assetPaths: AssetPathRow[],
    syncPaths: SyncPathRow[]
  ): Promise<PromiseSettledResult<void>[]> {
    const targets = new Set<string>();
    const invalidTargets: PromiseRejectedResult[] = [];
    for (const asset of assetPaths) {
      const basePath = asset.storageBase === "app_internal"
        ? join(this.options.userDataPath, "assets")
        : asset.storageBase === "uploaded_files"
          ? settings.uploadCopiesFolderPath
          : null;
      if (basePath) {
        try {
          targets.add(resolveInside(basePath, asset.relativePath));
        } catch (error) {
          invalidTargets.push({ status: "rejected", reason: error });
        }
      }
    }
    if (settings.obsidianVaultPath) {
      const vaultPath = resolve(settings.obsidianVaultPath);
      try {
        const managedPath = resolveInside(vaultPath, settings.managedRoot);
        for (const file of syncPaths) {
          try {
            const target = resolveInside(vaultPath, file.relativePath);
            if (isInside(managedPath, target) && await isOwnedManagedFile(target, file.memoraId)) {
              targets.add(target);
            }
          } catch (error) {
            invalidTargets.push({ status: "rejected", reason: error });
          }
        }
      } catch (error) {
        invalidTargets.push({ status: "rejected", reason: error });
      }
    }
    return [...invalidTargets, ...await Promise.allSettled([...targets].map((path) => rm(path, { force: true })))];
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

const sourceTreeQuery = `with recursive source_tree as (
  select id from source_items where id = $1
  union
  select child.id from source_items child join source_tree parent on child.parent_source_item_id = parent.id
) select id from source_tree`;

function emptyResult(): SourceDeletionResult {
  return {
    deletedSources: 0,
    deletedAtomicNotes: 0,
    deletedFiles: 0,
    failedFiles: 0,
    graphCleanupFailed: false
  };
}

async function isOwnedManagedFile(path: string, memoraId: string): Promise<boolean> {
  try {
    const parsed = parseManagedMarkdown(await readFile(path, "utf8"));
    return parsed?.frontmatter.memoraId === memoraId;
  } catch {
    return false;
  }
}

function resolveInside(basePath: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) throw new Error("errors.common.validationFailed");
  const base = resolve(basePath);
  const target = resolve(base, relativePath);
  if (!isInside(base, target)) throw new Error("errors.common.permissionDenied");
  return target;
}

function isInside(basePath: string, targetPath: string): boolean {
  const fromBase = relative(basePath, targetPath);
  return fromBase !== "" && fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !fromBase.startsWith(sep);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
