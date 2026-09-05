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
    async listSources(input: { sourceTypes?: SourceItemType[] | undefined; limit?: number | undefined; offset?: number | undefined; query?: string | undefined; parentId?: string | null | undefined; ids?: string[] | undefined } = {}): Promise<LibrarySourceRecord[]> {
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
         where (coalesce(array_length($1::source_item_type[], 1), 0) = 0 or source.type = any($1))
           and ($3 = '' or strpos(unaccent(lower(concat_ws(' ', source.title, source.subtitle, source.source_uri, source.metadata->'descriptor'))), unaccent(lower($3))) > 0)
           and (not $4::boolean or source.parent_source_item_id is not distinct from $5::uuid)
           and ($7::uuid[] is null or source.id = any($7))
         order by hierarchy.position nulls last, case when source.parent_source_item_id is not null then source.created_at end asc, source.updated_at desc, source.id
         limit $2 offset $6`,
        [input.sourceTypes ?? [], input.limit ?? 100, input.query ?? "", input.parentId !== undefined, input.parentId ?? null, input.offset ?? 0, input.ids ?? null]
      );
      return result.rows.map((row) => ({
        ...row,
        metadata: asJsonObject(row.metadata),
        updatedAt: mapTimestamp(row.updatedAt)
      }));
    }
  };
}
