// The measurement of the lazy topic overviews (F2 T31) on a running profile, read only:
//
//   npx tsx scripts/topics/overview-report.ts --db <profile>/database/dev-connection.json
//     [--out <file.json>]
//
// For every overview of a live topic of the active tree: whether each citation resolves to the
// exact chunk and span of the note it cites (and that passage's hash), the support verdict and its
// sentence counts, whether the members changed since the writing (stale), and the audit: the
// writer's `ai_task_runs` row with its participating sources, and the time the writing took. The
// totals give the share of exactly resolved citations and of supported sentences, and the number
// of writer and ranker calls the overviews have made so far: run the report before and after
// reopening the pages, and an unchanged count proves that a reopen makes no call.
//
// The session is opened with default_transaction_read_only, so it can point at a running DEV
// profile; the connection string is never printed or written.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { topicOverviewSql } from "@app/db";
import pg from "pg";

import { describeConnectionString, resolveConnection } from "../kpi/connection.js";

export interface OverviewRow {
  topicId: string;
  title: string | null;
  writtenAt: string;
  model: string;
  language: string;
  memberCount: number;
  evidenceUsed: number;
  stale: boolean;
  support: { status?: unknown; sentences?: { checked?: unknown; supported?: unknown } };
  citations: number;
  resolved: number;
  runExists: boolean;
  runSources: number;
  runMs: number | null;
  queueMs: number | null;
}

export interface OverviewSummary {
  overviews: number;
  citations: number;
  resolvedExactly: number;
  resolvedShare: number | null;
  sentences: { checked: number; supported: number; share: number | null };
  supportStatus: Record<string, number>;
  stale: number;
  audit: { withRun: number; withSources: number };
  writing: { meanMs: number | null; maxMs: number | null };
  calls: { writer: number; ranker: number };
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** The totals of a report: pure, so it is tested without a database. */
export function summarizeOverviews(
  rows: readonly OverviewRow[],
  calls: { writer: number; ranker: number }
): OverviewSummary {
  const citations = rows.reduce((sum, row) => sum + row.citations, 0);
  const resolved = rows.reduce((sum, row) => sum + row.resolved, 0);
  const checked = rows.reduce((sum, row) => sum + integer(row.support.sentences?.checked), 0);
  const supported = rows.reduce((sum, row) => sum + integer(row.support.sentences?.supported), 0);
  const supportStatus: Record<string, number> = {};
  for (const row of rows) {
    const status = typeof row.support.status === "string" ? row.support.status : "unknown";
    supportStatus[status] = (supportStatus[status] ?? 0) + 1;
  }
  const times = rows
    .map((row) => (row.runMs === null ? null : row.runMs + (row.queueMs ?? 0)))
    .filter((value): value is number => value !== null);
  return {
    overviews: rows.length,
    citations,
    resolvedExactly: resolved,
    resolvedShare: citations > 0 ? round(resolved / citations) : null,
    sentences: { checked, supported, share: checked > 0 ? round(supported / checked) : null },
    supportStatus,
    stale: rows.filter((row) => row.stale).length,
    audit: {
      withRun: rows.filter((row) => row.runExists).length,
      withSources: rows.filter((row) => row.runSources > 0).length
    },
    writing: {
      meanMs: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      maxMs: times.length > 0 ? Math.max(...times) : null
    },
    calls
  };
}

/** Overviews of live topics of the active tree, with their citations checked against the evidence. */
export const overviewReportSql = `
select o.topic_id as "topicId", t.title, o.written_at::text as "writtenAt", o.model, o.language,
       o.member_count as "memberCount", jsonb_array_length(o.evidence) as "evidenceUsed",
       o.member_fingerprint as "memberFingerprint", o.support, t.tree_id as "treeId",
       (select count(*)::int from topic_overview_citations c where c.topic_id = o.topic_id) as citations,
       (select count(*)::int
          from topic_overview_citations c
          join chunks ch on ch.id = c.chunk_id
          join source_spans sp on sp.id = c.source_span_id
          join atomic_notes n on n.id = c.note_id
         where c.topic_id = o.topic_id
           and n.evidence_chunk_id = c.chunk_id
           and coalesce(n.source_span_id, ch.source_span_id) = c.source_span_id
           and sp.source_item_id = ch.source_item_id
           and c.excerpt_hash = encode(sha256(convert_to(ch.content, 'UTF8')), 'hex')) as resolved,
       r.id is not null as "runExists",
       (select count(*)::int from ai_task_run_sources s where s.ai_task_run_id = o.ai_task_run_id)
         as "runSources",
       r.duration_ms as "runMs", r.queue_ms as "queueMs"
  from topic_overviews o
  join topics t on t.id = o.topic_id and t.retired_at is null
  join topic_trees tree on tree.id = t.tree_id and tree.status = 'active'
  left join ai_task_runs r on r.id = o.ai_task_run_id
 order by o.written_at, o.topic_id`;

/** Calls the overviews made: writer runs of the `topic.overview` prompt, and ranker runs of the check. */
export const overviewCallsSql = `
select (select count(*)::int from ai_task_runs r
         where r.prompt_compositions @> '[{"promptId":"topic.overview"}]'::jsonb) as writer,
       (select count(*)::int from ai_task_runs r
         where r.prompt_compositions @> '[{"promptId":"topic.overview.support"}]'::jsonb) as ranker`;

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { db: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } },
    strict: true,
    allowPositionals: false
  });
  if (values.help || !values.db) {
    console.info(
      "Usage: npx tsx scripts/topics/overview-report.ts --db <dev-connection.json | url> [--out <file>]"
    );
    return values.help ? 0 : 1;
  }
  const connection = await resolveConnection(values.db);
  const client = new pg.Client({
    connectionString: connection.connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=120000",
    connectionTimeoutMillis: 10_000
  });
  await client.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const raw = (
      await client.query<OverviewRow & { memberFingerprint: string; treeId: string }>(
        overviewReportSql
      )
    ).rows;
    const rows: OverviewRow[] = [];
    for (const row of raw) {
      const members = await client.query<{ fingerprint: string }>(topicOverviewSql.members, [
        row.topicId,
        row.treeId
      ]);
      const { memberFingerprint, treeId, ...rest } = row;
      void treeId;
      rows.push({ ...rest, stale: members.rows[0]?.fingerprint !== memberFingerprint });
    }
    const calls = (await client.query<{ writer: number; ranker: number }>(overviewCallsSql))
      .rows[0] ?? { writer: 0, ranker: 0 };
    await client.query("rollback");
    const report = {
      database: describeConnectionString(connection.connectionString),
      summary: summarizeOverviews(rows, calls),
      overviews: rows
    };
    if (values.out) await writeFile(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
    console.info(JSON.stringify(report.summary, null, 2));
    return 0;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[topics:overview-report] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
      );
      process.exitCode = 1;
    }
  );
}
