import type { QueryResultRow } from "pg";
import { z } from "zod";

import type { PgPool } from "../client.js";
import type { Queryable } from "./types.js";

/**
 * Every pre-refactoring wiki, organization, curator, maintenance, routine and impact table. The
 * legacy wipe empties them in one `TRUNCATE` without `CASCADE`, so a foreign key from any other
 * table makes it fail instead of reaching further. Note history (`atomic_note_evidence`,
 * `atomic_note_evolution`) is not legacy and is never listed.
 */
export const legacyWipeTables = [
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
] as const;

export type LegacyWipeTable = (typeof legacyWipeTables)[number];

/** Settings only the legacy wiki reads; the wipe deletes them. */
export const legacyWipeSettingsKeys = [
  "knowledge.automation.policy.v1",
  "knowledge.wiki-areas.v1",
  "organization.active"
] as const;

export type LegacyWipeSettingsKey = (typeof legacyWipeSettingsKeys)[number];

/** Job types only the legacy curator and maintenance run; the wipe deletes their jobs. */
export const legacyWipeJobTypes = ["maintenance", "organization"] as const;

/** The Obsidian scope setting; the wipe empties its `pageIds`, which name wiped pages. */
export const obsidianWikiScopeKey = "obsidian.wiki.scope";

/** Vault registry types of the legacy wiki. Counted for the preview; the wipe leaves them. */
export const legacyVaultFileTypes = ["wiki_index", "wiki_page"] as const;

/** The audit record of every wipe of this database; nothing reads it as a switch. */
export const legacyWipeRecordKey = "legacy.wipe.v1";

const count = z.number().int().nonnegative();
const countMap = z.record(z.string(), count);

export const legacyKeyCountsSchema = z
  .object({
    /** 1 when the setting exists. */
    settings: z.object({
      "knowledge.automation.policy.v1": count,
      "knowledge.wiki-areas.v1": count,
      "organization.active": count
    }),
    /** Page IDs listed in `obsidian.wiki.scope.pageIds`. */
    scopePageIds: count,
    /** Legacy jobs by `type:status`. */
    jobs: countMap,
    /** `wiki_pages` rows by `management`. */
    pagesByManagement: countMap,
    /** Registered vault files of a legacy wiki type, by `type:status`. */
    vaultFiles: countMap
  })
  .strict();

export type LegacyKeyCounts = z.infer<typeof legacyKeyCountsSchema>;

export const legacyWipeStateSchema = z
  .object({ tables: z.record(z.enum(legacyWipeTables), count), keys: legacyKeyCountsSchema })
  .strict();

/** What the wipe removes, counted in one snapshot or recounted under its locks. */
export type LegacyWipeState = z.infer<typeof legacyWipeStateSchema>;

export const legacyWipeRunSchema = z
  .object({
    reason: z.literal("wiped"),
    at: z.string().datetime(),
    backupPath: z.string().min(1),
    verifiedAt: z.string().datetime(),
    counts: legacyWipeStateSchema,
    token: z.string().min(1)
  })
  .strict();

export type LegacyWipeRun = z.infer<typeof legacyWipeRunSchema>;

export const legacyWipeRecordSchema = z.object({ runs: z.array(legacyWipeRunSchema) }).strict();

export type LegacyWipeRecord = z.infer<typeof legacyWipeRecordSchema>;

/** A foreign key from a table outside the wipe into a legacy table; it would make the `TRUNCATE` fail. */
export interface LegacyForeignKey {
  fromTable: string;
  constraint: string;
  toTable: string;
}

export type LegacyWipeResult =
  | { outcome: "wiped"; lockMs: number; wipeMs: number }
  /** The recount under the locks differs from the expected state; the transaction rolled back. */
  | { outcome: "changed"; differences: string[] };

/** True when the wipe has anything to remove. Vault registry rows are left to the projection. */
export function hasLegacyWipeState(state: LegacyWipeState): boolean {
  return (
    legacyWipeTables.some((table) => state.tables[table] > 0) ||
    legacyWipeSettingsKeys.some((key) => state.keys.settings[key] > 0) ||
    state.keys.scopePageIds > 0 ||
    Object.values(state.keys.jobs).some((value) => value > 0)
  );
}

/** Row counts of the legacy tables in one statement, so one snapshot. */
const tableCountsSql = `select ${legacyWipeTables
  .map((table) => `(select count(*) from public."${table}")::text as "${table}"`)
  .join(", ")}`;

async function countLegacyTables(db: Queryable): Promise<LegacyWipeState["tables"]> {
  const { rows } = await db.query<QueryResultRow & Record<LegacyWipeTable, string>>(tableCountsSql);
  const row = rows[0];
  return Object.fromEntries(
    legacyWipeTables.map((table) => [table, Number(row?.[table] ?? 0)])
  ) as LegacyWipeState["tables"];
}

function settingsCounts(keys: Iterable<string>): LegacyKeyCounts["settings"] {
  const present = new Set(keys);
  return Object.fromEntries(
    legacyWipeSettingsKeys.map((key) => [key, present.has(key) ? 1 : 0])
  ) as LegacyKeyCounts["settings"];
}

function scopePageIdCount(scope: unknown): number {
  const pageIds = (scope as { pageIds?: unknown } | null)?.pageIds;
  return Array.isArray(pageIds) ? pageIds.length : 0;
}

function numberMap(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, unknown>)
      .map(([key, entry]) => [key, Number(entry)] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
}

/** What the wipe transaction recounts under its locks: the tables, settings and jobs it deletes. */
export interface LegacyWipeRecount {
  tables: LegacyWipeState["tables"];
  keys: Pick<LegacyKeyCounts, "settings" | "scopePageIds" | "jobs">;
}

/** The differences between an expected state and a recount, for the refusal message. */
export function legacyWipeDifferences(
  expected: LegacyWipeRecount,
  actual: LegacyWipeRecount
): string[] {
  const differences: string[] = [];
  const compare = (label: string, before: number | undefined, after: number | undefined) => {
    if ((before ?? 0) !== (after ?? 0))
      differences.push(`${label}: expected ${before ?? 0}, found ${after ?? 0}`);
  };
  for (const table of legacyWipeTables)
    compare(table, expected.tables[table], actual.tables[table]);
  for (const key of legacyWipeSettingsKeys)
    compare(`settings ${key}`, expected.keys.settings[key], actual.keys.settings[key]);
  compare(`${obsidianWikiScopeKey}.pageIds`, expected.keys.scopePageIds, actual.keys.scopePageIds);
  const jobKeys = new Set([...Object.keys(expected.keys.jobs), ...Object.keys(actual.keys.jobs)]);
  for (const key of [...jobKeys].sort())
    compare(`jobs ${key}`, expected.keys.jobs[key], actual.keys.jobs[key]);
  return differences;
}

/** Snapshot IDs as `pg_export_snapshot()` returns them; `SET TRANSACTION SNAPSHOT` takes no parameter. */
const snapshotIdPattern = /^[0-9A-F]+-[0-9A-F]+(-[0-9]+)?$/i;

export function createLegacyWipeRepository(pool: PgPool) {
  return {
    /** Counts the legacy tables in one statement (outside the wipe's own snapshot). */
    countTables: () => countLegacyTables(pool),

    /**
     * Counts everything the wipe deletes besides the tables, plus the legacy vault files and the
     * database size. With `snapshotId`, a second session imports that exported snapshot first, so
     * the counts belong to the same instant as the snapshot's table counts and dump.
     */
    async countKeys(
      snapshotId?: string
    ): Promise<{ keys: LegacyKeyCounts; databaseBytes: number }> {
      if (snapshotId !== undefined && !snapshotIdPattern.test(snapshotId))
        throw new Error(`Invalid snapshot identifier "${snapshotId}".`);
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        if (snapshotId !== undefined)
          await client.query(`set transaction snapshot '${snapshotId}'`);
        const { rows } = await client.query<{
          settings: string[] | null;
          scope: unknown;
          jobs: unknown;
          pages: unknown;
          vault_files: unknown;
          database_bytes: string;
        }>(
          `select
             (select array_agg(key order by key) from settings where key = any($1::text[])) as settings,
             (select value from settings where key = $2) as scope,
             (select jsonb_object_agg(type || ':' || status, n) from (
                select type, status::text as status, count(*)::int as n from jobs
                 where type = any($3::text[]) group by 1, 2) j) as jobs,
             (select jsonb_object_agg(management, n) from (
                select management, count(*)::int as n from wiki_pages group by 1) p) as pages,
             (select jsonb_object_agg(memora_type || ':' || status, n) from (
                select memora_type, status::text as status, count(*)::int as n
                  from obsidian_sync_files where memora_type = any($4::text[]) group by 1, 2) f)
               as vault_files,
             pg_database_size(current_database())::text as database_bytes`,
          [legacyWipeSettingsKeys, obsidianWikiScopeKey, legacyWipeJobTypes, legacyVaultFileTypes]
        );
        await client.query("commit");
        const row = rows[0];
        return {
          keys: legacyKeyCountsSchema.parse({
            settings: settingsCounts(row?.settings ?? []),
            scopePageIds: scopePageIdCount(row?.scope),
            jobs: numberMap(row?.jobs),
            pagesByManagement: numberMap(row?.pages),
            vaultFiles: numberMap(row?.vault_files)
          }),
          databaseBytes: Number(row?.database_bytes ?? 0)
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** Foreign keys from tables outside the wipe into legacy tables; any of them blocks the wipe. */
    async foreignKeysIntoLegacy(): Promise<LegacyForeignKey[]> {
      const { rows } = await pool.query<LegacyForeignKey & QueryResultRow>(
        `select source.relname as "fromTable", c.conname as "constraint", target.relname as "toTable"
           from pg_constraint c
           join pg_class source on source.oid = c.conrelid
           join pg_namespace source_ns on source_ns.oid = source.relnamespace
           join pg_class target on target.oid = c.confrelid
           join pg_namespace target_ns on target_ns.oid = target.relnamespace
          where c.contype = 'f' and target_ns.nspname = 'public'
            and target.relname = any($1::text[])
            and not (source_ns.nspname = 'public' and source.relname = any($1::text[]))
          order by 1, 2`,
        [legacyWipeTables]
      );
      return rows.map((row) => ({
        fromTable: String(row.fromTable),
        constraint: String(row.constraint),
        toTable: String(row.toTable)
      }));
    },

    /**
     * The wipe, in one transaction: lock the legacy tables, recount them with the legacy settings
     * and jobs (locked too), and roll back unless the recount equals `expected`. Then truncate the
     * tables, delete the settings and jobs, empty the scope's page list, bump the projection clock
     * (a `TRUNCATE` fires no statement trigger) and append `run` to the record.
     */
    async wipe(
      expected: LegacyWipeState,
      run: LegacyWipeRun,
      options: { lockTimeoutMs: number }
    ): Promise<LegacyWipeResult> {
      const record = legacyWipeRunSchema.parse(run);
      const lockTimeoutMs = Math.max(1, Math.trunc(options.lockTimeoutMs));
      const client = await pool.connect();
      try {
        await client.query("begin isolation level read committed");
        await client.query(`set local lock_timeout = '${lockTimeoutMs}ms'`);
        const lockStartedAt = Date.now();
        await client.query(
          `lock table ${legacyWipeTables.map((table) => `public."${table}"`).join(", ")} in access exclusive mode`
        );
        const lockMs = Date.now() - lockStartedAt;
        const wipeStartedAt = Date.now();

        // The recount: every statement after the lock sees all writes committed before it.
        const tables = await countLegacyTables(client);
        const settingRows = await client.query<{ key: string; value: unknown }>(
          "select key, value from settings where key = any($1::text[]) order by key for update",
          [[...legacyWipeSettingsKeys, obsidianWikiScopeKey]]
        );
        const jobRows = await client.query<{ type: string; status: string }>(
          "select type, status::text as status from jobs where type = any($1::text[]) order by id for update",
          [legacyWipeJobTypes]
        );
        const jobs: Record<string, number> = {};
        for (const row of jobRows.rows) {
          const key = `${row.type}:${row.status}`;
          jobs[key] = (jobs[key] ?? 0) + 1;
        }
        const differences = legacyWipeDifferences(expected, {
          tables,
          keys: {
            settings: settingsCounts(settingRows.rows.map((row) => row.key)),
            scopePageIds: scopePageIdCount(
              settingRows.rows.find((row) => row.key === obsidianWikiScopeKey)?.value ?? null
            ),
            jobs
          }
        });
        if (differences.length > 0) {
          await client.query("rollback");
          return { outcome: "changed", differences };
        }

        await client.query(
          `truncate table ${legacyWipeTables.map((table) => `public."${table}"`).join(", ")}`
        );
        await client.query("delete from settings where key = any($1::text[])", [
          legacyWipeSettingsKeys
        ]);
        await client.query(
          `update settings set value = jsonb_set(value, '{pageIds}', '[]'::jsonb), updated_at = now()
            where key = $1 and jsonb_typeof(value->'pageIds') = 'array'
              and jsonb_array_length(value->'pageIds') > 0`,
          [obsidianWikiScopeKey]
        );
        await client.query("delete from jobs where type = any($1::text[])", [legacyWipeJobTypes]);
        await client.query(
          `insert into obsidian_projection_clock (id, generation) values (1, 1)
           on conflict (id) do update set generation = obsidian_projection_clock.generation + 1`
        );
        const previous = await client.query<{ value: unknown }>(
          "select value from settings where key = $1 for update",
          [legacyWipeRecordKey]
        );
        const runs = previous.rows[0]
          ? legacyWipeRecordSchema.parse(previous.rows[0].value).runs
          : [];
        await client.query(
          `insert into settings (key, value) values ($1, $2::jsonb)
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [legacyWipeRecordKey, JSON.stringify({ runs: [...runs, record] })]
        );
        await client.query("commit");
        return { outcome: "wiped", lockMs, wipeMs: Date.now() - wipeStartedAt };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Row counts of every table in `public`, read in one REPEATABLE READ transaction. The rehearsal
     * compares them before and after: the wipe may change only the legacy tables, `settings` and
     * `jobs`.
     */
    async countAllTables(): Promise<Record<string, number>> {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        const { rows: tables } = await client.query<{ name: string }>(
          `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`
        );
        const counts: Record<string, number> = {};
        for (const { name } of tables) {
          const { rows } = await client.query<{ n: string }>(
            `select count(*)::text as n from public."${name.replace(/"/g, '""')}"`
          );
          counts[name] = Number(rows[0]?.n ?? 0);
        }
        await client.query("commit");
        return counts;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** The wipe record, validated; null when this database was never wiped. */
    async readRecord(): Promise<LegacyWipeRecord | null> {
      const { rows } = await pool.query<{ value: unknown }>(
        "select value from settings where key = $1",
        [legacyWipeRecordKey]
      );
      return rows[0] ? legacyWipeRecordSchema.parse(rows[0].value) : null;
    }
  };
}

export type LegacyWipeRepository = ReturnType<typeof createLegacyWipeRepository>;
