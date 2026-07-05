import type { QueryResultRow } from "pg";

import { asJsonObject, findById, insertRow, listRows, mapTimestamp, updateRow } from "./sql.js";
import type { JsonObject, Queryable, SourceItemRecord, SourceItemType } from "./types.js";

interface SourceItemRow extends QueryResultRow {
  id: string;
  type: SourceItemType;
  title: string;
  sourceUri: string | null;
  externalId: string | null;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateSourceItemInput {
  type: SourceItemType;
  title: string;
  sourceUri?: string | null;
  externalId?: string | null;
  metadata?: JsonObject;
}

export interface UpdateSourceItemInput {
  type?: SourceItemType;
  title?: string;
  sourceUri?: string | null;
  externalId?: string | null;
  metadata?: JsonObject;
}

const returning = [
  "id",
  "type",
  "title",
  "source_uri as \"sourceUri\"",
  "external_id as \"externalId\"",
  "metadata",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapSourceItem(row: SourceItemRow): SourceItemRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    sourceUri: row.sourceUri,
    externalId: row.externalId,
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
          source_uri: input.sourceUri ?? null,
          external_id: input.externalId ?? null,
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
          source_uri: input.sourceUri,
          external_id: input.externalId,
          metadata: input.metadata
        },
        returning
      );
      return row ? mapSourceItem(row) : null;
    },

    async list(limit?: number): Promise<SourceItemRecord[]> {
      const rows = await listRows<SourceItemRow>(db, "source_items", returning, limit);
      return rows.map(mapSourceItem);
    }
  };
}
