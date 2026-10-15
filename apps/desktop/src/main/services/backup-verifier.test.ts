import { describe, expect, it } from "vitest";

import {
  BackupVerificationError,
  BackupVerifier,
  backupKeyTables,
  backupVerificationConfig,
  scratchDatabaseName,
  tableDataEntries,
  type BackupCommandRunner,
  type BackupVerifierOptions,
  type VerifierDatabase
} from "./backup-verifier.js";

const connection = {
  host: "127.0.0.1",
  port: 5432,
  database: "memora",
  user: "memora",
  password: "database-secret",
  connectionString: "postgresql://memora:database-secret@127.0.0.1:5432/memora"
};
const fixedNow = () => new Date("2026-10-15T09:30:12.345Z");
const scratch = "memora_verify_20261015093012345";
const tables = ["chunks", "settings", "source_items"];
const counts = { chunks: 40, settings: 6, source_items: 3 };

function listingOf(names: readonly string[]): string {
  return [
    ";",
    "; Archive created at 2026-10-15 09:30:12 BST",
    ...names.map(
      (name, index) => `${100 + index}; 1259 ${16000 + index} TABLE public ${name} memora`
    ),
    ...names.map(
      (name, index) => `${200 + index}; 0 ${16000 + index} TABLE DATA public ${name} memora`
    )
  ].join("\n");
}

interface Harness {
  verifier: BackupVerifier;
  calls: string[];
  commands: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
  opened: () => number;
  warnings: string[];
}

function harness(
  input: {
    listing?: string;
    listFails?: string;
    restoreFails?: string;
    restoredCounts?: Record<string, number>;
    countFails?: boolean;
    createFails?: boolean;
    dropFails?: boolean;
    stale?: string[];
    databaseBytes?: number;
    freeBytes?: number;
    inspectFails?: boolean;
    context?: boolean;
  } = {}
): Harness {
  const calls: string[] = [];
  const commands: Harness["commands"] = [];
  const warnings: string[] = [];
  let openCount = 0;
  const runCommand: BackupCommandRunner = async (file, args, options) => {
    commands.push({ file, args, env: options.env });
    if (args[0] === "--list") {
      calls.push("list-archive");
      if (input.listFails) throw Object.assign(new Error("failed"), { stderr: input.listFails });
      return { stdout: input.listing ?? listingOf(tables), stderr: "" };
    }
    calls.push("restore");
    if (input.restoreFails)
      throw Object.assign(new Error("failed"), { stderr: input.restoreFails });
    return { stdout: "", stderr: "" };
  };
  const database: VerifierDatabase = {
    async inspect() {
      calls.push("inspect");
      if (input.inspectFails) throw new Error("connection refused");
      return { databaseBytes: input.databaseBytes ?? 1_000, dataDirectory: "/data/postgres" };
    },
    async listScratchDatabases() {
      calls.push("list-scratch");
      return input.stale ?? [];
    },
    async createScratchDatabase(name) {
      calls.push(`create ${name}`);
      if (input.createFails) throw new Error("could not create");
    },
    async countTables(name, names) {
      calls.push(`count ${name} ${names.join(",")}`);
      if (input.countFails) throw new Error("query failed");
      return input.restoredCounts ?? counts;
    },
    async dropScratchDatabase(name) {
      calls.push(`drop ${name}`);
      if (input.dropFails) throw new Error("database is being accessed");
    },
    async close() {
      calls.push("close");
    }
  };
  const options: BackupVerifierOptions = {
    getDatabaseContext: () =>
      input.context === false ? null : { connection, pgDumpPath: "/sidecar/bin/pg_dump" },
    openDatabase: () => {
      openCount += 1;
      return database;
    },
    runCommand,
    freeBytes: async (path) => {
      calls.push(`free ${path}`);
      return input.freeBytes ?? 10_000;
    },
    now: fixedNow,
    logger: { warn: (message: unknown) => void warnings.push(String(message)) }
  };
  return {
    verifier: new BackupVerifier(options),
    calls,
    commands,
    opened: () => openCount,
    warnings
  };
}

async function failureOf(work: Promise<unknown>): Promise<BackupVerificationError> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(BackupVerificationError);
  return error as BackupVerificationError;
}

describe("BackupVerifier", () => {
  it("restores the archive into a scratch database, compares the counts and drops it", async () => {
    const run = harness();
    const result = await run.verifier.verify("/backups/database.dump", counts);
    expect(result.counts).toEqual(counts);
    expect(result.databaseBytes).toBe(1_000);
    expect(result.freeBytes).toBe(10_000);
    expect(Date.parse(result.verifiedAt)).not.toBeNaN();
    expect(run.calls).toEqual([
      "list-archive",
      "list-scratch",
      "inspect",
      "free /data/postgres",
      `create ${scratch}`,
      "restore",
      `count ${scratch} ${tables.join(",")}`,
      `drop ${scratch}`,
      "close"
    ]);
  });

  it("uses the shipped pg_restore beside pg_dump and keeps the password out of argv", async () => {
    const run = harness();
    await run.verifier.verify("/backups/database.dump", counts);
    const [list, restore] = run.commands;
    expect(list?.file).toBe("/sidecar/bin/pg_restore");
    expect(list?.args).toEqual(["--list", "/backups/database.dump"]);
    expect(restore?.args).toEqual([
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--host",
      "127.0.0.1",
      "--port",
      "5432",
      "--username",
      "memora",
      "--dbname",
      scratch,
      "/backups/database.dump"
    ]);
    expect(restore?.args.join(" ")).not.toContain("database-secret");
    expect(restore?.env.PGPASSWORD).toBe("database-secret");
  });

  it("refuses an archive pg_restore cannot read, before touching the database", async () => {
    const run = harness({
      listFails: "pg_restore: error: could not read from input file: end of file"
    });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("dumpUnreadable");
    expect(error.message).toBe("errors.backup.verificationFailed");
    expect(error.detail).toContain("end of file");
    expect(run.opened()).toBe(0);
  });

  it("refuses a truncated archive whose listing is intact but whose restore fails, and drops the scratch database", async () => {
    const run = harness({
      restoreFails: "pg_restore: error: could not read from input file: end of file"
    });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("restoreFailed");
    expect(error.message).toBe("errors.backup.verificationFailed");
    expect(run.calls).toContain(`create ${scratch}`);
    expect(run.calls.slice(-2)).toEqual([`drop ${scratch}`, "close"]);
    expect(run.calls.some((call) => call.startsWith("count"))).toBe(false);
  });

  it("refuses an archive that lacks TABLE DATA for a key table", async () => {
    const run = harness({ listing: listingOf(["chunks", "source_items"]) });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("tableDataMissing");
    expect(error.detail).toContain("settings");
    expect(run.opened()).toBe(0);
  });

  it("refuses a table that is only defined, not filled, in the archive", async () => {
    const definitionsOnly = listingOf(tables)
      .split("\n")
      .filter((line) => !line.includes("TABLE DATA public settings"))
      .join("\n");
    const run = harness({ listing: definitionsOnly });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("tableDataMissing");
  });

  it("refuses a restore whose counts differ from the snapshot and names the tables", async () => {
    const run = harness({ restoredCounts: { chunks: 39, settings: 6, source_items: 3 } });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("countMismatch");
    expect(error.message).toBe("errors.backup.verificationFailed");
    expect(error.detail).toBe("chunks: snapshot 40, restored 39");
    expect(run.calls.slice(-2)).toEqual([`drop ${scratch}`, "close"]);
  });

  it("drops the scratch database when counting fails", async () => {
    const run = harness({ countFails: true });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("unavailable");
    expect(run.calls.slice(-2)).toEqual([`drop ${scratch}`, "close"]);
  });

  it("drops the scratch database when its creation reports an error", async () => {
    const run = harness({ createFails: true });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("unavailable");
    expect(run.calls).toContain(`drop ${scratch}`);
    expect(run.calls).not.toContain("restore");
  });

  it("requires free space of twice the database size, and accepts exactly that much", async () => {
    const short = harness({ databaseBytes: 1_000, freeBytes: 1_999 });
    const error = await failureOf(short.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("insufficientDisk");
    expect(error.message).toBe("errors.backup.insufficientDisk");
    expect(short.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(short.calls.at(-1)).toBe("close");

    const enough = harness({ databaseBytes: 1_000, freeBytes: 2_000 });
    await expect(enough.verifier.verify("/backups/database.dump", counts)).resolves.toBeDefined();
    expect(backupVerificationConfig.freeSpaceFactor).toBe(2);
  });

  it("reports an unreachable database as unavailable and still closes it", async () => {
    const run = harness({ inspectFails: true });
    const error = await failureOf(run.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("unavailable");
    expect(run.calls.at(-1)).toBe("close");
  });

  it("does not let a failed drop hide the verification result", async () => {
    const run = harness({ dropFails: true });
    await expect(run.verifier.verify("/backups/database.dump", counts)).resolves.toBeDefined();
    expect(run.warnings.join("\n")).toContain(`could not drop scratch database ${scratch}`);

    const failing = harness({
      dropFails: true,
      restoredCounts: { chunks: 0, settings: 0, source_items: 0 }
    });
    const error = await failureOf(failing.verifier.verify("/backups/database.dump", counts));
    expect(error.failure).toBe("countMismatch");
  });

  it("sweeps scratch databases a killed verification left behind, and only those", async () => {
    const run = harness({
      stale: ["memora_verify_20260101000000000", "memora_verify_not_a_timestamp"]
    });
    await run.verifier.verify("/backups/database.dump", counts);
    expect(run.calls).toContain("drop memora_verify_20260101000000000");
    expect(run.calls).not.toContain("drop memora_verify_not_a_timestamp");
    expect(run.calls.indexOf("drop memora_verify_20260101000000000")).toBeLessThan(
      run.calls.indexOf("inspect")
    );
  });

  it("runs verifications one after another", async () => {
    const single = harness();
    await single.verifier.verify("/backups/a.dump", counts);
    const run = harness();
    await Promise.all([
      run.verifier.verify("/backups/a.dump", counts),
      run.verifier.verify("/backups/b.dump", counts)
    ]);
    expect(run.calls).toEqual([...single.calls, ...single.calls]);
  });

  it("rejects an empty or unsafe table list and a missing database", async () => {
    const run = harness();
    await expect(run.verifier.verify("/backups/database.dump", {})).rejects.toThrow(/at least one/);
    await expect(
      run.verifier.verify("/backups/database.dump", { 'chunks"; drop table x; --': 1 })
    ).rejects.toThrow(/Invalid table name/);
    const offline = harness({ context: false });
    await expect(offline.verifier.verify("/backups/database.dump", counts)).rejects.toThrow(
      "errors.database.notReady"
    );
  });
});

describe("backup verification helpers", () => {
  it("lists schema-qualified tables that have TABLE DATA, with or without an owner column", () => {
    const listing = [
      ";     dbname: memora_app",
      "220; 1259 16713 TABLE public a memora_app",
      "4062; 0 16713 TABLE DATA public a memora_app",
      "4063; 0 16716 TABLE DATA public empty_t ",
      "4064; 0 16719 TABLE DATA ag_catalog ag_graph memora_app",
      "5000; 2606 16520 CONSTRAINT public chunks chunks_pkey memora_app"
    ].join("\n");
    expect([...tableDataEntries(listing)].sort()).toEqual([
      "ag_catalog.ag_graph",
      "public.a",
      "public.empty_t"
    ]);
  });

  it("names the scratch database memora_verify_<timestamp> from the UTC time", () => {
    expect(scratchDatabaseName(new Date("2026-10-15T09:30:12.345Z"))).toBe(scratch);
  });

  it("keeps typed defaults and the library-identifying tables", () => {
    expect(backupVerificationConfig).toEqual({
      freeSpaceFactor: 2,
      listTimeoutMs: 120_000,
      restoreTimeoutMs: 1_800_000,
      scratchDatabasePrefix: "memora_verify_"
    });
    expect(backupKeyTables).toEqual([
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
    ]);
  });
});
