import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

export interface BibliographicWorkRecord {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  canonicalTitle: string | null;
  language: string;
  creators: unknown[];
  identifiers: JsonObject;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkRow extends QueryResultRow {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  canonicalTitle: string | null;
  language: string;
  creators: unknown;
  identifiers: unknown;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const workReturning = [
  "id", "type", "title", "subtitle", "canonical_title as \"canonicalTitle\"", "language",
  "creators", "identifiers", "metadata", "created_at as \"createdAt\"", "updated_at as \"updatedAt\""
].join(", ");

const workSelection = [
  "w.id", "w.type", "w.title", "w.subtitle", "w.canonical_title as \"canonicalTitle\"", "w.language",
  "w.creators", "w.identifiers", "w.metadata", "w.created_at as \"createdAt\"", "w.updated_at as \"updatedAt\""
].join(", ");

function mapWork(row: WorkRow): BibliographicWorkRecord {
  return {
    ...row,
    creators: Array.isArray(row.creators) ? row.creators : [],
    identifiers: asJsonObject(row.identifiers),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createBibliographicRepository(db: Queryable) {
  return {
    async createWork(input: {
      type: string;
      title: string;
      subtitle?: string | null;
      canonicalTitle?: string | null;
      language?: string;
      creators?: unknown[];
      identifiers?: JsonObject;
      metadata?: JsonObject;
    }): Promise<BibliographicWorkRecord> {
      const result = await db.query<WorkRow>(
        `insert into bibliographic_works
           (type, title, subtitle, canonical_title, language, creators, identifiers, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${workReturning}`,
        [input.type, input.title, input.subtitle ?? null, input.canonicalTitle ?? null,
          input.language ?? "und", JSON.stringify(input.creators ?? []), input.identifiers ?? {}, input.metadata ?? {}]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Bibliographic work insert returned no row.");
      return mapWork(row);
    },

    async lookup(query: string, limit = 10): Promise<BibliographicWorkRecord[]> {
      const result = await db.query<WorkRow>(
        `select distinct ${workSelection}, similarity(unaccent(w.title), unaccent($1)) as title_similarity
         from bibliographic_works w
         left join bibliographic_instances i on i.work_id = w.id
         where unaccent(w.title) ilike '%' || unaccent($1) || '%'
            or unaccent(coalesce(w.canonical_title, '')) ilike '%' || unaccent($1) || '%'
            or w.identifiers::text ilike '%' || $1 || '%'
            or coalesce(i.isbn, '') ilike '%' || $1 || '%'
            or coalesce(i.issn, '') ilike '%' || $1 || '%'
            or coalesce(i.doi, '') ilike '%' || $1 || '%'
         order by title_similarity desc
         limit $2`,
        [query, limit]
      );
      return result.rows.map(mapWork);
    },

    async createInstance(input: {
      workId: string;
      type: string;
      edition?: string | null;
      volume?: string | null;
      issue?: string | null;
      publicationDate?: string | null;
      publisher?: string | null;
      isbn?: string | null;
      issn?: string | null;
      doi?: string | null;
      creators?: unknown[];
      pageCount?: number | null;
      series?: string | null;
      metadata?: JsonObject;
    }): Promise<string> {
      const result = await db.query<QueryResultRow & { id: string }>(
        `insert into bibliographic_instances
           (work_id, type, edition, volume, issue, publication_date, publisher, isbn, issn, doi,
            creators, page_count, series, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         returning id`,
        [input.workId, input.type, input.edition ?? null, input.volume ?? null, input.issue ?? null,
          input.publicationDate ?? null, input.publisher ?? null, input.isbn ?? null,
          input.issn ?? null, input.doi ?? null, JSON.stringify(input.creators ?? []), input.pageCount ?? null,
          input.series ?? null, input.metadata ?? {}]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Bibliographic instance insert returned no row.");
      return row.id;
    },

    async linkSource(input: {
      sourceItemId: string;
      workId: string;
      instanceId?: string | null;
      relationType?: string;
      pages?: string | null;
    }): Promise<void> {
      await db.query(
        `insert into source_item_bibliographic_links
           (source_item_id, work_id, instance_id, relation_type, pages)
         values ($1, $2, $3, $4, $5)
         on conflict (source_item_id, work_id) do update set
           instance_id = excluded.instance_id,
           relation_type = excluded.relation_type,
           pages = excluded.pages`,
        [input.sourceItemId, input.workId, input.instanceId ?? null,
          input.relationType ?? "instance_of", input.pages ?? null]
      );
    }
  };
}
