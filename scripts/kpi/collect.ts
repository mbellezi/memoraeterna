import { noteRelationStateSql } from "@app/db";

import {
  aggregateAi,
  aggregateAutomation,
  aggregateJobs,
  aggregateMatching,
  aggregateRuns,
  aggregateStages,
  aggregateWiki,
  matchingOperationSpans,
  type AiRunRow,
  type AutomationRunRow,
  type JobRow,
  type OperationSpan,
  type RunRow,
  type StageRow,
  type WikiPageRow
} from "./aggregate.js";
import type {
  DatabaseInfo,
  JobsSection,
  KpiReport,
  LibraryKpi,
  Section,
  StuckJobsKpi,
  TopicsKpi
} from "./report.js";

/**
 * Reads the KPI inputs from a Memora database and assembles the report. Every query is read-only
 * and guarded by a schema check, so dumps from older schema versions still produce a report: what
 * cannot be measured is listed in `gaps` instead of failing the run.
 */

export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export class SchemaInfo {
  public constructor(private readonly columns: ReadonlyMap<string, ReadonlySet<string>>) {}

  public static async load(db: Db): Promise<SchemaInfo> {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`
    );
    const columns = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = columns.get(row.table_name);
      if (set) set.add(row.column_name);
      else columns.set(row.table_name, new Set([row.column_name]));
    }
    return new SchemaInfo(columns);
  }

  public hasTable(table: string): boolean {
    return this.columns.has(table);
  }

  public hasColumns(table: string, ...columns: string[]): boolean {
    const present = this.columns.get(table);
    return !!present && columns.every((column) => present.has(column));
  }

  /** Describes what is missing, or null when the table has all the columns. */
  public missing(table: string, ...columns: string[]): string | null {
    const present = this.columns.get(table);
    if (!present) return `missing table ${table}`;
    const absent = columns.filter((column) => !present.has(column));
    return absent.length > 0 ? `${table} lacks ${absent.join(", ")}` : null;
  }
}

export interface CollectOptions {
  /** Instant that "now" means for stuck-job detection; null derives it from recorded activity. */
  readonly asOf: Date | "now" | null;
  readonly stuckMinutes: number;
  readonly label: string | null;
  readonly connection: {
    readonly host: string;
    readonly port: number | null;
    readonly name: string;
    readonly provenance: DatabaseInfo["provenance"];
  };
  readonly now?: () => Date;
}

type Requirement = readonly [table: string, ...columns: string[]];

/** Short, content-free description of a failure; query text and row values are never included. */
function describeFailure(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  const safe = /^[\w .,:'"()-]{1,120}$/u.test(message) ? message : "unexpected error";
  return `${code ? `${code}: ` : ""}${safe}`;
}

class Collector {
  public readonly gaps: string[] = [];
  private aiRows: Promise<AiRunRow[]> | null = null;

  public constructor(
    private readonly db: Db,
    private readonly schema: SchemaInfo
  ) {}

  /** Runs a section when its tables and columns exist; records a gap otherwise or on failure. */
  public async section<T>(
    name: string,
    requirements: readonly Requirement[],
    run: () => Promise<T>
  ): Promise<Section<T>> {
    for (const [table, ...columns] of requirements) {
      const missing = this.schema.missing(table, ...columns);
      if (missing) return this.unavailable(name, missing);
    }
    try {
      return { available: true, data: await run() };
    } catch (error) {
      return this.unavailable(name, `query failed (${describeFailure(error)})`);
    }
  }

  private unavailable<T>(name: string, reason: string): Section<T> {
    this.gaps.push(`${name}: ${reason}`);
    return { available: false, reason };
  }

  /** Runs an optional part of a section; null (and a gap) when it cannot run. */
  public async part<T>(
    name: string,
    requirements: readonly Requirement[],
    run: () => Promise<T>
  ): Promise<T | null> {
    const result = await this.section(name, requirements, run);
    return result.available ? result.data : null;
  }

  private rows<T>(text: string, values: readonly unknown[] = []): Promise<T[]> {
    return this.db.query<T>(text, values).then((result) => result.rows);
  }

  // --- Library -------------------------------------------------------------------------------

  public library(): Promise<Section<LibraryKpi>> {
    return this.section("library", [], async () => {
      const count = async (table: string): Promise<number | null> =>
        this.part(`library.${table}`, [[table]], async () => {
          const [row] = await this.rows<{ n: number }>(`select count(*)::int as n from ${table}`);
          return row?.n ?? 0;
        });
      const byStatus = async (table: string) =>
        this.part(`library.${table}`, [[table, "status"]], async () => {
          const rows = await this.rows<{ status: string; n: number }>(
            `select status::text as status, count(*)::int as n from ${table} group by 1`
          );
          const counts = Object.fromEntries(rows.map((row) => [row.status, row.n]));
          return { total: rows.reduce((sum, row) => sum + row.n, 0), byStatus: counts };
        });

      const sources = await this.part(
        "library.sources",
        [["source_items", "type", "parent_source_item_id"]],
        async () => {
          const rows = await this.rows<{ type: string; root: boolean; n: number }>(
            `select type::text as type, (parent_source_item_id is null) as root, count(*)::int as n
             from source_items group by 1, 2`
          );
          const byType: Record<string, number> = {};
          for (const row of rows) byType[row.type] = (byType[row.type] ?? 0) + row.n;
          const origins = this.schema.hasColumns("source_items", "source_origin")
            ? Object.fromEntries(
                (
                  await this.rows<{ origin: string; n: number }>(
                    `select source_origin as origin, count(*)::int as n from source_items group by 1`
                  )
                ).map((row) => [row.origin, row.n])
              )
            : null;
          return {
            total: rows.reduce((sum, row) => sum + row.n, 0),
            roots: rows.filter((row) => row.root).reduce((sum, row) => sum + row.n, 0),
            byType,
            byOrigin: origins
          };
        }
      );

      const notes = await this.part("library.notes", [["atomic_notes", "status"]], async () => {
        const superseded = this.schema.hasColumns("atomic_notes", "supersession_status");
        const rows = await this.rows<{ status: string; current: boolean; n: number }>(
          `select status::text as status,
                  ${superseded ? "(supersession_status = 'current')" : "true"} as current, count(*)::int as n
           from atomic_notes group by 1, 2`
        );
        const byStatus: Record<string, number> = {};
        for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + row.n;
        return {
          total: rows.reduce((sum, row) => sum + row.n, 0),
          current: rows
            .filter((row) => row.current && row.status !== "rejected" && row.status !== "archived")
            .reduce((sum, row) => sum + row.n, 0),
          byStatus
        };
      });

      const embeddings: Record<string, number> = {};
      for (const table of ["embeddings_256", "embeddings_768", "embeddings_1024"]) {
        const total = await count(table);
        if (total !== null) embeddings[table] = total;
      }

      // Relations v2 (F3 D9): what automation applied or suggested and what it withdrew, read
      // through the visibility predicates; a library before migration 0056 has no such states.
      const noteRelationStates = await this.part(
        "library.noteRelationStates",
        [["atomic_note_relations", "band", "vetoed_at"]],
        async () => {
          const [row] = await this.rows<{ applied: number; suggested: number; withdrawn: number }>(
            `select count(*) filter (where ${noteRelationStateSql.applied("r")})::int as applied,
                    count(*) filter (where ${noteRelationStateSql.suggested("r")})::int as suggested,
                    count(*) filter (where ${noteRelationStateSql.withdrawn("r")})::int as withdrawn
               from atomic_note_relations r`
          );
          return row ?? { applied: 0, suggested: 0, withdrawn: 0 };
        }
      );

      return {
        sources,
        documents: await count("documents"),
        chunks: await count("chunks"),
        notes,
        noteRelations: await byStatus("atomic_note_relations"),
        noteRelationStates,
        sourceRelations: await byStatus("source_relations"),
        entities: await count("entities"),
        embeddings
      } satisfies LibraryKpi;
    });
  }

  // --- Processing ----------------------------------------------------------------------------

  public processing() {
    return this.section(
      "processing",
      [
        ["ingestion_run_stages", "stage", "status", "started_at", "completed_at", "metadata"],
        ["ingestion_runs", "status", "created_at", "started_at", "completed_at"]
      ],
      async () => {
        const attemptWindow = this.schema.hasColumns(
          "ingestion_run_stages",
          "attempt_started_at",
          "ended_at"
        );
        const stages = await this.rows<{
          stage: string;
          status: string;
          reused: boolean;
          wall_ms: number | null;
          attempt_ms: number | null;
          attempts: number | null;
        }>(
          `select stage, status::text as status,
                  coalesce((metadata ->> 'reused') = 'true', false) as reused,
                  (extract(epoch from (completed_at - started_at)) * 1000)::float8 as wall_ms,
                  ${
                    attemptWindow
                      ? "(extract(epoch from (ended_at - attempt_started_at)) * 1000)::float8"
                      : "null::float8"
                  } as attempt_ms,
                  ${
                    // The column defaults to 0, which means "not recorded", not "no attempt".
                    this.schema.hasColumns("ingestion_run_stages", "attempts")
                      ? "nullif(attempts, 0)"
                      : "null::int"
                  } as attempts
           from ingestion_run_stages`
        );
        const runs = await this.rows<{
          status: string;
          queue_ms: number | null;
          wall_ms: number | null;
        }>(
          `select status::text as status,
                  (extract(epoch from (started_at - created_at)) * 1000)::float8 as queue_ms,
                  (extract(epoch from (completed_at - started_at)) * 1000)::float8 as wall_ms
           from ingestion_runs`
        );
        return {
          runs: aggregateRuns(
            runs.map((row): RunRow => ({
              status: row.status,
              queueMs: row.queue_ms,
              wallMs: row.wall_ms
            }))
          ),
          stages: aggregateStages(
            stages.map((row): StageRow => ({
              stage: row.stage,
              status: row.status,
              reused: row.reused,
              wallMs: row.wall_ms,
              attemptMs: row.attempt_ms,
              attempts: row.attempts
            }))
          )
        };
      }
    );
  }

  // --- AI usage and matching -----------------------------------------------------------------

  private loadAiRows(): Promise<AiRunRow[]> {
    this.aiRows ??= (async () => {
      const monitoring = this.schema.hasColumns(
        "monitoring_operations",
        "ai_task_run_id",
        "kind",
        "operation",
        "context",
        "token_usage",
        "started_at"
      );
      const has = (column: string) => this.schema.hasColumns("ai_task_runs", column);
      const attempt = has("attempt")
        ? monitoring
          ? "coalesce(a.attempt, m.attempt)"
          : "a.attempt"
        : monitoring
          ? "m.attempt"
          : "null::int";
      const rows = await this.rows<{
        task: string;
        provider: string;
        model: string;
        runtime: string;
        status: string;
        duration_ms: number | null;
        queue_ms: number | null;
        attempt: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        reasoning_tokens: number | null;
        cost: number | null;
        operation: string | null;
        note_id: string | null;
        source_id: string | null;
        lane: string | null;
        workload_class: string | null;
        deadline_ms: number | null;
        deadline_outcome: string | null;
        requeue_ms: number | null;
        is_repair: boolean | null;
      }>(
        `select a.task_type as task, a.provider, a.model_id as model, a.runtime, a.status,
                a.duration_ms::float8 as duration_ms,
                ${has("queue_ms") ? "a.queue_ms::float8" : "null::float8"} as queue_ms,
                ${attempt}::int as attempt,
                a.input_tokens::float8 as input_tokens, a.output_tokens::float8 as output_tokens,
                ${monitoring ? "m.reasoning_tokens" : "null::float8"} as reasoning_tokens,
                a.cost_estimate::float8 as cost,
                ${monitoring ? "m.operation" : "null::text"} as operation,
                ${monitoring ? "m.note_id" : "null::text"} as note_id,
                ${monitoring ? "m.source_id" : "null::text"} as source_id,
                ${has("lane") ? "a.lane" : "null::text"} as lane,
                ${has("workload_class") ? "a.workload_class" : "null::text"} as workload_class,
                ${has("deadline_ms") ? "a.deadline_ms::float8" : "null::float8"} as deadline_ms,
                ${has("deadline_outcome") ? "a.deadline_outcome" : "null::text"} as deadline_outcome,
                ${has("requeue_ms") ? "a.requeue_ms::float8" : "null::float8"} as requeue_ms,
                ${has("is_repair") ? "a.is_repair" : "null::boolean"} as is_repair
         from ai_task_runs a
         ${
           monitoring
             ? `left join (
                  select distinct on (ai_task_run_id) ai_task_run_id, operation,
                         context ->> 'atomicNoteId' as note_id, context ->> 'sourceItemId' as source_id,
                         case when context ->> 'attempt' ~ '^[0-9]+$'
                                   and coalesce(context ->> 'origin', '') not in ('organization', 'maintenance', 'consultation')
                                   and not (context ? 'organizationRunId' or context ? 'maintenanceRunId')
                              then (context ->> 'attempt')::int end as attempt,
                         case when jsonb_typeof(token_usage -> 'reasoningTokens') = 'number'
                              then (token_usage ->> 'reasoningTokens')::float8 end as reasoning_tokens
                  from monitoring_operations
                  where kind = 'ai' and ai_task_run_id is not null
                  order by ai_task_run_id, started_at
                ) m on m.ai_task_run_id = a.id`
             : ""
         }`
      );
      return rows.map((row): AiRunRow => ({
        task: row.task,
        provider: row.provider,
        model: row.model,
        runtime: row.runtime,
        status: row.status,
        durationMs: row.duration_ms,
        queueMs: row.queue_ms,
        attempt: row.attempt,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cost: row.cost,
        operation: row.operation,
        noteId: row.note_id,
        sourceId: row.source_id,
        lane: row.lane,
        workloadClass: row.workload_class,
        deadlineMs: row.deadline_ms,
        deadlineOutcome: row.deadline_outcome,
        requeueMs: row.requeue_ms,
        isRepair: row.is_repair
      }));
    })();
    return this.aiRows;
  }

  private static readonly aiRequirement: Requirement = [
    "ai_task_runs",
    "task_type",
    "provider",
    "model_id",
    "runtime",
    "status",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "cost_estimate"
  ];

  public ai() {
    return this.section("ai", [Collector.aiRequirement], async () =>
      aggregateAi(await this.loadAiRows())
    );
  }

  public matching() {
    return this.section("matching", [Collector.aiRequirement], async () => {
      const spans: OperationSpan[] = this.schema.hasColumns(
        "monitoring_operations",
        "kind",
        "operation",
        "status",
        "duration_ms"
      )
        ? (
            await this.rows<{ operation: string; status: string; duration_ms: number | null }>(
              `select operation, status, duration_ms::float8 as duration_ms
               from monitoring_operations where kind = 'operation' and operation = any($1::text[])`,
              [matchingOperationSpans]
            )
          ).map((row) => ({
            operation: row.operation,
            status: row.status,
            durationMs: row.duration_ms
          }))
        : [];
      if (!this.schema.hasTable("monitoring_operations"))
        this.gaps.push(
          "matching: monitoring_operations is missing, so reranking calls cannot be split into note and source matching"
        );
      return aggregateMatching(await this.loadAiRows(), spans);
    });
  }

  // --- Topic tree ----------------------------------------------------------------------------

  private static readonly topicRequirements: readonly Requirement[] = [
    ["topic_trees", "status", "generation", "config"],
    ["topics", "tree_id", "parent_id", "role", "management", "retired_at", "redirect_to"],
    ["topic_placements", "tree_id", "topic_id", "rank", "needs_gate", "needs_vector"],
    ["topic_change_sets", "tree_id", "origin", "status", "applied_at"],
    ["atomic_notes", "status", "supersession_status"],
    ["source_items", "parent_source_item_id"]
  ];

  /** The active tree, judged by the same audit as `npm run topics:audit`; aggregates only. */
  public async topics(asOf: Date): Promise<Section<TopicsKpi>> {
    const hasTree = await this.part("topics", Collector.topicRequirements, async () => {
      const found = await this.rows(`select 1 as found from topic_trees where status = 'active'`);
      return found.length > 0;
    });
    if (hasTree === false) return this.unavailable("topics", "no active topic tree");
    return this.section("topics", Collector.topicRequirements, async () => {
      // Loaded here, not at the top: the audit needs the built domain package, and the rest of
      // the report must still work on a checkout that has not built it.
      const { auditDatabase } = await import("../topics/audit-db.js");
      return (await auditDatabase(this.db, { asOf })).summary;
    });
  }

  // --- Wiki structure ------------------------------------------------------------------------

  public wiki() {
    return this.section("wiki", [["wiki_pages", "parent_id", "archived", "kind"]], async () => {
      const hasManagement = this.schema.hasColumns("wiki_pages", "management");
      const hasRole = this.schema.hasColumns("wiki_pages", "role");
      const pages = (
        await this.rows<{
          id: string;
          parent_id: string | null;
          archived: boolean;
          management: string | null;
          role: string | null;
          kind: string;
        }>(
          `select id::text as id, parent_id::text as parent_id, archived,
                  ${hasManagement ? "management" : "null::text"} as management,
                  ${hasRole ? "role" : "null::text"} as role, kind
           from wiki_pages`
        )
      ).map((row): WikiPageRow => ({
        id: row.id,
        parentId: row.parent_id,
        archived: row.archived,
        management: row.management,
        role: row.role,
        kind: row.kind
      }));
      if (!hasManagement)
        this.gaps.push(
          "wiki: wiki_pages lacks management, so AI orphan roots cannot be told apart"
        );

      const notes = await this.part(
        "wiki.noteReachability",
        [
          ["atomic_notes", "status"],
          ["wiki_memberships", "page_id", "target_kind", "target_id"]
        ],
        async () => {
          const current = this.schema.hasColumns("atomic_notes", "supersession_status")
            ? "n.supersession_status = 'current' and n.status not in ('rejected', 'archived')"
            : "n.status not in ('rejected', 'archived')";
          const [row] = await this.rows<{ current: number; in_membership: number }>(
            `select count(*) filter (where ${current})::int as current,
                    count(*) filter (where ${current} and exists (
                      select 1 from wiki_memberships m join wiki_pages p on p.id = m.page_id
                      where not p.archived and m.target_kind = 'atomic_note' and m.target_id = n.id
                    ))::int as in_membership
             from atomic_notes n`
          );
          return { current: row?.current ?? 0, inMembership: row?.in_membership ?? 0 };
        }
      );

      const sources = await this.part(
        "wiki.sourceToc",
        [["source_items"], ["wiki_pages", "toc_owner_kind", "toc_owner_id"]],
        async () => {
          const [row] = await this.rows<{ total: number; with_toc: number }>(
            `select count(*)::int as total,
                    count(*) filter (where exists (
                      select 1 from wiki_pages p
                      where not p.archived and p.toc_owner_kind = 'source' and p.toc_owner_id = s.id
                    ))::int as with_toc
             from source_items s`
          );
          return { total: row?.total ?? 0, withToc: row?.with_toc ?? 0 };
        }
      );
      return aggregateWiki(pages, notes, sources);
    });
  }

  // --- Maintenance and organization ----------------------------------------------------------

  public automation(table: "organization_runs" | "maintenance_runs") {
    return this.section(table, [[table, "status", "checkpoint"]], async () =>
      aggregateAutomation(
        (
          await this.rows<{ status: string; reason: string | null }>(
            `select status, nullif(checkpoint ->> 'error', '') as reason from ${table}`
          )
        ).map((row): AutomationRunRow => row)
      )
    );
  }

  // --- Jobs ----------------------------------------------------------------------------------

  public jobs(asOf: Date, stuckMinutes: number): Promise<Section<JobsSection>> {
    return this.section(
      "jobs",
      [["jobs", "type", "status", "error", "created_at", "finished_at"]],
      async () => {
        const rows = (
          await this.rows<{
            type: string;
            status: string;
            error: string | null;
            latency_ms: number | null;
          }>(
            `select type, status::text as status, error,
                    (extract(epoch from (finished_at - created_at)) * 1000)::float8 as latency_ms
             from jobs`
          )
        ).map((row): JobRow => ({ ...row, latencyMs: row.latency_ms }));
        const base = aggregateJobs(rows);
        return { ...base, stuck: await this.stuckJobs(asOf, stuckMinutes) };
      }
    );
  }

  private stuckJobs(asOf: Date, thresholdMinutes: number): Promise<StuckJobsKpi | null> {
    return this.part(
      "jobs.stuck",
      [["jobs", "type", "status", "locked_at", "updated_at", "run_after"]],
      async () => {
        const rows = await this.rows<{
          type: string;
          running: number;
          stuck_running: number;
          queued_overdue: number;
        }>(
          `select type,
                  count(*) filter (where status = 'running')::int as running,
                  count(*) filter (where status = 'running'
                    and coalesce(locked_at, updated_at) < $1::timestamptz - make_interval(mins => $2::int))::int as stuck_running,
                  count(*) filter (where status = 'queued'
                    and run_after < $1::timestamptz - make_interval(mins => $2::int))::int as queued_overdue
           from jobs group by type having count(*) filter (where status in ('running', 'queued')) > 0
           order by type`,
          [asOf.toISOString(), thresholdMinutes]
        );
        const orphaned = await this.part(
          "jobs.orphanedIngestionRuns",
          [
            ["ingestion_runs", "status", "job_id"],
            ["jobs", "status"]
          ],
          async () => {
            const [row] = await this.rows<{ n: number }>(
              `select count(*)::int as n from ingestion_runs r left join jobs j on j.id = r.job_id
               where r.status = 'running' and j.status is distinct from 'running'`
            );
            return row?.n ?? 0;
          }
        );
        const sum = (pick: (row: (typeof rows)[number]) => number) =>
          rows.reduce((total, row) => total + pick(row), 0);
        return {
          thresholdMinutes,
          running: sum((row) => row.running),
          stuckRunning: sum((row) => row.stuck_running),
          queuedOverdue: sum((row) => row.queued_overdue),
          byType: rows.map((row) => ({
            type: row.type,
            running: row.running,
            stuckRunning: row.stuck_running,
            queuedOverdue: row.queued_overdue
          })),
          orphanedRunningIngestionRuns: orphaned
        };
      }
    );
  }

  // --- Report header -------------------------------------------------------------------------

  public async latestActivity(): Promise<Date | null> {
    const probes: string[] = [];
    if (this.schema.hasColumns("jobs", "updated_at"))
      probes.push("select max(updated_at) as t from jobs");
    if (this.schema.hasColumns("ai_task_runs", "finished_at"))
      probes.push("select max(finished_at) as t from ai_task_runs");
    if (this.schema.hasColumns("ingestion_runs", "updated_at"))
      probes.push("select max(updated_at) as t from ingestion_runs");
    if (this.schema.hasColumns("monitoring_operations", "finished_at"))
      probes.push("select max(finished_at) as t from monitoring_operations");
    if (probes.length === 0) return null;
    const [row] = await this.rows<{ t: Date | null }>(
      `select max(t) as t from (${probes.join(" union all ")}) activity`
    );
    return row?.t ? new Date(row.t) : null;
  }

  public async migrations(): Promise<DatabaseInfo["migrations"]> {
    try {
      const [row] = await this.rows<{ applied: number; latest_ms: number | null }>(
        `select count(*)::int as applied, max(created_at)::float8 as latest_ms from drizzle.__drizzle_migrations`
      );
      return {
        applied: row?.applied ?? null,
        latestAt: row?.latest_ms ? new Date(row.latest_ms).toISOString() : null
      };
    } catch {
      return { applied: null, latestAt: null };
    }
  }

  public instrumentation(): DatabaseInfo["instrumentation"] {
    return {
      stageAttempts: this.schema.hasColumns(
        "ingestion_run_stages",
        "attempts",
        "attempt_started_at",
        "ended_at"
      ),
      aiQueueMs: this.schema.hasColumns("ai_task_runs", "queue_ms"),
      aiAttempt: this.schema.hasColumns("ai_task_runs", "attempt"),
      aiLanes: this.schema.hasColumns(
        "ai_task_runs",
        "lane",
        "workload_class",
        "deadline_ms",
        "deadline_outcome",
        "requeue_ms"
      ),
      monitoring: this.schema.hasTable("monitoring_operations")
    };
  }
}

export async function collectKpi(db: Db, options: CollectOptions): Promise<KpiReport> {
  const now = (options.now ?? (() => new Date()))();
  const schema = await SchemaInfo.load(db);
  const collector = new Collector(db, schema);

  const latest = await collector.latestActivity();
  const asOf =
    options.asOf instanceof Date
      ? { date: options.asOf, basis: "explicit" as const }
      : options.asOf === "now"
        ? { date: now, basis: "now" as const }
        : { date: latest, basis: "latest-activity" as const };

  const database: DatabaseInfo = {
    host: options.connection.host,
    port: options.connection.port,
    name: options.connection.name,
    label: options.label,
    provenance: options.connection.provenance,
    migrations: await collector.migrations(),
    instrumentation: collector.instrumentation()
  };

  const library = await collector.library();
  const processing = await collector.processing();
  const ai = await collector.ai();
  const matching = await collector.matching();
  const topics = await collector.topics(asOf.date ?? now);
  const wiki = await collector.wiki();
  const organization = await collector.automation("organization_runs");
  const maintenance = await collector.automation("maintenance_runs");
  const jobs = asOf.date
    ? await collector.jobs(asOf.date, options.stuckMinutes)
    : await collector.jobs(now, options.stuckMinutes);

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    asOf: { value: asOf.date?.toISOString() ?? null, basis: asOf.basis },
    database,
    library,
    processing,
    ai,
    matching,
    topics,
    wiki,
    organization,
    maintenance,
    jobs,
    gaps: [...new Set(collector.gaps)]
  };
}
