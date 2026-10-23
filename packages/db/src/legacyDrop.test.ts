import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "./schema.js";

// Migration 0063 (F4 D35, T78): the static half of `npm run db:legacy-drop:verify`, which applies it
// to a real database. The 30 tables are the ones `legacyWipeTables` named until F4.
const legacyTables = [
  "automatic_routine_bindings",
  "automatic_routine_calls",
  "knowledge_impact_deliveries",
  "knowledge_impact_events",
  "maintenance_budget_reservations",
  "maintenance_decisions",
  "maintenance_occurrences",
  "maintenance_receipts",
  "maintenance_runs",
  "maintenance_schedules",
  "maintenance_steps",
  "organization_proposals",
  "organization_receipts",
  "organization_runs",
  "organization_settings_activations",
  "organization_settings_revisions",
  "organization_steps",
  "wiki_dependencies",
  "wiki_evidence",
  "wiki_group_receipts",
  "wiki_investigation_evaluations",
  "wiki_investigations",
  "wiki_memberships",
  "wiki_page_revisions",
  "wiki_pages",
  "wiki_policy_activations",
  "wiki_policy_revisions",
  "wiki_section_assessments",
  "wiki_source_coverage",
  "wiki_toc_groups"
];

const drizzleFolder = resolve(import.meta.dirname, "../drizzle");
const migration = readFileSync(join(drizzleFolder, "0063_legacy_drop.sql"), "utf8");

describe("legacy drop (migration 0063)", () => {
  it("drops the 30 legacy tables and nothing else by name", () => {
    const dropped = [...migration.matchAll(/^DROP TABLE "([a-z_]+)" CASCADE;/gm)].map(
      (match) => match[1]!
    );
    expect(dropped.toSorted()).toEqual(legacyTables);
    expect(legacyTables).toHaveLength(30);
    expect(migration).toContain("DROP FUNCTION legacy_insert_fence();");
  });

  it("follows 0062 in the journal", () => {
    const journal = JSON.parse(readFileSync(join(drizzleFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags[tags.indexOf("0063_legacy_drop") - 1]).toBe("0062_change_set_envelope");
  });

  it("leaves no legacy table in the schema", () => {
    const tables = Object.values(schema).flatMap((value) =>
      is(value, PgTable) ? [getTableName(value)] : []
    );
    expect(tables.length).toBeGreaterThan(60);
    expect(tables.filter((name) => legacyTables.includes(name))).toEqual([]);
    expect(
      tables.filter((name) =>
        /^(wiki_|organization_|maintenance_|automatic_routine_|knowledge_impact_)/.test(name)
      )
    ).toEqual([]);
  });

  it("removes the pair-level outcome of relation decisions and the evolution's orphan run", () => {
    const decisions = Object.keys(getTableColumns(schema.relationDecisions));
    expect(decisions).not.toContain("accepted");
    expect(decisions).not.toContain("relationType");
    expect(decisions).toEqual(
      expect.arrayContaining(["loToHiRelationType", "hiToLoRelationType", "scoreScale"])
    );
    expect(Object.keys(getTableColumns(schema.atomicNoteEvolution))).toEqual([
      "previousId",
      "nextId",
      "kind",
      "reason",
      "createdAt"
    ]);
  });

  it("keeps the type check on both directions of relation decisions", () => {
    expect(migration).toMatch(/ADD CONSTRAINT "relation_decisions_types" CHECK/);
    const added = migration.slice(migration.indexOf('ADD CONSTRAINT "relation_decisions_types"'));
    expect(added).toContain('"relation_decisions"."lo_to_hi_relation_type"');
    expect(added).toContain('"relation_decisions"."hi_to_lo_relation_type"');
    expect(added).not.toMatch(/"relation_decisions"\."relation_type"/);
  });
});
