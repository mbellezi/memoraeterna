import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable, SourceItemType } from "./types.js";

export interface LibrarySourceRecord {
  id: string;
  parentSourceItemId: string | null;
  structurePosition: number | null;
  childCount: number;
  hasDocument: boolean;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  sourceUri: string | null;
  language: string;
  summary: string | null;
  metadata: JsonObject;
  processingStatus: string;
  currentStage: string;
  updatedAt: Date;
}

interface LibrarySourceRow extends QueryResultRow {
  id: string;
  parentSourceItemId: string | null;
  structurePosition: number | null;
  childCount: number;
  hasDocument: boolean;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  sourceUri: string | null;
  language: string;
  summary: string | null;
  metadata: unknown;
  processingStatus: string;
  currentStage: string;
  updatedAt: unknown;
}

export function createLibraryRepository(db: Queryable) {
  return {
    async listSources(input: { sourceTypes?: SourceItemType[]; limit?: number } = {}): Promise<LibrarySourceRecord[]> {
      const result = await db.query<LibrarySourceRow>(
        `select source.id, source.parent_source_item_id as "parentSourceItemId",
                hierarchy.position as "structurePosition",
                (select count(*)::int from source_items child where child.parent_source_item_id = source.id) as "childCount",
                exists(select 1 from documents document where document.source_item_id = source.id) as "hasDocument",
                source.type, source.title, source.subtitle,
                source.source_uri as "sourceUri", source.language, source.summary,
                source.metadata, coalesce(run.status::text, 'pending') as "processingStatus",
                coalesce(run.current_stage, 'queued') as "currentStage",
                source.updated_at as "updatedAt"
         from source_items source
         left join lateral (
           select status, current_stage from ingestion_runs
           where source_item_id = source.id
           order by created_at desc limit 1
         ) run on true
         left join lateral (
           select division.position
           from document_divisions division
           join document_structures structure on structure.id = division.structure_id
           where division.child_source_item_id = source.id
             and structure.status = 'materialized'
           order by structure.revision desc
           limit 1
         ) hierarchy on true
         where coalesce(array_length($1::source_item_type[], 1), 0) = 0
            or source.type = any($1)
         order by source.updated_at desc
         limit $2`,
        [input.sourceTypes ?? [], input.limit ?? 100]
      );
      return result.rows.map((row) => ({
        ...row,
        metadata: asJsonObject(row.metadata),
        updatedAt: mapTimestamp(row.updatedAt)
      }));
    }
  };
}
