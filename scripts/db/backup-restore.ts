import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  assertSidecarBinaries,
  assertSlug,
  binPath,
  clusterStatus,
  createDatabase,
  endpointEnv,
  execSql,
  f0Dir,
  generatePassword,
  initCluster,
  loopback,
  pathExists,
  psqlArgs,
  queryRows,
  removeCluster,
  repoRoot,
  resolveBinDir,
  run,
  scratchDatabase,
  scratchLayout,
  scratchUser,
  startCluster,
  stopCluster,
  withLock,
  type Endpoint,
  type ScratchLayout
} from "./scratch-cluster.js";

/**
 * Restoring `pg_dump` backups (the format written by the desktop backup service: a directory with
 * `database.dump` and `manifest.json`) into scratch clusters, and verifying the result.
 */

function log(message: string): void {
  console.error(`[restore-backup] ${message}`);
}

export const requiredExtensions = ["vector", "unaccent", "pg_trgm"] as const;
/** The graph projection creates AGE lazily; a backup made after that contains it. */
export const optionalExtensions = ["age"] as const;

/** Tables whose row counts identify a library. A missing table is reported as `null`. */
export const keyTables = [
  "source_items",
  "documents",
  "chunks",
  "atomic_notes",
  "atomic_note_relations",
  "source_relations",
  "entities",
  "wiki_pages",
  "ai_task_runs",
  "jobs",
  "source_summaries",
  "embeddings_256",
  "embeddings_768",
  "embeddings_1024"
] as const;

// --- Command line -----------------------------------------------------------------------------

export type RestoreCommand =
  | { kind: "restore"; slug: string; from: string; keepRunning: boolean; force: boolean }
  | { kind: "stop"; slug: string }
  | { kind: "remove"; slug: string }
  | { kind: "help" };

export const restoreUsage = `Usage: npx tsx scripts/db/restore-backup.ts --from <backup dir | .dump file> --name <slug> [options]
       npx tsx scripts/db/restore-backup.ts --stop --name <slug>
       npx tsx scripts/db/restore-backup.ts --remove --name <slug>

Restores a pg_dump backup (directory with database.dump + manifest.json, or a bare custom-format
.dump file) into a scratch PostgreSQL cluster at .cache/f0/scratch-<slug>/ and writes the connection
to .cache/f0/scratch-<slug>.json (mode 0600).

Options:
  --from <path>      Backup directory or .dump file (required to restore).
  --name <slug>      Scratch cluster name: lowercase letters, digits and dashes (required).
  --keep-running     Leave the cluster running after the restore (default: stop it afterwards).
  --force            Discard an existing scratch cluster with this name and restore again.
  --stop             Stop the named scratch cluster (data and connection file are kept).
  --remove           Stop and delete the named scratch cluster and its connection file.
  --help             Show this help.

Re-running with the same --from and --name reuses an already restored cluster (idempotent).`;

export function parseRestoreArgs(argv: readonly string[]): RestoreCommand {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      from: { type: "string" },
      name: { type: "string" },
      "keep-running": { type: "boolean" },
      force: { type: "boolean" },
      stop: { type: "boolean" },
      remove: { type: "boolean" },
      help: { type: "boolean" }
    }
  });
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument "${positionals[0]}". Use --from and --name.`);
  }
  if (values.help) return { kind: "help" };
  if (values.name === undefined) throw new Error("--name <slug> is required.");
  const slug = assertSlug(values.name);
  if (values.stop && values.remove) throw new Error("--stop and --remove cannot be combined.");
  if (values.stop || values.remove) {
    if (values.from !== undefined || values["keep-running"] || values.force) {
      throw new Error("--stop/--remove only accept --name.");
    }
    return { kind: values.stop ? "stop" : "remove", slug };
  }
  if (values.from === undefined) throw new Error("--from <backup dir | .dump file> is required.");
  return {
    kind: "restore",
    slug,
    from: values.from,
    keepRunning: values["keep-running"] === true,
    force: values.force === true
  };
}

const verificationSchema = z.object({
  ok: z.boolean(),
  verifiedAt: z.string(),
  counts: z.record(z.string(), z.number().nullable()),
  migrations: z.object({
    applied: z.number().nullable(),
    latestAt: z.string().nullable(),
    expectedInRepo: z.number()
  }),
  extensions: z.array(z.object({ name: z.string(), version: z.string() })),
  tocTablesExpected: z.number(),
  tocTablesMissing: z.array(z.string()),
  /** AGE graphs found after the restore, with their vertex count or the error from Cypher. */
  ageGraphs: z
    .array(
      z.object({ name: z.string(), vertices: z.number().nullable(), error: z.string().nullable() })
    )
    .default([]),
  problems: z.array(z.string()),
  /** Derived layers (AGE) that did not come back usable; canonical data is still verified. */
  warnings: z.array(z.string()).default([])
});

export type Verification = z.infer<typeof verificationSchema>;

const connectionFileSchema = z.object({
  version: z.literal(1),
  slug: z.string(),
  status: z.enum(["running", "stopped"]),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  user: z.string(),
  password: z.string(),
  connectionString: z.string(),
  dataDir: z.string(),
  logFile: z.string(),
  binDir: z.string(),
  pgVersion: z.string(),
  startedAt: z.string().nullable(),
  restored: z
    .object({
      sourcePath: z.string(),
      sha256: z.string(),
      bytes: z.number(),
      dumpCreatedAt: z.string().nullable(),
      manifestCreatedAt: z.string().nullable(),
      restoredAt: z.string(),
      verification: verificationSchema
    })
    .nullable()
});

export type ScratchConnection = z.infer<typeof connectionFileSchema>;

export async function readConnection(layout: ScratchLayout): Promise<ScratchConnection | null> {
  let text: string;
  try {
    text = await readFile(layout.connectionFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = connectionFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeConnection(
  layout: ScratchLayout,
  connection: ScratchConnection
): Promise<void> {
  await mkdir(f0Dir, { recursive: true });
  await writeFile(layout.connectionFile, `${JSON.stringify(connection, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(layout.connectionFile, 0o600);
}

export function buildConnectionString(parts: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string {
  return `postgresql://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}/${encodeURIComponent(parts.database)}`;
}

export function maskConnectionString(connectionString: string): string {
  return connectionString.replace(/(\/\/[^:/@]+):[^@]*@/, "$1:***@");
}

// --- Backup sources -----------------------------------------------------------------------------

const manifestSchema = z.looseObject({
  version: z.number().optional(),
  createdAt: z.string().optional(),
  included: z.array(z.string()).optional()
});

export interface BackupSource {
  readonly dumpPath: string;
  readonly backupDir: string | null;
  readonly manifestCreatedAt: string | null;
  readonly bytes: number;
}

/** Accepts a backup directory (`database.dump` + `manifest.json`) or a bare `.dump` file. */
export async function resolveBackupSource(from: string): Promise<BackupSource> {
  const absolute = resolve(from);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`--from path does not exist: ${absolute}`);
  }
  let dumpPath = absolute;
  let backupDir: string | null = null;
  let manifestCreatedAt: string | null = null;
  if (info.isDirectory()) {
    if (await pathExists(join(absolute, "PG_VERSION"))) {
      throw new Error(
        `--from points at a live PostgreSQL data directory, not a backup: ${absolute}`
      );
    }
    dumpPath = join(absolute, "database.dump");
    backupDir = absolute;
    if (!(await pathExists(dumpPath))) {
      throw new Error(`No database.dump in backup directory: ${absolute}`);
    }
    const manifestText = await readFile(join(absolute, "manifest.json"), "utf8").catch(() => null);
    if (manifestText !== null) {
      const manifest = manifestSchema.safeParse(JSON.parse(manifestText));
      manifestCreatedAt = manifest.success ? (manifest.data.createdAt ?? null) : null;
    }
  } else if (!info.isFile()) {
    throw new Error(`--from is neither a directory nor a file: ${absolute}`);
  }
  const handle = await open(dumpPath, "r");
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    if (magic.toString("latin1") !== "PGDMP") {
      throw new Error(`Not a pg_dump custom-format archive (missing PGDMP header): ${dumpPath}`);
    }
  } finally {
    await handle.close();
  }
  const dumpInfo = await stat(dumpPath);
  return { dumpPath, backupDir, manifestCreatedAt, bytes: dumpInfo.size };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface DumpHeader {
  readonly dbName: string | null;
  readonly archiveCreatedAt: string | null;
  readonly tocEntries: number | null;
  readonly dumpedFromVersion: string | null;
  readonly dumpedByVersion: string | null;
}

export interface TocTable {
  readonly schema: string;
  readonly name: string;
  readonly hasData: boolean;
}

export interface DumpToc {
  readonly header: DumpHeader;
  readonly tables: readonly TocTable[];
  readonly extensions: readonly string[];
  readonly schemas: readonly string[];
}

/** Parses the output of `pg_restore --list`. */
export function parseToc(listing: string): DumpToc {
  const field = (label: string): string | null => {
    const match = new RegExp(`^;\\s+${label}:\\s*(.+)$`, "m").exec(listing);
    return match?.[1]?.trim() ?? null;
  };
  const created = /^; Archive created at (.+)$/m.exec(listing)?.[1]?.trim() ?? null;
  const tocEntries = field("TOC Entries");
  const tables = new Map<string, { schema: string; name: string; hasData: boolean }>();
  const extensions: string[] = [];
  const schemas: string[] = [];
  for (const line of listing.split("\n")) {
    const table = /^\d+; \d+ \d+ (TABLE DATA|TABLE) (\S+) (\S+) \S+$/.exec(line);
    if (table) {
      const [, kind, schema, name] = table as unknown as [string, string, string, string];
      const key = `${schema}.${name}`;
      const entry = tables.get(key) ?? { schema, name, hasData: false };
      if (kind === "TABLE DATA") entry.hasData = true;
      tables.set(key, entry);
      continue;
    }
    const extension = /^\d+; \d+ \d+ EXTENSION - (\S+)/.exec(line);
    if (extension?.[1]) extensions.push(extension[1]);
    const schema = /^\d+; \d+ \d+ SCHEMA - (\S+)/.exec(line);
    if (schema?.[1]) schemas.push(schema[1]);
  }
  return {
    header: {
      dbName: field("dbname"),
      archiveCreatedAt: created,
      tocEntries: tocEntries === null ? null : Number.parseInt(tocEntries, 10),
      dumpedFromVersion: field("Dumped from database version"),
      dumpedByVersion: field("Dumped by pg_dump version")
    },
    tables: [...tables.values()],
    extensions,
    schemas
  };
}

export async function readDumpToc(dumpPath: string): Promise<DumpToc> {
  const { stdout } = await run(binPath("pg_restore"), ["--list", dumpPath]);
  return parseToc(stdout);
}

// --- Restore and verification ------------------------------------------------------------------

export interface RestoreResult {
  readonly durationMs: number;
}

/**
 * Restores a custom-format archive into an existing empty database. The restore is one
 * transaction that exits on the first error, so a failure leaves the database empty.
 *
 * No error is treated as benign: any message from pg_restore fails the restore.
 */
export async function restoreDump(
  endpoint: Endpoint,
  database: string,
  dumpPath: string
): Promise<RestoreResult> {
  const startedAt = Date.now();
  await run(
    binPath("pg_restore"),
    [
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "-h",
      endpoint.host,
      "-p",
      String(endpoint.port),
      "-U",
      endpoint.user,
      "-d",
      database,
      dumpPath
    ],
    { env: endpointEnv(endpoint), timeoutMs: 1_800_000 }
  );
  return { durationMs: Date.now() - startedAt };
}

/** Restores a dump into an empty database and makes it usable: extensions, AGE catalog, statistics. */
export async function restoreIntoDatabase(
  endpoint: Endpoint,
  database: string,
  dumpPath: string
): Promise<{ durationMs: number; ageGraphsRepaired: number }> {
  const restored = await restoreDump(endpoint, database, dumpPath);
  await ensureRequiredExtensions(endpoint, database);
  const ageGraphsRepaired = await repairAgeCatalog(endpoint, database);
  await execSql(endpoint, "analyze", database);
  return { durationMs: restored.durationMs, ageGraphsRepaired };
}

/** Mirrors the application's migration: `CREATE EXTENSION IF NOT EXISTS ...` (no-op after a restore). */
export async function ensureRequiredExtensions(
  endpoint: Endpoint,
  database: string
): Promise<void> {
  const available = await queryRows<{ name: string }>(
    endpoint,
    "select name from pg_available_extensions",
    database
  );
  const names = new Set(available.map((row) => row.name));
  const missing = [...requiredExtensions, ...optionalExtensions].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Extensions not available in the sidecar library directory: ${missing.join(", ")}`
    );
  }
  for (const extension of requiredExtensions) {
    await execSql(endpoint, `create extension if not exists ${extension}`, database);
  }
}

export async function countRepoMigrations(): Promise<number> {
  const journal = JSON.parse(
    await readFile(join(repoRoot, "packages/db/drizzle/meta/_journal.json"), "utf8")
  ) as { entries: unknown[] };
  return journal.entries.length;
}

/** Row counts for the key tables (`null` when the table does not exist in that backup). */
export async function countKeyTables(
  endpoint: Endpoint,
  database: string
): Promise<Record<string, number | null>> {
  const values = keyTables.map((name) => `('${name}')`).join(", ");
  const rows = await queryRows<{ name: string; n: number | null }>(
    endpoint,
    `select v.name,
            case when to_regclass(format('public.%I', v.name)) is null then null
                 else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', v.name), false, true, '')))[1]::text::bigint
            end as n
       from (values ${values}) as v(name)`,
    database
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.n]));
}

export async function readMigrationState(
  endpoint: Endpoint,
  database: string
): Promise<{ applied: number | null; latestAt: string | null }> {
  const rows = await queryRows<{ n: number | null; latest: number | null }>(
    endpoint,
    `select case when to_regclass('drizzle.__drizzle_migrations') is null then null
                 else (xpath('/row/c/text()', query_to_xml('select count(*) as c from drizzle.__drizzle_migrations', false, true, '')))[1]::text::int
            end as n,
            case when to_regclass('drizzle.__drizzle_migrations') is null then null
                 else (xpath('/row/c/text()', query_to_xml('select max(created_at) as c from drizzle.__drizzle_migrations', false, true, '')))[1]::text::bigint
            end as latest`,
    database
  );
  const row = rows[0];
  return {
    applied: row?.n ?? null,
    latestAt: row?.latest == null ? null : new Date(Number(row.latest)).toISOString()
  };
}

/**
 * AGE stores raw OIDs in `ag_catalog.ag_graph.graphid` and `ag_catalog.ag_label.graph` (the OID of
 * the graph's schema). `pg_restore` creates the schema with a new OID, so the restored graph is
 * unusable ("graph with oid ... does not exist") until the catalog is re-pointed. The graph tables
 * themselves are restored verbatim. Returns the number of graphs that were re-pointed.
 */
export async function repairAgeCatalog(endpoint: Endpoint, database: string): Promise<number> {
  const installed = await queryRows<{ n: number }>(
    endpoint,
    "select count(*)::int as n from pg_extension where extname = 'age'",
    database
  );
  if ((installed[0]?.n ?? 0) === 0) return 0;
  const stale = await queryRows<{ n: number }>(
    endpoint,
    "select count(*)::int as n from ag_catalog.ag_graph where graphid <> namespace::oid",
    database
  );
  const count = stale[0]?.n ?? 0;
  if (count === 0) return 0;
  await execSql(
    endpoint,
    `alter table ag_catalog.ag_label drop constraint if exists fk_graph_oid;
     update ag_catalog.ag_label l set graph = g.namespace::oid
       from ag_catalog.ag_graph g where l.graph = g.graphid and g.graphid <> g.namespace::oid;
     update ag_catalog.ag_graph set graphid = namespace::oid where graphid <> namespace::oid;
     alter table ag_catalog.ag_label add constraint fk_graph_oid
       foreign key (graph) references ag_catalog.ag_graph (graphid)`,
    database
  );
  return count;
}

async function countAgeVertices(
  endpoint: Endpoint,
  database: string,
  graph: string
): Promise<number> {
  if (!/^[A-Za-z0-9_]+$/.test(graph)) throw new Error(`Unexpected AGE graph name "${graph}"`);
  const { stdout } = await run(
    binPath("psql"),
    psqlArgs(endpoint, database, [
      "-A",
      "-t",
      "-q",
      "-c",
      "load 'age'",
      "-c",
      'set search_path = ag_catalog, "$user", public',
      "-c",
      `select * from cypher('${graph}', $$ match (n) return count(n) $$) as (c agtype)`
    ]),
    { env: endpointEnv(endpoint) }
  );
  const value = Number.parseInt(stdout.trim().split("\n").pop() ?? "", 10);
  if (!Number.isFinite(value)) throw new Error(`Unexpected Cypher output: ${stdout.trim()}`);
  return value;
}

/** Verifies a restored database against the dump's table of contents and the key-table counts. */
export async function verifyDatabase(
  endpoint: Endpoint,
  database: string,
  toc: DumpToc
): Promise<Verification> {
  const problems: string[] = [];
  const counts = await countKeyTables(endpoint, database);
  const migrationState = await readMigrationState(endpoint, database);
  const extensions = await queryRows<{ name: string; version: string }>(
    endpoint,
    "select extname as name, extversion as version from pg_extension order by extname",
    database
  );
  const expectedTables = toc.tables.map((table) => `${table.schema}.${table.name}`);
  const present = await queryRows<{ qualified: string }>(
    endpoint,
    `select n.nspname || '.' || c.relname as qualified
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')`,
    database
  );
  const presentSet = new Set(present.map((row) => row.qualified));
  const tocTablesMissing = expectedTables.filter((table) => !presentSet.has(table));
  if (tocTablesMissing.length > 0) {
    problems.push(`${tocTablesMissing.length} table(s) from the dump are missing after restore`);
  }
  const installed = new Set(extensions.map((extension) => extension.name));
  for (const extension of requiredExtensions) {
    if (!installed.has(extension)) problems.push(`extension ${extension} is not installed`);
  }
  for (const extension of toc.extensions) {
    if (!installed.has(extension)) problems.push(`dump extension ${extension} is not installed`);
  }
  const warnings: string[] = [];
  const ageGraphs: Verification["ageGraphs"] = [];
  if (installed.has("age")) {
    const graphs = await queryRows<{ name: string }>(
      endpoint,
      "select name::text as name from ag_catalog.ag_graph order by name",
      database
    );
    for (const graph of graphs) {
      try {
        ageGraphs.push({
          name: graph.name,
          vertices: await countAgeVertices(endpoint, database, graph.name),
          error: null
        });
      } catch (error) {
        const message = String(error).split("\n")[0] ?? "unknown error";
        ageGraphs.push({ name: graph.name, vertices: null, error: message });
        warnings.push(`AGE graph ${graph.name} is not queryable: ${message}`);
      }
    }
  }
  if (counts.source_items === null) problems.push("table source_items does not exist");
  if (migrationState.applied === null) problems.push("drizzle.__drizzle_migrations does not exist");
  return {
    ok: problems.length === 0,
    verifiedAt: new Date().toISOString(),
    counts,
    migrations: { ...migrationState, expectedInRepo: await countRepoMigrations() },
    extensions,
    tocTablesExpected: expectedTables.length,
    tocTablesMissing,
    ageGraphs,
    problems,
    warnings
  };
}

// --- Orchestration ------------------------------------------------------------------------------

export interface RestoreSummary {
  readonly slug: string;
  readonly status: "running" | "stopped";
  readonly reused: boolean;
  readonly connectionFile: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly maskedConnectionString: string;
  readonly pgVersion: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly dumpCreatedAt: string | null;
  readonly verification: Verification;
}

export interface RestoreBackupOptions {
  readonly slug: string;
  readonly from: string;
  readonly keepRunning: boolean;
  readonly force: boolean;
}

function connectionRecord(
  layout: ScratchLayout,
  fields: {
    pgVersion: string;
    password: string;
    port: number;
    status: ScratchConnection["status"];
    startedAt: string | null;
    restored: ScratchConnection["restored"];
  }
): ScratchConnection {
  const { password, port } = fields;
  return {
    version: 1,
    slug: layout.slug,
    status: fields.status,
    host: loopback,
    port,
    database: scratchDatabase,
    user: scratchUser,
    password,
    connectionString: buildConnectionString({
      host: loopback,
      port,
      database: scratchDatabase,
      user: scratchUser,
      password
    }),
    dataDir: layout.dataDir,
    logFile: layout.logFile,
    binDir: resolveBinDir(),
    pgVersion: fields.pgVersion,
    startedAt: fields.startedAt,
    restored: fields.restored
  };
}

export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreSummary> {
  const layout = scratchLayout(options.slug);
  const pgVersion = await assertSidecarBinaries();
  return withLock(layout, async () => {
    const source = await resolveBackupSource(options.from);
    const toc = await readDumpToc(source.dumpPath);
    const sha256 = await sha256File(source.dumpPath);
    log(
      `source ${source.dumpPath} (${source.bytes} bytes, sha256 ${sha256.slice(0, 12)}..., dump of ${toc.header.dbName ?? "?"} created ${toc.header.archiveCreatedAt ?? "?"})`
    );

    const existing = await readConnection(layout);
    const reuse =
      !options.force &&
      existing?.restored?.sha256 === sha256 &&
      existing.restored.verification.ok &&
      (await pathExists(join(layout.dataDir, "PG_VERSION")));
    if (!reuse && (await pathExists(layout.root))) {
      log(
        options.force
          ? "--force: discarding the existing scratch cluster"
          : "discarding a scratch cluster that does not match this source"
      );
      await removeCluster(layout);
    }

    const password = reuse && existing ? existing.password : generatePassword();
    if (!reuse) {
      log("initdb");
      await initCluster(layout, password);
      // Persist the password before anything else can fail; `restored: null` marks it incomplete.
      await writeConnection(
        layout,
        connectionRecord(layout, {
          pgVersion,
          password,
          port: 0,
          status: "stopped",
          startedAt: null,
          restored: null
        })
      );
    }

    const wasRunning = (await clusterStatus(layout)).running;
    try {
      const port = await startCluster(layout, password);
      const startedAt = new Date().toISOString();
      const endpoint: Endpoint = {
        host: loopback,
        port,
        user: scratchUser,
        password,
        database: scratchDatabase
      };
      log(`${wasRunning ? "already running" : "started"} on ${loopback}:${port}`);

      if (reuse) {
        log("reusing the already restored cluster (same source sha256)");
      } else {
        await createDatabase(endpoint, scratchDatabase);
        log("pg_restore (single transaction, exit on error, no owner)");
        const restored = await restoreIntoDatabase(endpoint, scratchDatabase, source.dumpPath);
        const repaired =
          restored.ageGraphsRepaired > 0
            ? `; re-pointed ${restored.ageGraphsRepaired} AGE graph(s) to the new schema OID`
            : "";
        log(`restored in ${(restored.durationMs / 1000).toFixed(1)}s${repaired}`);
      }

      const verification = await verifyDatabase(endpoint, scratchDatabase, toc);
      for (const warning of verification.warnings) log(`warning: ${warning}`);
      if (!verification.ok) {
        throw new Error(`Verification failed: ${verification.problems.join("; ")}`);
      }

      const restoredAt =
        reuse && existing?.restored ? existing.restored.restoredAt : new Date().toISOString();
      const connection = connectionRecord(layout, {
        pgVersion,
        password,
        port,
        status: "running",
        startedAt,
        restored: {
          sourcePath: source.dumpPath,
          sha256,
          bytes: source.bytes,
          dumpCreatedAt: toc.header.archiveCreatedAt,
          manifestCreatedAt: source.manifestCreatedAt,
          restoredAt,
          verification
        }
      });
      await writeConnection(layout, connection);
      if (!options.keepRunning) {
        await stopCluster(layout);
        await writeConnection(layout, { ...connection, status: "stopped" });
        log("stopped (use --keep-running to leave it running)");
      }
      return {
        slug: layout.slug,
        status: options.keepRunning ? "running" : "stopped",
        reused: reuse,
        connectionFile: layout.connectionFile,
        host: loopback,
        port,
        database: scratchDatabase,
        user: scratchUser,
        maskedConnectionString: maskConnectionString(connection.connectionString),
        pgVersion,
        sourcePath: source.dumpPath,
        sourceSha256: sha256,
        dumpCreatedAt: toc.header.archiveCreatedAt,
        verification
      };
    } catch (error) {
      // Do not leave a half-restored server running; the next run discards the incomplete cluster.
      if (!wasRunning) await stopCluster(layout).catch(() => undefined);
      throw error;
    }
  });
}

export async function stopScratch(slug: string): Promise<{ slug: string; wasRunning: boolean }> {
  const layout = scratchLayout(slug);
  return withLock(layout, async () => {
    const wasRunning = await stopCluster(layout);
    const connection = await readConnection(layout);
    if (connection) await writeConnection(layout, { ...connection, status: "stopped" });
    return { slug, wasRunning };
  });
}

export async function removeScratch(slug: string): Promise<{ slug: string; existed: boolean }> {
  const layout = scratchLayout(slug);
  return withLock(layout, async () => {
    const existed = (await pathExists(layout.root)) || (await pathExists(layout.connectionFile));
    await removeCluster(layout);
    return { slug, existed };
  });
}
