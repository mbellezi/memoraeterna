import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  closePgPool,
  createLegacyWipeRepository,
  createPgPool,
  legacyWipeSettingsKeys,
  legacyWipeTables,
  resolvePostgresSidecarPaths,
  type PgPool
} from "@app/db";
import { z } from "zod";

import {
  createLegacyWipeBackup,
  describeLegacyWipeError,
  LegacyWipeService,
  legacyWipePhases,
  previewFields,
  type LegacyWipePhase
} from "./legacy-wipe-service.js";

/**
 * Rehearsal driver of the legacy wipe (T36w; gate W runbook, steps A3 and A4). It runs the real
 * `LegacyWipeService` against a scratch database, never the owner's profile, and checks every
 * table of the database before and after:
 *
 *   npx tsx apps/desktop/src/main/services/verify-legacy-wipe.ts --scratch <slug> --token preview
 *   npx tsx apps/desktop/src/main/services/verify-legacy-wipe.ts --scratch <slug> --token <t> \
 *     --kill-after counted|backed_up|verified
 *   npx tsx apps/desktop/src/main/services/verify-legacy-wipe.ts --scratch <slug> --token <t>
 *
 * `--scratch <slug>` reads the connection that `npm run db:restore -- --name <slug>` wrote;
 * `--db <url>` names any other scratch database. `--token preview` prints the preview and its
 * token. `--kill-after <phase>` runs the wipe in a child process that SIGKILLs itself right after
 * that phase, then proves the database unchanged (every table, the legacy settings and jobs, the
 * projection clock). Without it the wipe runs to the end, the result is checked table by table,
 * and a second run must be a no-op. Backups go to `--backups <dir>` (default
 * `.cache/f2/legacy-wipe/rehearsal-backups`). The report is one JSON document on stdout; progress
 * goes to stderr. No connection string or password is printed.
 */

const workspace = resolve(import.meta.dirname, "../../../../..");
const childConnectionVariable = "MEMORA_LEGACY_WIPE_VERIFY_CONNECTION";
const childPgDumpVariable = "MEMORA_LEGACY_WIPE_VERIFY_PG_DUMP";

const usage = `Usage: npx tsx apps/desktop/src/main/services/verify-legacy-wipe.ts
  (--scratch <slug> | --db <url>) --token <token | preview>
  [--kill-after ${legacyWipePhases.filter((phase) => phase !== "wiped").join("|")}] [--backups <dir>]`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    db: { type: "string" },
    scratch: { type: "string" },
    token: { type: "string" },
    "kill-after": { type: "string" },
    backups: { type: "string" },
    child: { type: "boolean" },
    help: { type: "boolean" }
  }
});

// Synchronous, so a child's last phase line is written before it kills itself.
const log = (message: string) => writeSync(2, `[verify-legacy-wipe] ${message}\n`);
const stderrLogger = { info: log, warn: log, error: log };

const scratchConnectionSchema = z.looseObject({
  slug: z.string(),
  connectionString: z.string().min(1),
  binDir: z.string().min(1)
});

interface Target {
  connectionString: string;
  pgDumpPath: string;
  label: string;
}

async function resolveTarget(): Promise<Target> {
  if (values.child) {
    const connectionString = process.env[childConnectionVariable];
    const pgDumpPath = process.env[childPgDumpVariable];
    if (!connectionString || !pgDumpPath) throw new Error("The child run lost its target.");
    return { connectionString, pgDumpPath, label: "child" };
  }
  if ((values.db === undefined) === (values.scratch === undefined))
    throw new Error("Give exactly one of --scratch <slug> or --db <url>.");
  if (values.scratch !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.scratch))
      throw new Error(`Invalid scratch slug "${values.scratch}".`);
    const file = join(workspace, ".cache", "f0", `scratch-${values.scratch}.json`);
    const connection = scratchConnectionSchema.parse(JSON.parse(await readFile(file, "utf8")));
    return {
      connectionString: connection.connectionString,
      pgDumpPath: join(connection.binDir, "pg_dump"),
      label: `scratch ${connection.slug}`
    };
  }
  const binDir = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env }).binDir;
  return { connectionString: values.db!, pgDumpPath: join(binDir, "pg_dump"), label: "--db" };
}

function connectionOf(connectionString: string) {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectionString
  };
}

function wipeService(
  pool: PgPool,
  target: Target,
  backupRoot: string,
  afterPhase?: (phase: LegacyWipePhase) => void
) {
  return new LegacyWipeService({
    pool,
    backup: createLegacyWipeBackup({
      getDatabaseContext: () => ({
        connection: connectionOf(target.connectionString),
        pgDumpPath: target.pgDumpPath
      }),
      // A rehearsal backs up the database only: never a vault or upload folder named by the copy.
      getStorageSettings: async () => ({
        obsidianVaultPath: null,
        managedRoot: "Memora",
        obsidianSyncEnabled: false,
        obsidianSyncPaused: false,
        deletionPolicy: "tombstone",
        uploadCopiesEnabled: false,
        uploadCopiesFolderPath: null,
        updatedAt: new Date().toISOString()
      }),
      logger: stderrLogger
    }),
    backupRoot,
    logger: stderrLogger,
    ...(afterPhase ? { afterPhase } : {})
  });
}

/** Every table's rows, the legacy settings and jobs, and the projection clock. */
async function census(pool: PgPool) {
  const repository = createLegacyWipeRepository(pool);
  const clock = await pool.query<{ generation: string }>(
    "select generation::text as generation from obsidian_projection_clock where id = 1"
  );
  const record = await repository.readRecord();
  return {
    tables: await repository.countAllTables(),
    keys: (await repository.countKeys()).keys,
    clock: Number(clock.rows[0]?.generation ?? 0),
    wipeRuns: record?.runs.length ?? 0
  };
}

type Census = Awaited<ReturnType<typeof census>>;

const legacyRows = (snapshot: Census) =>
  legacyWipeTables.reduce((sum, table) => sum + (snapshot.tables[table] ?? 0), 0);

async function listBackups(root: string): Promise<string[]> {
  return (await readdir(root).catch(() => [])).filter((name) => name.startsWith("memora-backup-"));
}

async function scratchDatabases(pool: PgPool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    "select datname as name from pg_database where datname like 'memora\\_verify\\_%' order by 1"
  );
  return rows.map((row) => row.name);
}

/** The child of a `--kill-after` run: it dies by SIGKILL right after the phase. */
async function runChild(pool: PgPool, target: Target, backupRoot: string, token: string) {
  const killAfter = values["kill-after"] as LegacyWipePhase;
  await wipeService(pool, target, backupRoot, (phase) => {
    if (phase !== killAfter) return;
    log(`SIGKILL after ${phase}`);
    process.kill(process.pid, "SIGKILL");
  }).run({ mode: "wipe", token });
  log(`the run ended without reaching ${killAfter}`);
  process.exitCode = 3;
}

/** Runs the wipe in a child process that kills itself after one phase; returns its phase log. */
async function runKilledChild(target: Target, backupRoot: string, token: string, phase: string) {
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      import.meta.filename,
      "--child",
      "--token",
      token,
      "--kill-after",
      phase,
      "--backups",
      backupRoot
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        [childConnectionVariable]: target.connectionString,
        [childPgDumpVariable]: target.pgDumpPath
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    child.on("close", (exitCode, exitSignal) => done([exitCode, exitSignal]))
  );
  for (const line of stderr.split("\n").filter(Boolean))
    log(`child | ${line.replace(/^\[verify-legacy-wipe\] /, "")}`);
  if (signal !== "SIGKILL")
    throw new Error(
      `The child was not killed after ${phase} (exit ${code}, signal ${signal}): ${stderr
        .trim()
        .split("\n")
        .slice(-3)
        .join(" | ")}`
    );
  return stderr.split("\n").flatMap((line) => {
    const match = /LEGACY_WIPE_PHASE (\{.*\})/.exec(line);
    return match ? [JSON.parse(match[1]!) as { phase: string; ms: number }] : [];
  });
}

async function main() {
  if (values.help) {
    console.info(usage);
    return;
  }
  const token = values.token;
  if (!token) throw new Error(`--token is required.\n${usage}`);
  const killAfter = values["kill-after"];
  if (killAfter !== undefined && !["counted", "backed_up", "verified"].includes(killAfter))
    throw new Error(`--kill-after must be counted, backed_up or verified.\n${usage}`);
  if (killAfter !== undefined && token === "preview")
    throw new Error("--kill-after needs a token, not preview.");
  const backupRoot = resolve(
    values.backups ?? join(workspace, ".cache", "f2", "legacy-wipe", "rehearsal-backups")
  );
  const target = await resolveTarget();
  const pool = createPgPool({ connectionString: target.connectionString, max: 4 });
  try {
    if (values.child) return await runChild(pool, target, backupRoot, token);
    const before = await census(pool);
    log(
      `${target.label}: ${legacyRows(before)} legacy rows, ${Object.keys(before.tables).length} tables`
    );

    if (token === "preview") {
      const report = await wipeService(pool, target, backupRoot).run({ mode: "preview" });
      assert.deepEqual(await census(pool), before, "a preview changes nothing");
      console.info(
        JSON.stringify(
          { mode: "preview", outcome: report.outcome, ...previewFields(report) },
          null,
          2
        )
      );
      return;
    }

    if (killAfter !== undefined) {
      const backupsBefore = await listBackups(backupRoot);
      const phases = await runKilledChild(target, backupRoot, token, killAfter);
      assert.deepEqual(
        phases.map((entry) => entry.phase),
        legacyWipePhases.slice(0, legacyWipePhases.indexOf(killAfter as LegacyWipePhase) + 1),
        "the child logged every phase up to the kill"
      );
      const after = await census(pool);
      assert.deepEqual(after, before, `the database is unchanged after a kill after ${killAfter}`);
      const newBackups = (await listBackups(backupRoot)).filter(
        (name) => !backupsBefore.includes(name)
      );
      assert.equal(newBackups.length, killAfter === "counted" ? 0 : 1, "one backup per dump");
      assert.deepEqual(await scratchDatabases(pool), [], "no verification database is left");
      console.info(
        JSON.stringify(
          {
            mode: "kill",
            killedAfter: killAfter,
            intact: true,
            legacyRows: legacyRows(before),
            phases,
            backups: newBackups.map((name) => join(backupRoot, name))
          },
          null,
          2
        )
      );
      return;
    }

    const report = await wipeService(pool, target, backupRoot).run({ mode: "wipe", token });
    const after = await census(pool);
    if (report.outcome === "nothing") {
      assert.deepEqual(after, before, "nothing to wipe writes nothing");
      console.info(
        JSON.stringify({ mode: "wipe", outcome: "nothing", token: report.token }, null, 2)
      );
      return;
    }
    assert.equal(report.outcome, "wiped");
    for (const table of legacyWipeTables) assert.equal(after.tables[table], 0, `${table} is empty`);
    const deletedSettings = legacyWipeSettingsKeys.filter((key) => before.keys.settings[key] > 0);
    const deletedJobs = Object.values(before.keys.jobs).reduce((sum, value) => sum + value, 0);
    for (const [table, rows] of Object.entries(before.tables)) {
      if ((legacyWipeTables as readonly string[]).includes(table)) continue;
      const expected =
        table === "settings"
          ? rows - deletedSettings.length + (before.wipeRuns === 0 ? 1 : 0)
          : table === "jobs"
            ? rows - deletedJobs
            : rows;
      assert.equal(after.tables[table], expected, `${table} keeps its rows`);
    }
    assert.deepEqual(after.keys, {
      settings: Object.fromEntries(legacyWipeSettingsKeys.map((key) => [key, 0])),
      scopePageIds: 0,
      jobs: {},
      pagesByManagement: {},
      vaultFiles: before.keys.vaultFiles
    });
    assert.equal(after.clock, before.clock + 1, "the projection clock moved once");
    assert.equal(after.wipeRuns, before.wipeRuns + 1, "the run is recorded");
    const record = await createLegacyWipeRepository(pool).readRecord();
    assert.equal(record?.runs.at(-1)?.token, token);

    const again = await wipeService(pool, target, backupRoot).run({ mode: "wipe", token });
    assert.equal(again.outcome, "nothing", "a second run has nothing to wipe");
    assert.deepEqual(await census(pool), after, "a second run writes nothing");
    console.info(
      JSON.stringify(
        {
          mode: "wipe",
          outcome: report.outcome,
          token,
          backupPath: report.backupPath,
          verifiedAt: report.verifiedAt,
          databaseBytes: report.databaseBytes,
          legacyRowsBefore: legacyRows(before),
          legacyRowsAfter: legacyRows(after),
          counts: report.counts,
          keyCounts: report.keyCounts,
          settingsDeleted: deletedSettings,
          jobsDeleted: deletedJobs,
          unchangedTables: Object.keys(before.tables).length - legacyWipeTables.length - 2,
          timings: report.timings,
          secondRun: again.outcome
        },
        null,
        2
      )
    );
  } finally {
    await closePgPool(pool).catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  log(`FAILED: ${describeLegacyWipeError(error)}`);
  process.exitCode = 1;
}
