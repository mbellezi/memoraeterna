import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  buildConnectionString,
  closePgPool,
  createPgPool,
  type PostgresSidecarConnection
} from "@app/db";

const execFileAsync = promisify(execFile);

/**
 * Tables whose row counts identify a library. The backup counts them in the exported snapshot that
 * `pg_dump --snapshot` reads, and the verifier counts them again in the test restore.
 */
export const backupKeyTables = [
  "source_items",
  "documents",
  "chunks",
  "atomic_notes",
  "embeddings_256",
  "embeddings_768",
  "embeddings_1024",
  "wiki_pages",
  "settings",
  "ai_profile_sets"
] as const;

export const backupVerificationConfig = {
  /** The disk check requires this many times the live database size to be free. */
  freeSpaceFactor: 2,
  listTimeoutMs: 120_000,
  restoreTimeoutMs: 1_800_000,
  scratchDatabasePrefix: "memora_verify_"
} as const;

const scratchDatabasePattern = /^memora_verify_[0-9]{17}$/;
const tableNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;

export type BackupTableCounts = Readonly<Record<string, number>>;

/** Everything the backup service and the verifier need from the running PostgreSQL sidecar. */
export interface BackupDatabaseContext {
  connection: PostgresSidecarConnection;
  pgDumpPath: string;
  /** Defaults to `pg_restore` next to `pg_dump` in the same sidecar directory. */
  pgRestorePath?: string;
}

export type BackupVerificationFailure =
  | "dumpUnreadable"
  | "tableDataMissing"
  | "insufficientDisk"
  | "unavailable"
  | "restoreFailed"
  | "countMismatch";

/**
 * A backup that could not be proven restorable. `message` is a localized key; `detail` is a short
 * diagnostic for the log and never contains credentials.
 */
export class BackupVerificationError extends Error {
  /** The backup folder left behind, marked as unverified. Set by the backup service. */
  public backupPath: string | undefined;

  public constructor(
    public readonly failure: BackupVerificationFailure,
    public readonly detail: string
  ) {
    super(
      failure === "insufficientDisk"
        ? "errors.backup.insufficientDisk"
        : "errors.backup.verificationFailed"
    );
    this.name = "BackupVerificationError";
  }
}

export interface BackupVerification {
  /** ISO time at which the test restore matched the snapshot counts. */
  verifiedAt: string;
  /** The key-table counts read back from the restored scratch database. */
  counts: BackupTableCounts;
  databaseBytes: number;
  freeBytes: number;
  restoreMs: number;
  durationMs: number;
}

/** The database operations of one verification, behind a port so tests can observe every call. */
export interface VerifierDatabase {
  inspect(): Promise<{ databaseBytes: number; dataDirectory: string }>;
  listScratchDatabases(): Promise<string[]>;
  createScratchDatabase(name: string): Promise<void>;
  countTables(database: string, tables: readonly string[]): Promise<BackupTableCounts>;
  dropScratchDatabase(name: string): Promise<void>;
  close(): Promise<void>;
}

export type BackupCommandRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface BackupVerifierOptions {
  getDatabaseContext: () => BackupDatabaseContext | null;
  openDatabase?: (connection: PostgresSidecarConnection) => VerifierDatabase;
  runCommand?: BackupCommandRunner;
  /** Free bytes on the volume that holds `path`. */
  freeBytes?: (path: string) => Promise<number>;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

/**
 * Proves a `pg_dump` archive restorable: it lists the archive, checks the disk, restores it into a
 * scratch database of the running sidecar, compares the key-table counts with the ones taken in the
 * dump's own snapshot, and always drops the scratch database.
 */
export class BackupVerifier {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: BackupVerifierOptions) {}

  /** Verifications run one at a time: a stale-scratch sweep must never meet a live restore. */
  public verify(dumpPath: string, expectedCounts: BackupTableCounts): Promise<BackupVerification> {
    const run = this.queue.then(
      () => this.verifyNow(dumpPath, expectedCounts),
      () => this.verifyNow(dumpPath, expectedCounts)
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async verifyNow(
    dumpPath: string,
    expectedCounts: BackupTableCounts
  ): Promise<BackupVerification> {
    const tables = Object.keys(expectedCounts).sort();
    if (tables.length === 0) throw new Error("A backup verification needs at least one table.");
    for (const table of tables) assertTableName(table);
    const context = this.options.getDatabaseContext();
    if (!context) throw new Error("errors.database.notReady");

    const startedAt = Date.now();
    const runCommand = this.options.runCommand ?? defaultRunCommand;
    const pgRestore = context.pgRestorePath ?? siblingBinary(context.pgDumpPath, "pg_restore");

    // 1. The archive lists as a PostgreSQL archive with TABLE DATA for every key table.
    const listing = await runCommand(pgRestore, ["--list", dumpPath], {
      env: process.env,
      timeoutMs: backupVerificationConfig.listTimeoutMs
    }).catch((error: unknown) => {
      throw new BackupVerificationError("dumpUnreadable", describeCommandFailure(error));
    });
    const withData = tableDataEntries(listing.stdout);
    const missing = tables.filter((table) => !withData.has(`public.${table}`));
    if (missing.length > 0) {
      throw new BackupVerificationError(
        "tableDataMissing",
        `no TABLE DATA entry for ${missing.join(", ")}`
      );
    }

    const database = (this.options.openDatabase ?? openPgVerifierDatabase)(context.connection);
    let scratch: string | null = null;
    try {
      await this.dropStaleScratchDatabases(database);

      // 2. The volume that will hold the restored copy has room for it.
      const { databaseBytes, dataDirectory } = await guardUnavailable(() => database.inspect());
      const freeBytes = await guardUnavailable(() =>
        (this.options.freeBytes ?? freeBytesOnVolume)(dataDirectory)
      );
      if (freeBytes < backupVerificationConfig.freeSpaceFactor * databaseBytes) {
        throw new BackupVerificationError(
          "insufficientDisk",
          `${freeBytes} bytes free, ${backupVerificationConfig.freeSpaceFactor} x ${databaseBytes} bytes required`
        );
      }

      // 3. The archive restores completely into a scratch database.
      scratch = scratchDatabaseName((this.options.now ?? (() => new Date()))());
      await guardUnavailable(() => database.createScratchDatabase(scratch!));
      const restoreStartedAt = Date.now();
      await runCommand(
        pgRestore,
        [
          "--single-transaction",
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          "--host",
          context.connection.host,
          "--port",
          String(context.connection.port),
          "--username",
          context.connection.user,
          "--dbname",
          scratch,
          dumpPath
        ],
        {
          env: { ...process.env, PGPASSWORD: context.connection.password },
          timeoutMs: backupVerificationConfig.restoreTimeoutMs
        }
      ).catch((error: unknown) => {
        throw new BackupVerificationError("restoreFailed", describeCommandFailure(error));
      });
      const restoreMs = Date.now() - restoreStartedAt;

      // 4. The restored key tables hold exactly the rows the dump's snapshot held.
      const counts = await guardUnavailable(() => database.countTables(scratch!, tables));
      const mismatches = tables
        .filter((table) => counts[table] !== expectedCounts[table])
        .map(
          (table) =>
            `${table}: snapshot ${expectedCounts[table]}, restored ${counts[table] ?? "missing"}`
        );
      if (mismatches.length > 0) {
        throw new BackupVerificationError("countMismatch", mismatches.join("; "));
      }
      return {
        verifiedAt: new Date().toISOString(),
        counts,
        databaseBytes,
        freeBytes,
        restoreMs,
        durationMs: Date.now() - startedAt
      };
    } finally {
      // 5. Every path drops the scratch database; a failed drop is swept by the next verification.
      if (scratch) {
        await database.dropScratchDatabase(scratch).catch((error: unknown) => {
          this.warn(`could not drop scratch database ${scratch}: ${describeCommandFailure(error)}`);
        });
      }
      await database.close().catch(() => undefined);
    }
  }

  /** A hard kill during an earlier verification can leave its scratch database behind. */
  private async dropStaleScratchDatabases(database: VerifierDatabase): Promise<void> {
    try {
      for (const name of await database.listScratchDatabases()) {
        if (!scratchDatabasePattern.test(name)) continue;
        await database.dropScratchDatabase(name);
        this.warn(`dropped stale scratch database ${name}`);
      }
    } catch (error) {
      this.warn(`could not sweep stale scratch databases: ${describeCommandFailure(error)}`);
    }
  }

  private warn(message: string): void {
    (this.options.logger ?? console).warn(`[backup-verifier] ${message}`);
  }
}

/** `schema.table` names that have a TABLE DATA entry in a `pg_restore --list` listing. */
export function tableDataEntries(listing: string): Set<string> {
  const entries = new Set<string>();
  for (const line of listing.split("\n")) {
    const match = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+)/.exec(line);
    if (match) entries.add(`${match[1]}.${match[2]}`);
  }
  return entries;
}

export function scratchDatabaseName(at: Date): string {
  const stamp = at.toISOString().replace(/\D/g, "");
  return `${backupVerificationConfig.scratchDatabasePrefix}${stamp.slice(0, 17)}`;
}

/** Row counts of `public.<table>` for validated table names, read through one connection. */
export async function countTables(
  connection: { query: (text: string) => Promise<{ rows: Array<{ n: string }> }> },
  tables: readonly string[]
): Promise<BackupTableCounts> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    assertTableName(table);
    const { rows } = await connection.query(`select count(*)::text as n from public."${table}"`);
    counts[table] = Number(rows[0]?.n);
  }
  return counts;
}

function assertTableName(table: string): void {
  if (!tableNamePattern.test(table)) throw new Error(`Invalid table name "${table}".`);
}

function assertScratchName(name: string): void {
  if (!scratchDatabasePattern.test(name)) throw new Error(`Invalid scratch database "${name}".`);
}

/** The scratch operations on the live sidecar, over one bounded connection. */
export function openPgVerifierDatabase(connection: PostgresSidecarConnection): VerifierDatabase {
  const pool = createPgPool({
    connectionString: connection.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    onError: () => undefined
  });
  return {
    async inspect() {
      const { rows } = await pool.query<{ bytes: string; directory: string }>(
        `select pg_database_size(current_database())::text as bytes,
                current_setting('data_directory') as directory`
      );
      return { databaseBytes: Number(rows[0]?.bytes), dataDirectory: String(rows[0]?.directory) };
    },
    async listScratchDatabases() {
      const { rows } = await pool.query<{ name: string }>(
        `select datname as name from pg_database where datname like 'memora\\_verify\\_%' order by 1`
      );
      return rows.map((row) => row.name);
    },
    async createScratchDatabase(name) {
      assertScratchName(name);
      await pool.query(`create database "${name}" template template0`);
    },
    async countTables(database, tables) {
      const scratchPool = createPgPool({
        connectionString: buildConnectionString({ ...connection, database }),
        max: 1,
        connectionTimeoutMillis: 10_000,
        onError: () => undefined
      });
      try {
        return await countTables(scratchPool, tables);
      } finally {
        await closePgPool(scratchPool);
      }
    },
    async dropScratchDatabase(name) {
      assertScratchName(name);
      await pool.query(`drop database if exists "${name}" with (force)`);
    },
    close: () => closePgPool(pool)
  };
}

async function guardUnavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BackupVerificationError) throw error;
    throw new BackupVerificationError("unavailable", describeCommandFailure(error));
  }
}

async function freeBytesOnVolume(path: string): Promise<number> {
  const volume = await statfs(path);
  return Number(volume.bavail) * Number(volume.bsize);
}

const defaultRunCommand: BackupCommandRunner = (file, args, options) =>
  execFileAsync(file, [...args], {
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: 32 * 1024 * 1024
  });

function siblingBinary(path: string, name: string): string {
  return join(dirname(path), process.platform === "win32" ? `${name}.exe` : name);
}

/** The first lines of a command's error output, without any connection string. */
function describeCommandFailure(error: unknown): string {
  const failure = error as { stderr?: unknown; killed?: unknown; message?: unknown };
  if (failure.killed === true) return "the command timed out";
  const text =
    typeof failure.stderr === "string" && failure.stderr.trim()
      ? failure.stderr
      : String(failure.message ?? error);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .slice(0, 400);
}
