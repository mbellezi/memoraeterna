import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";

import {
  readDumpToc,
  removeScratch,
  resolveBackupSource,
  restoreIntoDatabase,
  sha256File,
  verifyDatabase,
  type Verification
} from "./backup-restore.js";
import {
  createDatabase,
  execSql,
  f0Dir,
  generatePassword,
  initCluster,
  loopback,
  queryRows,
  repoRoot,
  scratchLayout,
  scratchUser,
  startCluster,
  withLock,
  assertSidecarBinaries,
  type Endpoint
} from "./scratch-cluster.js";

/**
 * Restores every candidate backup into one temporary scratch cluster (one database per backup),
 * collects library statistics and writes `.cache/f0/datasets.md` and `.cache/f0/datasets.json`.
 *
 * Usage: npx tsx scripts/db/inventory-backups.ts
 * An optional hand-written `.cache/f0/datasets-assessment.md` is embedded at the top of the report.
 */

const cacheDir = join(repoRoot, ".cache");
const inventorySlug = "inventory";

interface Candidate {
  readonly id: string;
  readonly family: string;
  readonly dumpPath: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

interface Row {
  readonly [key: string]: unknown;
}

interface Stats {
  readonly sourcesByTypeLanguage: Row[] | null;
  readonly sourcesByOrigin: Row[] | null;
  readonly sourceUriHosts: Row[] | null;
  readonly sourceMetadataKeys: Row[] | null;
  readonly sourceDates: Row | null;
  readonly documentTotals: Row | null;
  readonly topTitles: Row[] | null;
  readonly sampleTitles: Row[] | null;
  readonly notesByStatus: Row[] | null;
  readonly noteRelationsByStatus: Row[] | null;
  readonly sourceRelationsByStatusType: Row[] | null;
  readonly taskRunsByTask: Row[] | null;
  readonly taskRunsRange: Row | null;
  readonly taskRunModels: Row[] | null;
  readonly embeddings: Row[] | null;
  readonly wikiPagesByKind: Row[] | null;
  readonly jobsByStatus: Row[] | null;
}

interface DatasetResult {
  readonly candidate: Candidate;
  readonly sha256: string;
  readonly dumpCreatedAt: string | null;
  readonly manifestCreatedAt: string | null;
  readonly dumpedFromVersion: string | null;
  readonly restoreError: string | null;
  readonly verification: Verification | null;
  readonly stats: Stats | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function candidate(family: string, id: string, dumpPath: string): Promise<Candidate> {
  const info = await stat(dumpPath);
  return { id, family, dumpPath, bytes: info.size, modifiedAt: info.mtime.toISOString() };
}

/** Lists every known place where this repository keeps `pg_dump` custom-format backups. */
async function discoverCandidates(): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const wikiTeste = join(cacheDir, "wiki-teste", "database.dump");
  if (await exists(wikiTeste)) found.push(await candidate("wiki-teste", "wiki-teste", wikiTeste));
  for (const family of ["matching-benchmark", "matching-pilot"]) {
    const root = join(cacheDir, family);
    if (!(await exists(root))) continue;
    for (const entry of (await readdir(root)).sort()) {
      const dump = join(root, entry, "database.dump");
      if (entry.startsWith("memora-backup-") && (await exists(dump))) {
        found.push(
          await candidate(family, `${family}/${entry.replace("memora-backup-", "")}`, dump)
        );
      }
    }
  }
  const automatic = join(cacheDir, "automatic-wiki-20260912");
  if (await exists(automatic)) {
    for (const entry of (await readdir(automatic)).sort()) {
      if (entry.endsWith(".dump")) {
        found.push(
          await candidate(
            "automatic-wiki-dev",
            `automatic-wiki/${basename(entry, ".dump")}`,
            join(automatic, entry)
          )
        );
      }
    }
  }
  return found;
}

async function safe<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

async function collectStats(endpoint: Endpoint, database: string): Promise<Stats> {
  const rows = (sql: string) => safe(() => queryRows<Row>(endpoint, sql, database));
  const first = async (sql: string) => (await rows(sql))?.[0] ?? null;
  const embeddings: Row[] = [];
  for (const dimension of [256, 768, 1024]) {
    const result = await rows(
      `select ${dimension} as dimension, provider, model, runtime, strategy, target_type, count(*)::int as n
         from embeddings_${dimension} group by 2, 3, 4, 5, 6 order by n desc`
    );
    if (result) embeddings.push(...result);
  }
  return {
    sourcesByTypeLanguage: await rows(
      "select type::text as type, language, count(*)::int as n from source_items group by 1, 2 order by n desc, type"
    ),
    sourcesByOrigin: await rows(
      "select source_origin, count(*)::int as n from source_items group by 1 order by n desc"
    ),
    sourceUriHosts: await rows(
      `select coalesce(substring(source_uri from '^[a-z]+://([^/]+)'), '(none)') as host, count(*)::int as n
         from source_items group by 1 order by n desc limit 8`
    ),
    sourceMetadataKeys: await rows(
      `select k as key, count(*)::int as n from source_items, jsonb_object_keys(metadata) as k
        group by 1 order by n desc limit 8`
    ),
    sourceDates: await first(
      "select min(created_at) as first_at, max(created_at) as last_at from source_items"
    ),
    documentTotals: await first(
      "select count(*)::int as documents, coalesce(sum(length(canonical_markdown)), 0)::bigint as chars from documents"
    ),
    topTitles: await rows(
      `select s.title, s.type::text as type, s.language,
              coalesce(sum(length(d.canonical_markdown)), 0)::int as chars,
              (select count(*)::int from chunks c where c.source_item_id = s.id) as chunks
         from source_items s left join documents d on d.source_item_id = s.id
        group by s.id order by chars desc, s.title limit 10`
    ),
    sampleTitles: await rows("select title from source_items order by md5(id::text) limit 12"),
    notesByStatus: await rows(
      "select status::text as status, count(*)::int as n from atomic_notes group by 1 order by n desc"
    ),
    noteRelationsByStatus: await rows(
      "select status::text as status, count(*)::int as n from atomic_note_relations group by 1 order by n desc"
    ),
    sourceRelationsByStatusType: await rows(
      `select status::text as status, relation_type, count(*)::int as n
         from source_relations group by 1, 2 order by n desc`
    ),
    taskRunsByTask: await rows(
      `select task_type, count(*)::int as n, min(started_at) as first_at, max(started_at) as last_at,
              count(distinct model_id)::int as models, coalesce(sum(cost_estimate), 0)::float8 as cost
         from ai_task_runs group by 1 order by n desc`
    ),
    taskRunsRange: await first(
      "select count(*)::int as n, min(started_at) as first_at, max(started_at) as last_at from ai_task_runs"
    ),
    taskRunModels: await rows(
      "select provider, model_id, count(*)::int as n from ai_task_runs group by 1, 2 order by n desc limit 8"
    ),
    embeddings,
    wikiPagesByKind: await rows(
      "select kind, count(*)::int as n from wiki_pages group by 1 order by n desc"
    ),
    jobsByStatus: await rows(
      "select type, status::text as status, count(*)::int as n from jobs group by 1, 2 order by n desc limit 10"
    )
  };
}

// --- Markdown rendering ---------------------------------------------------------------------------

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function stamp(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 16).replace("T", " ") : "-";
}

function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return "_none_\n";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ""
  ].join("\n");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function detailSection(result: DatasetResult): string {
  const { candidate: item, stats, verification } = result;
  const lines: string[] = [`### ${item.id}`, ""];
  lines.push(
    `- Dump: \`${relative(repoRoot, item.dumpPath)}\` (${mb(item.bytes)}, sha256 \`${result.sha256.slice(0, 16)}\`)`,
    `- Dump created: ${result.dumpCreatedAt ?? "?"} (manifest: ${result.manifestCreatedAt ?? "none"}); PostgreSQL ${result.dumpedFromVersion ?? "?"}`
  );
  if (result.restoreError || !stats || !verification) {
    lines.push(`- Restore failed: ${result.restoreError ?? "unknown error"}`, "");
    return lines.join("\n");
  }
  lines.push(
    `- Drizzle migrations: ${verification.migrations.applied ?? "?"} applied (latest ${stamp(verification.migrations.latestAt)}); the repository has ${verification.migrations.expectedInRepo}`,
    `- Sources created: ${stamp(stats.sourceDates?.first_at)} to ${stamp(stats.sourceDates?.last_at)}; ${String(stats.documentTotals?.documents ?? 0)} documents, ${String(stats.documentTotals?.chars ?? 0)} characters of Markdown`,
    ""
  );
  lines.push(
    "**Key table counts**",
    "",
    table(
      ["table", "rows"],
      Object.entries(verification.counts).map(([name, count]) => [name, count])
    )
  );
  lines.push(
    "**Sources by type and language**",
    "",
    table(
      ["type", "language", "sources"],
      (stats.sourcesByTypeLanguage ?? []).map((row) => [row.type, row.language, row.n])
    )
  );
  lines.push(
    `**Source origin**: ${(stats.sourcesByOrigin ?? []).map((row) => `${cell(row.source_origin)} ${cell(row.n)}`).join(", ") || "none"}`,
    `**URI hosts**: ${(stats.sourceUriHosts ?? []).map((row) => `${cell(row.host)} ${cell(row.n)}`).join(", ") || "none"}`,
    `**Metadata keys**: ${(stats.sourceMetadataKeys ?? []).map((row) => `${cell(row.key)} ${cell(row.n)}`).join(", ") || "none"}`,
    ""
  );
  lines.push(
    "**Top-10 source titles (largest by document characters)**",
    "",
    table(
      ["title", "type", "language", "chars", "chunks"],
      (stats.topTitles ?? []).map((row) => [
        row.title,
        row.type,
        row.language,
        row.chars,
        row.chunks
      ])
    )
  );
  lines.push(
    `**Title sample (deterministic pseudo-random)**: ${(stats.sampleTitles ?? []).map((row) => cell(row.title)).join("; ") || "none"}`,
    ""
  );
  lines.push(
    "**Atomic notes by status**",
    "",
    table(
      ["status", "notes"],
      (stats.notesByStatus ?? []).map((row) => [row.status, row.n])
    )
  );
  lines.push(
    `**Note relations by status**: ${(stats.noteRelationsByStatus ?? []).map((row) => `${cell(row.status)} ${cell(row.n)}`).join(", ") || "none"}`,
    `**Source relations by status/type**: ${(stats.sourceRelationsByStatusType ?? []).map((row) => `${cell(row.status)}/${cell(row.relation_type)} ${cell(row.n)}`).join(", ") || "none"}`,
    `**Wiki pages by kind**: ${(stats.wikiPagesByKind ?? []).map((row) => `${cell(row.kind)} ${cell(row.n)}`).join(", ") || "none"}`,
    `**Jobs**: ${(stats.jobsByStatus ?? []).map((row) => `${cell(row.type)}/${cell(row.status)} ${cell(row.n)}`).join(", ") || "none"}`,
    ""
  );
  lines.push(
    `**ai_task_runs by task** (${String(stats.taskRunsRange?.n ?? 0)} runs, ${stamp(stats.taskRunsRange?.first_at)} to ${stamp(stats.taskRunsRange?.last_at)})`,
    "",
    table(
      ["task", "runs", "first", "last", "models", "cost"],
      (stats.taskRunsByTask ?? []).map((row) => [
        row.task_type,
        row.n,
        stamp(row.first_at),
        stamp(row.last_at),
        row.models,
        typeof row.cost === "number" ? row.cost.toFixed(4) : row.cost
      ])
    )
  );
  lines.push(
    `**Models used**: ${(stats.taskRunModels ?? []).map((row) => `${cell(row.provider)}/${cell(row.model_id)} ${cell(row.n)}`).join(", ") || "none"}`,
    `**Embeddings**: ${(stats.embeddings ?? []).map((row) => `${cell(row.dimension)}d ${cell(row.model)} (${cell(row.target_type)}) ${cell(row.n)}`).join(", ") || "none"}`,
    ""
  );
  return lines.join("\n");
}

function summaryTable(results: readonly DatasetResult[]): string {
  return table(
    [
      "dataset",
      "dump created",
      "MB",
      "sources",
      "docs",
      "chunks",
      "notes",
      "note rel.",
      "source rel.",
      "entities",
      "wiki",
      "ai runs",
      "jobs",
      "migr.",
      "restore"
    ],
    results.map((result) => {
      const counts = result.verification?.counts ?? {};
      return [
        result.candidate.id,
        (result.dumpCreatedAt ?? "?").slice(0, 16),
        (result.candidate.bytes / 1024 / 1024).toFixed(1),
        counts.source_items,
        counts.documents,
        counts.chunks,
        counts.atomic_notes,
        counts.atomic_note_relations,
        counts.source_relations,
        counts.entities,
        counts.wiki_pages,
        counts.ai_task_runs,
        counts.jobs,
        result.verification?.migrations.applied,
        result.restoreError ? "FAILED" : result.verification?.ok ? "ok" : "problems"
      ];
    })
  );
}

/** Detail for the oldest, newest and largest dump of each family; single-dump families in full. */
function selectDetailed(results: readonly DatasetResult[]): DatasetResult[] {
  const families = new Map<string, DatasetResult[]>();
  for (const result of results) {
    families.set(result.candidate.family, [
      ...(families.get(result.candidate.family) ?? []),
      result
    ]);
  }
  const chosen = new Set<DatasetResult>();
  for (const members of families.values()) {
    const byDate = [...members].sort((a, b) =>
      a.candidate.modifiedAt.localeCompare(b.candidate.modifiedAt)
    );
    const bySize = [...members].sort((a, b) => b.candidate.bytes - a.candidate.bytes);
    for (const pick of [byDate[0], byDate[byDate.length - 1], bySize[0]]) {
      if (pick) chosen.add(pick);
    }
  }
  return results.filter((result) => chosen.has(result));
}

async function render(results: readonly DatasetResult[]): Promise<string> {
  const assessmentPath = join(f0Dir, "datasets-assessment.md");
  const assessment = (await exists(assessmentPath)) ? await readFile(assessmentPath, "utf8") : "";
  const detailed = selectDetailed(results);
  return [
    "# F0 dataset inventory",
    "",
    `Generated ${new Date().toISOString()} by \`scripts/db/inventory-backups.ts\`. Every backup was restored into a scratch`,
    "PostgreSQL 18.4 cluster (`scripts/db/restore-backup.ts` logic); the owner's live database was never touched.",
    "",
    assessment.trim() ? `${assessment.trim()}\n` : "",
    `## Candidates (${results.length} dumps)`,
    "",
    summaryTable(results),
    `## Details (${detailed.length} sampled: oldest, newest and largest of each family)`,
    "",
    ...detailed.map(detailSection)
  ].join("\n");
}

// --- Main -------------------------------------------------------------------------------------------

parseArgs({ args: process.argv.slice(2), strict: true, options: {} });

const candidates = await discoverCandidates();
console.error(`[inventory] ${candidates.length} candidate dumps:`);
for (const item of candidates)
  console.error(`  ${item.id}  ${mb(item.bytes)}  ${relative(repoRoot, item.dumpPath)}`);

const version = await assertSidecarBinaries();
const layout = scratchLayout(inventorySlug);
await removeScratch(inventorySlug);
const results = await withLock(layout, async () => {
  const password = generatePassword();
  await initCluster(layout, password);
  const port = await startCluster(layout, password);
  const endpoint: Endpoint = {
    host: loopback,
    port,
    user: scratchUser,
    password,
    database: "postgres"
  };
  console.error(`[inventory] ${version} on ${loopback}:${port}`);
  const collected: DatasetResult[] = [];
  for (const [index, item] of candidates.entries()) {
    const database = `inv_${index}`;
    console.error(`[inventory] ${item.id}`);
    const source = await resolveBackupSource(item.dumpPath);
    const toc = await readDumpToc(source.dumpPath);
    const sha256 = await sha256File(source.dumpPath);
    const base = {
      candidate: item,
      sha256,
      dumpCreatedAt: toc.header.archiveCreatedAt,
      manifestCreatedAt: source.manifestCreatedAt,
      dumpedFromVersion: toc.header.dumpedFromVersion
    };
    try {
      await createDatabase(endpoint, database);
      await restoreIntoDatabase(endpoint, database, source.dumpPath);
      const verification = await verifyDatabase(endpoint, database, toc);
      const stats = await collectStats(endpoint, database);
      collected.push({ ...base, restoreError: null, verification, stats });
    } catch (error) {
      collected.push({
        ...base,
        restoreError: error instanceof Error ? error.message.slice(0, 400) : String(error),
        verification: null,
        stats: null
      });
    } finally {
      await execSql(endpoint, `drop database if exists ${database} with (force)`, "postgres").catch(
        () => undefined
      );
    }
  }
  return collected;
});

await writeFile(join(f0Dir, "datasets.json"), `${JSON.stringify(results, null, 2)}\n`);
await writeFile(join(f0Dir, "datasets.md"), `${await render(results)}\n`);
await removeScratch(inventorySlug);
console.info(
  JSON.stringify(
    {
      candidates: results.length,
      failed: results.filter((result) => result.restoreError).length,
      report: join(f0Dir, "datasets.md"),
      data: join(f0Dir, "datasets.json")
    },
    null,
    2
  )
);
