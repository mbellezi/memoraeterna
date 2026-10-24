import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackupService, type BackupDatabase, type BackupServiceOptions } from "./backup-service.js";
import { BackupVerificationError, type BackupVerification } from "./backup-verifier.js";

const snapshotCounts = { source_items: 12, chunks: 340 };
const verification: BackupVerification = {
  verifiedAt: "2026-10-15T10:00:00.000Z",
  counts: snapshotCounts,
  databaseBytes: 1_000,
  freeBytes: 5_000,
  restoreMs: 10,
  durationMs: 20
};

describe.skipIf(process.platform === "win32")("BackupService", () => {
  let root: string;
  let destination: string;
  let vault: string;
  let uploads: string;
  let events: string[];

  beforeEach(async () => {
    events = [];
    root = await mkdtemp(join(tmpdir(), "memora-backup-test-"));
    destination = join(root, "backups");
    vault = join(root, "vault");
    uploads = join(root, "uploads");
    await Promise.all([
      mkdir(destination),
      mkdir(join(vault, "Memora"), { recursive: true }),
      mkdir(uploads)
    ]);
    await Promise.all([
      writeFile(join(vault, "Memora", "note.md"), "# Note\n"),
      writeFile(join(uploads, "source.pdf"), "source")
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A pg_dump stand-in that records its password and arguments, or fails on request. */
  async function fakePgDump(fails = false): Promise<string> {
    const path = join(root, "fake-pg-dump.sh");
    await writeFile(
      path,
      [
        "#!/bin/sh",
        "output=''",
        "previous=''",
        'for argument in "$@"; do',
        '  if [ "$previous" = \'--file\' ]; then output="$argument"; fi',
        '  previous="$argument"',
        "done",
        ...(fails ? ["echo 'pg_dump: error: connection failed' >&2", "exit 1"] : []),
        'printf \'%s\\n%s\\n\' "$PGPASSWORD" "$*" > "$output"'
      ].join("\n")
    );
    await chmod(path, 0o700);
    return path;
  }

  function database(): BackupDatabase {
    return {
      openSnapshot: async (tables) => {
        events.push(`open ${tables.join(",")}`);
        return {
          snapshotId: "00000003-0000001B-1",
          counts: snapshotCounts,
          release: async () => void events.push("release")
        };
      }
    };
  }

  async function service(
    overrides: Partial<BackupServiceOptions> & { pgDump?: string } = {}
  ): Promise<BackupService> {
    const { pgDump, ...options } = overrides;
    const pgDumpPath = pgDump ?? (await fakePgDump());
    return new BackupService({
      getDatabaseContext: () => ({
        connection: {
          host: "127.0.0.1",
          port: 5432,
          database: "memora",
          user: "memora",
          password: "database-secret",
          connectionString: "postgresql://redacted"
        },
        pgDumpPath
      }),
      getStorageSettings: async () => ({
        obsidianVaultPath: vault,
        managedRoot: "Memora",
        obsidianSyncEnabled: true,
        obsidianSyncPaused: false,
        uploadCopiesEnabled: true,
        uploadCopiesFolderPath: uploads,
        updatedAt: new Date().toISOString()
      }),
      keyTables: ["source_items", "chunks"],
      openDatabase: database,
      verifier: {
        verify: async (dumpPath, counts) => {
          events.push(`verify ${dumpPath.endsWith("database.dump")} ${JSON.stringify(counts)}`);
          return verification;
        }
      },
      logger: { warn: () => undefined },
      ...options
    });
  }

  async function readManifest(path: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  it("dumps the database without putting the password in argv and copies managed files", async () => {
    const result = await (await service()).create(destination);
    const [password, argv] = (await readFile(join(result.path, "database.dump"), "utf8"))
      .trim()
      .split("\n");
    expect(password).toBe("database-secret");
    expect(argv).not.toContain("database-secret");
    expect(await readFile(join(result.path, "obsidian", "Memora", "note.md"), "utf8")).toBe(
      "# Note\n"
    );
    expect(await readFile(join(result.path, "uploaded-files", "source.pdf"), "utf8")).toBe(
      "source"
    );
    expect(result.included).toEqual(["database", "obsidian", "uploadedFiles"]);
  });

  it("dumps from one exported snapshot, verifies against its counts and records both", async () => {
    const result = await (await service()).create(destination);
    const argv = (await readFile(join(result.path, "database.dump"), "utf8")).split("\n")[1];
    expect(argv).toContain("--snapshot=00000003-0000001B-1");
    expect(events).toEqual([
      "open source_items,chunks",
      "release",
      `verify true ${JSON.stringify(snapshotCounts)}`
    ]);
    expect(result.verified).toBe(true);
    expect(await readManifest(result.path)).toEqual({
      version: 2,
      createdAt: result.createdAt,
      included: ["database", "obsidian", "uploadedFiles"],
      verifiedAt: verification.verifiedAt,
      counts: snapshotCounts
    });
  });

  it("uses a snapshot the caller opened and leaves its release to the caller", async () => {
    const backups = await service();
    const snapshot = await backups.openSnapshot();
    events.length = 0;
    const result = await backups.create(destination, { snapshot });
    expect(events).toEqual([`verify true ${JSON.stringify(snapshotCounts)}`]);
    expect(result.verified).toBe(true);
    expect((await readFile(join(result.path, "database.dump"), "utf8")).split("\n")[1]).toContain(
      "--snapshot=00000003-0000001B-1"
    );
  });

  it("skips snapshot and verification when the caller verifies on its own", async () => {
    const result = await (await service()).create(destination, { verify: false });
    expect(events).toEqual([]);
    expect(result.verified).toBe(false);
    expect(
      (await readFile(join(result.path, "database.dump"), "utf8")).split("\n")[1]
    ).not.toContain("--snapshot");
    expect(await readManifest(result.path)).toMatchObject({
      version: 2,
      verifiedAt: null,
      counts: null
    });
  });

  it("releases the snapshot when the dump fails", async () => {
    const backups = await service({ pgDump: await fakePgDump(true) });
    await expect(backups.create(destination)).rejects.toThrow();
    expect(events).toEqual(["open source_items,chunks", "release"]);
  });

  it("keeps a backup that failed verification, marks it unverified and fails with a localized key", async () => {
    const backups = await service({
      verifier: {
        verify: async () => {
          throw new BackupVerificationError("countMismatch", "chunks: snapshot 340, restored 339");
        }
      }
    });
    const error = await backups.create(destination).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(BackupVerificationError);
    const failure = error as BackupVerificationError;
    expect(failure.message).toBe("errors.backup.verificationFailed");
    expect(failure.backupPath).toBeDefined();
    expect(events).toContain("release");
    expect((await stat(join(failure.backupPath!, "database.dump"))).isFile()).toBe(true);
    expect(await readManifest(failure.backupPath!)).toMatchObject({
      version: 2,
      included: ["database"],
      verifiedAt: null,
      counts: snapshotCounts,
      verificationFailure: "countMismatch"
    });
    await expect(stat(join(failure.backupPath!, "obsidian"))).rejects.toThrow();
  });

  it("fails visibly when the database is not ready", async () => {
    const backups = new BackupService({
      getDatabaseContext: () => null,
      getStorageSettings: async () => {
        throw new Error("not reached");
      }
    });
    await expect(backups.create(destination)).rejects.toThrow("errors.database.notReady");
    await expect(backups.openSnapshot()).rejects.toThrow("errors.database.notReady");
  });
});
