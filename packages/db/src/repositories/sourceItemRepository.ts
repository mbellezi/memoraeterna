import type { QueryResultRow } from "pg";

import { asJsonObject, findById, insertRow, listRows, mapTimestamp, updateRow } from "./sql.js";
import type { JsonObject, Queryable, SourceItemRecord, SourceItemType } from "./types.js";

interface SourceItemRow extends QueryResultRow {
  id: string;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  sourceOrigin: string;
  sourceUri: string | null;
  externalId: string | null;
  parentSourceItemId: string | null;
  contentHash: string | null;
  language: string;
  summary: string | null;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateSourceItemInput {
  type: SourceItemType;
  title: string;
  subtitle?: string | null;
  sourceOrigin?: string;
  sourceUri?: string | null;
  externalId?: string | null;
  parentSourceItemId?: string | null;
  contentHash?: string | null;
  language?: string;
  metadata?: JsonObject;
}

export interface UpdateSourceItemInput {
  type?: SourceItemType;
  title?: string;
  subtitle?: string | null;
  sourceOrigin?: string;
  sourceUri?: string | null;
  externalId?: string | null;
  parentSourceItemId?: string | null;
  contentHash?: string | null;
  language?: string;
  summary?: string | null;
  metadata?: JsonObject;
}

const returning = [
  "id",
  "type",
  "title",
  "subtitle",
  "source_origin as \"sourceOrigin\"",
  "source_uri as \"sourceUri\"",
  "external_id as \"externalId\"",
  "parent_source_item_id as \"parentSourceItemId\"",
  "content_hash as \"contentHash\"",
  "language",
  "summary",
  "metadata",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapSourceItem(row: SourceItemRow): SourceItemRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    sourceOrigin: row.sourceOrigin,
    sourceUri: row.sourceUri,
    externalId: row.externalId,
    parentSourceItemId: row.parentSourceItemId,
    contentHash: row.contentHash,
    language: row.language,
    summary: row.summary,
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createSourceItemRepository(db: Queryable) {
  return {
    async create(input: CreateSourceItemInput): Promise<SourceItemRecord> {
      const row = await insertRow<SourceItemRow>(
        db,
        "source_items",
        {
          type: input.type,
          title: input.title,
          subtitle: input.subtitle ?? null,
          source_origin: input.sourceOrigin ?? "manual",
          source_uri: input.sourceUri ?? null,
          external_id: input.externalId ?? null,
          parent_source_item_id: input.parentSourceItemId ?? null,
          content_hash: input.contentHash ?? null,
          language: input.language ?? "und",
          metadata: input.metadata ?? {}
        },
        returning
      );
      return mapSourceItem(row);
    },

    async findById(id: string): Promise<SourceItemRecord | null> {
      const row = await findById<SourceItemRow>(db, "source_items", id, returning);
      return row ? mapSourceItem(row) : null;
    },

    async update(id: string, input: UpdateSourceItemInput): Promise<SourceItemRecord | null> {
      const row = await updateRow<SourceItemRow>(
        db,
        "source_items",
        id,
        {
          type: input.type,
          title: input.title,
          subtitle: input.subtitle,
          source_origin: input.sourceOrigin,
          source_uri: input.sourceUri,
          external_id: input.externalId,
          parent_source_item_id: input.parentSourceItemId,
          content_hash: input.contentHash,
          language: input.language,
          summary: input.summary,
          metadata: input.metadata
        },
        returning
      );
      return row ? mapSourceItem(row) : null;
    },

    async list(limit?: number): Promise<SourceItemRecord[]> {
      const rows = await listRows<SourceItemRow>(db, "source_items", returning, limit);
      return rows.map(mapSourceItem);
    },

    async findDuplicate(input: { sourceUri?: string | null; contentHash?: string | null }): Promise<SourceItemRecord | null> {
      if (!input.sourceUri && !input.contentHash) {
        return null;
      }
      const result = await db.query<SourceItemRow>(
        `select ${returning}
         from source_items
         where ($1::text is not null and source_uri = $1)
            or ($2::text is not null and content_hash = $2)
         order by updated_at desc
         limit 1`,
        [input.sourceUri ?? null, input.contentHash ?? null]
      );
      const row = result.rows[0];
      return row ? mapSourceItem(row) : null;
    },

    async lookup(query: string, limit = 10): Promise<SourceItemRecord[]> {
      const result = await db.query<SourceItemRow>(
        `select ${returning}
         from source_items
         where unaccent(title) ilike '%' || unaccent($1) || '%'
            or source_uri ilike '%' || $1 || '%'
            or external_id ilike '%' || $1 || '%'
            or metadata::text ilike '%' || $1 || '%'
         order by similarity(unaccent(title), unaccent($1)) desc, updated_at desc
         limit $2`,
        [query, limit]
      );
      return result.rows.map(mapSourceItem);
    }
  };
}
