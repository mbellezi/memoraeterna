import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

/**
 * The tables whose rows mean a profile still holds the legacy wiki, curator and maintenance state.
 * A profile with none of them has no legacy content, and nothing may create it from nothing. The
 * counts are read by the legacy wipe, by the `LEGACY_RECREATED` startup check on a wiped profile
 * and by developer status; no mode or switch depends on them. The trigger-fed `knowledge_impact_*`
 * rows are deliberately not listed, because every ingestion wrote them; the wipe empties them with
 * the other legacy tables (`legacyWipeTables`).
 */
export const legacyContentTables = [
  "wiki_pages",
  "organization_runs",
  "organization_settings_revisions",
  "maintenance_runs",
  "maintenance_schedules",
  "wiki_policy_revisions",
  "wiki_investigations"
] as const;

export type LegacyContentTable = (typeof legacyContentTables)[number];

/** Row counts per legacy-content table. */
export type LegacyContentCounts = Readonly<Record<LegacyContentTable, number>>;

/** True when any legacy-content table holds a row. */
export function hasLegacyContent(counts: LegacyContentCounts): boolean {
  return legacyContentTables.some((table) => counts[table] > 0);
}

const countsSql = `select ${legacyContentTables
  .map((table) => `(select count(*) from ${table})::int as "${table}"`)
  .join(", ")}`;

export function createLegacyStateRepository(db: Queryable) {
  return {
    /** One statement, one snapshot: the counts of every legacy-content table. */
    async legacyContentCounts(): Promise<LegacyContentCounts> {
      const result = await db.query<QueryResultRow & Record<LegacyContentTable, number>>(countsSql);
      const row = result.rows[0];
      return Object.fromEntries(
        legacyContentTables.map((table) => [table, Number(row?.[table] ?? 0)])
      ) as Record<LegacyContentTable, number>;
    }
  };
}
