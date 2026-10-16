import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

export interface SourceScopeQuery {
  text: string;
  /** Sources the search is limited to; empty means the whole library. */
  sourceIds: readonly string[];
  includeDescendants: boolean;
  limit: number;
  offset: number;
}

export interface SourceScopeResult extends QueryResultRow {
  id: string;
  kind: "source";
  title: string;
  excerpt: string;
  sourceItemId: string;
  sourceType: string;
  catalogOnly: boolean;
  breadcrumb: string;
  exact: boolean;
}

/**
 * The sources a scope picker offers (Ask and Obsidian): a source matches when the text is in its
 * title, subtitle, URI or metadata, accents and case aside. A source whose documents are all
 * catalog metadata has no readable content yet and is flagged `catalogOnly`. Exact title matches
 * come first, then titles in order.
 */
export const sourceScopeSql = `with recursive allowed as (
    select id from source_items where cardinality($2::uuid[])=0 or id=any($2::uuid[])
    union select c.id from source_items c join allowed p on c.parent_source_item_id=p.id where $3
  ), source_tree as (
    select id,title::text as path from source_items where parent_source_item_id is null
    union all select c.id,t.path || ' / ' || c.title from source_items c join source_tree t on c.parent_source_item_id=t.id
  )
  select s.id,'source' as kind,s.title,coalesce(s.subtitle,s.source_uri,'') as excerpt,s.id as "sourceItemId",
    s.type as "sourceType",
    not exists(select 1 from documents d where d.source_item_id=s.id
      and d.metadata->>'processingMode' is distinct from 'catalog_metadata'
      and d.metadata->>'supersededByDocumentId' is null) as "catalogOnly",
    t.path as breadcrumb,unaccent(lower(s.title))=unaccent(lower($1)) as exact
  from source_items s join source_tree t on t.id=s.id
  where s.id in(select id from allowed)
    and ($1='' or unaccent(lower(s.title || ' ' || coalesce(s.subtitle,'') || ' ' || coalesce(s.source_uri,'') || ' ' || s.metadata::text)) like '%' || unaccent(lower($1)) || '%')
  order by exact desc,s.title,s.id limit $4 offset $5`;

export function createSourceScopeRepository(db: Queryable) {
  return {
    /** One page of sources and whether more follow. */
    async search(query: SourceScopeQuery) {
      const rows = await db.query<SourceScopeResult>(sourceScopeSql, [
        query.text,
        query.sourceIds,
        query.includeDescendants,
        query.limit + 1,
        query.offset
      ]);
      return {
        items: rows.rows.slice(0, query.limit),
        hasMore: rows.rows.length > query.limit
      };
    }
  };
}
