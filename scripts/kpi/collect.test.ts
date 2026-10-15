import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectKpi, SchemaInfo, type CollectOptions, type Db } from "./collect.js";
import { renderMarkdown } from "./render.js";
import type { KpiReport, Section } from "./report.js";

const root = resolve(import.meta.dirname, "../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const options = (overrides: Partial<CollectOptions> = {}): CollectOptions => ({
  asOf: new Date("2026-03-11T10:00:00Z"),
  stuckMinutes: 15,
  label: "fixture",
  connection: { host: "127.0.0.1", port: 5432, name: "kpi_fixture", provenance: null },
  now: () => new Date("2026-03-12T00:00:00Z"),
  ...overrides
});

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t0 = Date.parse("2026-03-10T10:00:00Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000);

/** Unwraps a section, failing with the reason when it is unavailable. */
function data<T>(section: Section<T>): T {
  if (!section.available) throw new Error(`Section unavailable: ${section.reason}`);
  return section.data;
}

describe.skipIf(!sidecarInstalled)("collectKpi on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let report: KpiReport;
  let connectionString = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-kpi-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "kpi_fixture",
      user: "kpi_fixture",
      password: `kpi-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    connectionString = connection.connectionString;
    // Migration 0052 fences new legacy content (D40) and this scratch database seeds some on
    // purpose. The database default is set before the pool opens, so every connection inherits it.
    const setup = createPgPool({ connectionString, max: 1 });
    await setup.query("alter database kpi_fixture set memora.legacy_fixture = 'on'");
    await closePgPool(setup);
    pool = createPgPool({ connectionString, max: 2 });
    await runMigrations(pool, join(root, "packages/db/drizzle"), {
      seedFolder: join(root, "packages/db/seed")
    });
    await seed(pool);
    report = await collectKpi(pool, options());
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("counts the library", () => {
    const library = data(report.library);
    expect(library.sources).toEqual({
      total: 3,
      roots: 2,
      byType: { Book: 1, StandaloneArticle: 1, BookChapter: 1 },
      byOrigin: { manual: 3 }
    });
    expect(library.notes).toEqual({
      total: 5,
      current: 3,
      byStatus: { active: 2, pending_review: 1, approved: 1, rejected: 1 }
    });
    expect(library.documents).toBe(1);
    expect(library.chunks).toBe(1);
    expect(library.embeddings).toEqual({
      embeddings_256: 0,
      embeddings_768: 0,
      embeddings_1024: 0
    });
  });

  it("reports the migration state and the instrumentation columns", () => {
    expect(report.database.migrations.applied).toBeGreaterThanOrEqual(44);
    expect(report.database.instrumentation).toEqual({
      stageAttempts: true,
      aiQueueMs: true,
      aiAttempt: true,
      monitoring: true
    });
    expect(report.asOf).toEqual({ value: "2026-03-11T10:00:00.000Z", basis: "explicit" });
  });

  it("measures stage durations, retries and unknown starts", () => {
    const processing = data(report.processing);
    expect(processing.runs.total).toBe(3);
    expect(processing.runs.byStatus).toEqual({ succeeded: 1, failed: 1, running: 1 });
    const stage = (name: string) => processing.stages.find((entry) => entry.stage === name);
    expect(stage("summarization")).toMatchObject({ executed: 1, retried: 1, durationUnknown: 0 });
    expect(stage("summarization")?.wallSeconds).toMatchObject({ n: 1, p50: 4 });
    expect(stage("summarization")?.attemptSeconds).toMatchObject({ n: 1, p50: 2 });
    expect(stage("chunking")).toMatchObject({ executed: 0, reused: 1, retried: null });
    expect(stage("atomicNoteMatching")).toMatchObject({ executed: 1, durationUnknown: 1 });
    expect(stage("knowledgeGraph")).toMatchObject({ failed: 1 });
  });

  it("aggregates AI usage with queue wait, retries and reasoning tokens", () => {
    const ai = data(report.ai);
    expect(ai.total.calls).toBe(6);
    expect(ai.total.failed).toBe(1);
    expect(ai.total.inputTokens).toEqual({ sum: 250, reportedCalls: 3 });
    expect(ai.total.reasoningTokens).toEqual({ sum: 30, reportedCalls: 1 });
    expect(ai.total.queueSeconds).toMatchObject({ n: 1, p50: 3 });
    // Attempt 0 and 1 come from the column; the pair call falls back to its monitoring record,
    // and the organization call's step counter is not a retry index.
    expect(ai.total.retries).toEqual({ reportedCalls: 3, retryCalls: 2 });
    const reranking = ai.byTask.find((entry) => entry.task === "reranking");
    expect(reranking?.calls).toBe(4);
    expect(reranking?.durationSeconds).toMatchObject({ n: 3, min: 4, max: 14 });
  });

  it("separates note matching from source pair matching", () => {
    const matching = data(report.matching);
    expect(matching.noteMatching).toMatchObject({
      calls: 3,
      failed: 1,
      distinctTargets: 1,
      callsPerTarget: 3,
      secondsPerTarget: 26
    });
    expect(matching.sourceMatching).toMatchObject({ calls: 1, distinctTargets: 1 });
    expect(matching.operationSeconds["atomic-note-matching"]).toMatchObject({ n: 1, p50: 30 });
  });

  it("measures the wiki tree, note reachability and source TOCs", () => {
    const wiki = data(report.wiki);
    expect(wiki).toMatchObject({ pages: 6, archivedPages: 1, aiOrphanRoots: 1, humanRoots: 2 });
    expect(wiki.shape).toMatchObject({
      roots: 3,
      maxDepth: 2,
      byDepth: { 0: 3, 1: 2, 2: 1 },
      internalNodes: 2,
      leaves: 4
    });
    expect(wiki.shape.fanOut).toMatchObject({ n: 2, max: 2 });
    // n1 and n2 sit in a live page; n3 is rejected and n5's only membership is on an archived page.
    expect(wiki.notes).toEqual({ current: 3, inMembership: 2, share: 2 / 3 });
    expect(wiki.sources).toEqual({ total: 3, withToc: 1, share: 1 / 3 });
  });

  it("counts organization and maintenance runs by status and blocked reason", () => {
    const organization = data(report.organization);
    expect(organization.byStatus).toEqual({ applied: 1, failed: 1, awaiting_review: 1 });
    expect(organization.blockedReasons).toEqual({ "organization.errors.context": 1 });
    expect(organization.awaitingReview).toBe(1);
    const maintenance = data(report.maintenance);
    expect(maintenance.byStatus).toEqual({ no_change: 1 });
  });

  it("finds stuck jobs relative to the as-of time and hides free-text errors", () => {
    const jobs = data(report.jobs);
    expect(jobs.stuck).toMatchObject({
      thresholdMinutes: 15,
      running: 1,
      stuckRunning: 1,
      queuedOverdue: 1,
      orphanedRunningIngestionRuns: 1
    });
    expect(jobs.failures).toEqual(
      expect.arrayContaining([
        { type: "ingestion", reason: "errors.matching.rerankingFailed", count: 1 },
        { type: "ingestion", reason: "other", count: 1 }
      ])
    );
    const succeeded = jobs.byTypeStatus.find(
      (row) => row.type === "ingestion" && row.status === "succeeded"
    );
    expect(succeeded?.latencySeconds).toMatchObject({ n: 1, p50: 20 });
  });

  it("derives the as-of time from the latest activity unless told otherwise", async () => {
    const derived = await collectKpi(pool, options({ asOf: null }));
    expect(derived.asOf.basis).toBe("latest-activity");
    expect(derived.asOf.value).not.toBeNull();
    const now = await collectKpi(pool, options({ asOf: "now" }));
    expect(now.asOf).toEqual({ value: "2026-03-12T00:00:00.000Z", basis: "now" });
  });

  it("renders aggregates without identifiers, titles or note text", () => {
    const markdown = renderMarkdown(report);
    const json = JSON.stringify(report);
    for (const secret of ["SECRET-TITLE", "SECRET-BODY", "SECRET-FREE-TEXT", uid(1), uid(101)]) {
      expect(markdown).not.toContain(secret);
      expect(json).not.toContain(secret);
    }
    expect(markdown).toContain("## Wiki structure");
    expect(markdown).toContain("Nothing missing");
  });

  it("works read-only: the collector issues no write", async () => {
    const statements: string[] = [];
    const spy: Db = {
      query: (text, values) => {
        statements.push(text);
        return pool.query(text, values as unknown[]) as never;
      }
    };
    await collectKpi(spy, options());
    expect(statements.length).toBeGreaterThan(10);
    for (const text of statements) expect(text.trimStart()).toMatch(/^select\b/iu);
  });

  it("tolerates a database with an older, smaller schema", async () => {
    await pool.query("create database kpi_old");
    const oldUrl = new URL(connectionString);
    oldUrl.pathname = "/kpi_old";
    const oldPool = createPgPool({ connectionString: oldUrl.toString(), max: 1 });
    try {
      await oldPool.query(`
        create table ai_task_runs (id uuid primary key default gen_random_uuid(), task_type text not null,
          provider text not null, model_id text not null, runtime text not null, input_tokens int, output_tokens int,
          cost_estimate double precision, duration_ms int not null, status text not null,
          started_at timestamptz not null default now(), finished_at timestamptz);
        create table jobs (id uuid primary key default gen_random_uuid(), type text not null, status text not null,
          error text, created_at timestamptz not null default now(), finished_at timestamptz);
        insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
          values ('reranking', 'p', 'm', 'remote', 5000, 'succeeded', now());
        insert into jobs (type, status, finished_at) values ('ingestion', 'succeeded', now());`);
      const old = await collectKpi(oldPool, options({ asOf: null }));

      expect(old.database.instrumentation).toEqual({
        stageAttempts: false,
        aiQueueMs: false,
        aiAttempt: false,
        monitoring: false
      });
      const ai = data(old.ai);
      expect(ai.total.calls).toBe(1);
      expect(ai.total.queueSeconds).toBeNull();
      expect(ai.total.reasoningTokens).toEqual({ sum: 0, reportedCalls: 0 });
      const matching = data(old.matching);
      expect(matching.noteMatching).toBeNull();
      expect(matching.unclassifiedReranking).toMatchObject({ calls: 1 });
      expect(old.processing).toEqual({
        available: false,
        reason: "missing table ingestion_run_stages"
      });
      expect(old.wiki.available).toBe(false);
      expect(old.organization.available).toBe(false);
      const jobs = data(old.jobs);
      expect(jobs.stuck).toBeNull();
      expect(old.gaps).toEqual(
        expect.arrayContaining([
          "processing: missing table ingestion_run_stages",
          "wiki: missing table wiki_pages",
          "jobs.stuck: jobs lacks locked_at, updated_at, run_after"
        ])
      );
      expect(() => renderMarkdown(old)).not.toThrow();
      expect(renderMarkdown(old)).toContain("_Not available: missing table wiki_pages._");
    } finally {
      await closePgPool(oldPool);
    }
  });
});

describe("collectKpi failure handling", () => {
  const schemaRows = [
    { table_name: "jobs", column_name: "type" },
    { table_name: "jobs", column_name: "status" },
    { table_name: "jobs", column_name: "error" },
    { table_name: "jobs", column_name: "created_at" },
    { table_name: "jobs", column_name: "finished_at" }
  ];

  it("turns a failing query into a gap with a content-free reason instead of aborting", async () => {
    const db: Db = {
      query: async (text) => {
        if (text.includes("information_schema")) return { rows: schemaRows as never[] };
        throw Object.assign(new Error("boom at /private/path for user@host"), {
          code: "XX000"
        });
      }
    };
    const result = await collectKpi(db, options({ asOf: "now" }));
    expect(result.jobs).toEqual({
      available: false,
      reason: "query failed (XX000: unexpected error)"
    });
    expect(JSON.stringify(result)).not.toContain("private note");
    expect(result.gaps).toContain("jobs: query failed (XX000: unexpected error)");
  });

  it("describes missing tables and columns", async () => {
    const schema = new SchemaInfo(new Map([["jobs", new Set(["type"])]]));
    expect(schema.missing("jobs", "type")).toBeNull();
    expect(schema.missing("jobs", "type", "status", "error")).toBe("jobs lacks status, error");
    expect(schema.missing("wiki_pages")).toBe("missing table wiki_pages");
    expect(schema.hasTable("jobs")).toBe(true);
    expect(schema.hasColumns("jobs", "type", "status")).toBe(false);
  });
});

async function seed(pool: PgPool): Promise<void> {
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  // Sources: two roots and a chapter of the first.
  await q(
    `insert into source_items (id, type, title, parent_source_item_id) values
       ($1, 'Book', 'SECRET-TITLE one', null), ($2, 'StandaloneArticle', 'SECRET-TITLE two', null),
       ($3, 'BookChapter', 'SECRET-TITLE three', $1)`,
    [uid(1), uid(2), uid(3)]
  );

  // One chunk of the first source is the evidence of every note.
  await q(
    `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
     values ($1, $2, 'SECRET-TITLE doc', 'SECRET-BODY', 'doc-hash')`,
    [uid(90), uid(1)]
  );
  await q(
    `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
     values ($1, $2, $3, 0, 'SECRET-BODY', 'chunk-hash')`,
    [uid(91), uid(90), uid(1)]
  );

  // Notes: two current members, a rejected one, a superseded one and a current one outside the wiki.
  for (const [n, status, supersession] of [
    [11, "active", "current"],
    [12, "approved", "current"],
    [13, "rejected", "current"],
    [14, "pending_review", "superseded"],
    [15, "active", "current"]
  ] as const) {
    await q(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, status, supersession_status)
       values ($1, 'SECRET-TITLE note', 'SECRET-BODY', 'SECRET-BODY', $2, $3, 'p', 'm', 'remote', 'v', $4, $5::atomic_note_status, $6)`,
      [uid(n), uid(1), uid(91), `key-${n}`, status, supersession]
    );
  }

  // Wiki: a designed root, an AI tree of four pages, an archived AI root and a source TOC page.
  const pages: Array<[number, string, string | null, string, boolean]> = [
    [21, "human_managed", null, "collection", false],
    [22, "ai_managed", null, "topic", false],
    [23, "ai_managed", uid(22), "topic", false],
    [24, "ai_managed", uid(22), "topic", false],
    [25, "ai_managed", uid(23), "topic", false],
    [26, "ai_managed", null, "topic", true],
    [27, "human_managed", null, "collection", false]
  ];
  for (const [n, management, parent, kind, archived] of pages) {
    await q(
      `insert into wiki_pages (id, title, kind, management, parent_id, archived, toc_owner_kind, toc_owner_id)
       values ($1, 'SECRET-TITLE page', $2, $3, $4, $5, $6, $7)`,
      [
        uid(n),
        kind,
        management,
        parent,
        archived,
        n === 27 ? "source" : null,
        n === 27 ? uid(1) : null
      ]
    );
  }
  await q(
    `insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash)
     values ($1, $2, 1, 'test', '{}'::jsonb, 'hash')`,
    [uid(31), uid(23)]
  );
  await q(
    `insert into wiki_toc_groups (id, page_id, revision_id, snapshot) values ($1, $2, $3, '{}'::jsonb)`,
    [uid(32), uid(23), uid(31)]
  );
  for (const [n, page, note] of [
    [41, 23, 11],
    [42, 23, 12],
    [43, 24, 13],
    [44, 26, 15]
  ] as const) {
    await q(
      `insert into wiki_memberships (id, page_id, group_id, target_kind, target_id, position, snapshot)
       values ($1, $2, $3, 'atomic_note', $4, 0, '{}'::jsonb)`,
      [uid(n), uid(page), uid(32), uid(note)]
    );
  }

  // Jobs: finished, stuck running, overdue queued, future queued, two failures, two maintenance carriers.
  const jobRows: Array<
    [number, string, string | null, Date, Date | null, Date | null, Date | null]
  > = [
    [51, "succeeded", null, at(0), at(20), null, at(20)],
    [
      52,
      "running",
      null,
      at(0),
      null,
      new Date("2026-03-11T09:00:00Z"),
      new Date("2026-03-11T09:00:00Z")
    ],
    [53, "queued", null, at(0), null, null, at(0)],
    [54, "failed", "errors.matching.rerankingFailed", at(0), at(5), null, at(5)],
    [55, "failed", "SECRET-FREE-TEXT failure", at(0), at(5), null, at(5)],
    [56, "queued", null, at(0), null, null, at(0)],
    [57, "succeeded", null, at(0), at(1), null, at(1)],
    [58, "succeeded", null, at(0), at(1), null, at(1)]
  ];
  for (const [n, status, error, created, finished, locked, updated] of jobRows) {
    const runAfter =
      n === 53
        ? new Date("2026-03-11T07:00:00Z")
        : n === 56
          ? new Date("2026-03-11T10:10:00Z")
          : created;
    await q(
      `insert into jobs (id, type, status, error, created_at, finished_at, locked_at, updated_at, run_after)
       values ($1, $2, $3::job_status, $4, $5, $6, $7, $8, $9)`,
      [
        uid(n),
        n >= 57 ? "maintenance" : "ingestion",
        status,
        error,
        created,
        finished,
        locked,
        updated,
        runAfter
      ]
    );
  }

  // Ingestion runs and stages.
  await q(
    `insert into ingestion_runs (id, status, job_id, created_at, started_at, completed_at) values
       ($1, 'succeeded', $4, $5, $6, $7), ($2, 'failed', $8, $5, $6, $7), ($3, 'running', $9, $5, null, null)`,
    [uid(61), uid(62), uid(63), uid(51), at(0), at(10), at(70), uid(55), uid(54)]
  );
  await q(
    `insert into ingestion_run_stages (id, ingestion_run_id, stage, status, metadata, started_at, completed_at,
       attempts, attempt_started_at, ended_at) values
       ($1, $9, 'summarization', 'completed', '{}'::jsonb, $3, $5, 2, $4, $5),
       ($2, $9, 'chunking', 'completed', '{"reused": true}'::jsonb, null, $5, 0, null, $5),
       ($6, $9, 'atomicNoteMatching', 'completed', '{}'::jsonb, null, $5, 0, null, $5),
       ($7, $10, 'knowledgeGraph', 'failed', '{}'::jsonb, $3, null, 1, $3, $8)`,
    [uid(71), uid(72), at(10), at(12), at(14), uid(73), uid(74), at(30), uid(61), uid(62)]
  );

  // AI task runs, their monitoring records and one wall-clock operation span.
  const runs: Array<{
    n: number;
    task: string;
    status: string;
    ms: number;
    queue: number | null;
    attempt: number | null;
    input: number | null;
    output: number | null;
    cost: number | null;
    operation: string;
    context: Record<string, unknown>;
    usage: Record<string, number>;
  }> = [
    {
      n: 81,
      task: "reranking",
      status: "succeeded",
      ms: 12_000,
      queue: 3000,
      attempt: 0,
      input: 100,
      output: 50,
      cost: null,
      operation: "note_matching_reranking",
      context: { atomicNoteId: uid(11) },
      usage: { reasoningTokens: 30 }
    },
    {
      n: 82,
      task: "reranking",
      status: "succeeded",
      ms: 14_000,
      queue: null,
      attempt: 1,
      input: 100,
      output: 20,
      cost: null,
      operation: "note_matching_reranking",
      context: { atomicNoteId: uid(11) },
      usage: {}
    },
    {
      n: 83,
      task: "reranking",
      status: "succeeded",
      ms: 4000,
      queue: null,
      attempt: null,
      input: null,
      output: null,
      cost: null,
      operation: "source_relation_matching",
      context: { sourceItemId: uid(1), attempt: 1, origin: "ingestion" },
      usage: {}
    },
    {
      n: 84,
      task: "reranking",
      status: "failed",
      ms: 0,
      queue: null,
      attempt: null,
      input: null,
      output: null,
      cost: null,
      operation: "note_matching_reranking",
      context: { atomicNoteId: uid(11) },
      usage: {}
    },
    {
      n: 85,
      task: "embedding",
      status: "succeeded",
      ms: 100,
      queue: null,
      attempt: null,
      input: 50,
      output: null,
      cost: 0,
      operation: "embedding",
      context: {},
      usage: {}
    },
    {
      n: 86,
      task: "structured-output",
      status: "succeeded",
      ms: 900,
      queue: null,
      attempt: null,
      input: null,
      output: null,
      cost: null,
      operation: "wiki-organization",
      context: { origin: "organization", organizationRunId: uid(1), attempt: 2 },
      usage: {}
    }
  ];
  for (const run of runs) {
    await q(
      `insert into ai_task_runs (id, task_type, provider, model_id, runtime, duration_ms, status, queue_ms, attempt,
         input_tokens, output_tokens, cost_estimate, finished_at)
       values ($1, $2, 'prov', 'model', 'remote', $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        uid(run.n),
        run.task,
        run.ms,
        run.status,
        run.queue,
        run.attempt,
        run.input,
        run.output,
        run.cost
      ]
    );
    await q(
      `insert into monitoring_operations (kind, operation, stage, status, ai_task_run_id, context, token_usage)
       values ('ai', $1, 'stage', $2, $3, $4::jsonb, $5::jsonb)`,
      [
        run.operation,
        run.status,
        uid(run.n),
        JSON.stringify(run.context),
        JSON.stringify(run.usage)
      ]
    );
  }
  await q(
    `insert into monitoring_operations (kind, operation, stage, status, duration_ms, started_at, finished_at)
     values ('operation', 'atomic-note-matching', 'atomic-note-matching', 'succeeded', 30000, now(), now())`
  );

  // Organization and maintenance runs.
  await q(
    `insert into organization_runs (status, snapshot, checkpoint) values
       ('applied', '{}'::jsonb, '{}'::jsonb), ('failed', '{}'::jsonb, '{"error": "organization.errors.context"}'::jsonb),
       ('awaiting_review', '{}'::jsonb, '{}'::jsonb)`
  );
  await q(
    `insert into maintenance_runs (job_id, scope_key, period, schedule_ids, status, snapshot, checkpoint, reservation)
     values ($1, 'scope', 'p1', '[]'::jsonb, 'no_change', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [uid(57)]
  );
}
