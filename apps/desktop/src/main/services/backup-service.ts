import { execFile } from "node:child_process";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { closePgPool, createPgPool, type PostgresSidecarConnection } from "@app/db";
import type { BackupResult, StorageSettings } from "../../shared/ipc.js";
import {
  BackupVerificationError,
  BackupVerifier,
  backupKeyTables,
  countTables,
  type BackupDatabaseContext,
  type BackupTableCounts,
  type BackupVerification
} from "./backup-verifier.js";

const execFileAsync = promisify(execFile);

/** A consistent view of the database that `pg_dump --snapshot` reads, with the counts taken in it. */
export interface BackupSnapshot {
  readonly snapshotId: string;
  readonly counts: BackupTableCounts;
  /** Ends the exporting transaction. The snapshot is unusable afterwards; calling it twice is fine. */
  release(): Promise<void>;
}

/** The part of a snapshot a backup needs; the caller that opened it releases it. */
export type BackupSnapshotReference = Pick<BackupSnapshot, "snapshotId" | "counts">;

export interface BackupDatabase {
  openSnapshot(tables: readonly string[]): Promise<BackupSnapshot>;
}

export interface BackupServiceOptions {
  getDatabaseContext: () => BackupDatabaseContext | null;
  getStorageSettings: () => Promise<StorageSettings>;
  keyTables?: readonly string[];
  openDatabase?: (connection: PostgresSidecarConnection) => BackupDatabase;
  verifier?: Pick<BackupVerifier, "verify">;
  logger?: Pick<Console, "warn">;
}

export interface BackupCreateOptions {
  /** A snapshot the caller opened and will release; its counts are what the dump is verified against. */
  snapshot?: BackupSnapshotReference;
  /** Prove the dump restorable before reporting success. Defaults to true. */
  verify?: boolean;
}

const manifestVersion = 2;

export class BackupService {
  private readonly verifier: Pick<BackupVerifier, "verify">;

  public constructor(private readonly options: BackupServiceOptions) {
    this.verifier =
      options.verifier ??
      new BackupVerifier({
        getDatabaseContext: options.getDatabaseContext,
        ...(options.logger ? { logger: options.logger } : {})
      });
  }

  /**
   * Opens a REPEATABLE READ transaction, exports its snapshot and counts the key tables in it. A
   * caller that needs the counts before the dump (the topic switch) passes the result to `create`
   * and releases it afterwards.
   */
  public async openSnapshot(): Promise<BackupSnapshot> {
    const context = this.options.getDatabaseContext();
    if (!context) throw new Error("errors.database.notReady");
    return (this.options.openDatabase ?? openPgBackupDatabase)(context.connection).openSnapshot(
      this.options.keyTables ?? backupKeyTables
    );
  }

  public async create(
    destinationRoot: string,
    options: BackupCreateOptions = {}
  ): Promise<BackupResult> {
    const context = this.options.getDatabaseContext();
    if (!context) throw new Error("errors.database.notReady");
    const settings = await this.options.getStorageSettings();
    const verify = options.verify !== false;

    // The dump and the counts it is verified against come from one exported snapshot.
    const ownSnapshot = verify && !options.snapshot ? await this.openSnapshot() : null;
    const snapshot: BackupSnapshotReference | null = options.snapshot ?? ownSnapshot;

    const createdAt = new Date();
    const directory = join(destinationRoot, `memora-backup-${fileTimestamp(createdAt)}`);
    const dumpPath = join(directory, "database.dump");
    try {
      await mkdir(directory, { recursive: false });
      await dumpDatabase(context, dumpPath, snapshot?.snapshotId);
    } finally {
      await ownSnapshot?.release().catch(() => undefined);
    }

    let verification: BackupVerification | null = null;
    if (verify && snapshot) {
      try {
        verification = await this.verifier.verify(dumpPath, snapshot.counts);
      } catch (error) {
        await this.markUnverified(directory, createdAt, snapshot.counts, error);
        if (error instanceof BackupVerificationError) {
          error.backupPath = directory;
          (this.options.logger ?? console).warn(
            `[backup] verification failed (${error.failure}): ${error.detail}; kept ${directory}`
          );
        }
        throw error;
      }
    }

    const included: BackupResult["included"] = ["database"];
    if (settings.obsidianVaultPath) {
      const managedVaultPath = join(settings.obsidianVaultPath, settings.managedRoot);
      if (await isDirectory(managedVaultPath)) {
        await cp(managedVaultPath, join(directory, "obsidian", settings.managedRoot), {
          recursive: true,
          errorOnExist: true
        });
        included.push("obsidian");
      }
    }
    if (
      settings.uploadCopiesEnabled &&
      settings.uploadCopiesFolderPath &&
      (await isDirectory(settings.uploadCopiesFolderPath))
    ) {
      await cp(settings.uploadCopiesFolderPath, join(directory, "uploaded-files"), {
        recursive: true,
        errorOnExist: true
      });
      included.push("uploadedFiles");
    }
    await writeManifest(directory, {
      createdAt: createdAt.toISOString(),
      included,
      verifiedAt: verification?.verifiedAt ?? null,
      counts: snapshot?.counts ?? null
    });
    return {
      path: directory,
      createdAt: createdAt.toISOString(),
      included,
      verified: verification !== null
    };
  }

  /** A backup that failed verification stays in place, but its manifest says it is not to be trusted. */
  private async markUnverified(
    directory: string,
    createdAt: Date,
    counts: BackupTableCounts,
    error: unknown
  ): Promise<void> {
    await writeManifest(directory, {
      createdAt: createdAt.toISOString(),
      included: ["database"],
      verifiedAt: null,
      counts,
      verificationFailure: error instanceof BackupVerificationError ? error.failure : "unknown"
    }).catch(() => undefined);
  }
}

/** The key-table counts and snapshot of the live database, over one dedicated connection. */
export function openPgBackupDatabase(connection: PostgresSidecarConnection): BackupDatabase {
  return {
    async openSnapshot(tables) {
      const pool = createPgPool({
        connectionString: connection.connectionString,
        max: 1,
        connectionTimeoutMillis: 10_000,
        onError: () => undefined
      });
      const client = await pool.connect().catch(async (error: unknown) => {
        await closePgPool(pool).catch(() => undefined);
        throw error;
      });
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await client.query("rollback").catch(() => undefined);
        client.release();
        await closePgPool(pool).catch(() => undefined);
      };
      try {
        await client.query("begin isolation level repeatable read read only");
        const { rows } = await client.query<{ id: string }>("select pg_export_snapshot() as id");
        const snapshotId = rows[0]?.id;
        if (!snapshotId) throw new Error("PostgreSQL returned no snapshot identifier.");
        return { snapshotId, counts: await countTables(client, tables), release };
      } catch (error) {
        await release();
        throw error;
      }
    }
  };
}

async function dumpDatabase(
  context: BackupDatabaseContext,
  dumpPath: string,
  snapshotId: string | undefined
): Promise<void> {
  await execFileAsync(
    context.pgDumpPath,
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...(snapshotId ? [`--snapshot=${snapshotId}`] : []),
      "--host",
      context.connection.host,
      "--port",
      String(context.connection.port),
      "--username",
      context.connection.user,
      "--file",
      dumpPath,
      context.connection.database
    ],
    {
      env: { ...process.env, PGPASSWORD: context.connection.password },
      maxBuffer: 1024 * 1024
    }
  );
}

async function writeManifest(
  directory: string,
  manifest: {
    createdAt: string;
    included: BackupResult["included"];
    verifiedAt: string | null;
    counts: BackupTableCounts | null;
    verificationFailure?: string;
  }
): Promise<void> {
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify({ version: manifestVersion, ...manifest }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
