import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/**
 * Scratch PostgreSQL clusters (F0): initdb, start, stop and SQL helpers on the vendored PostgreSQL
 * sidecar binaries.
 *
 * A scratch cluster lives under `.cache/f0/scratch-<slug>/` and never touches the application's
 * own database under `~/Library/Application Support`. It uses SCRAM authentication with a
 * generated password and a loopback-only TCP port.
 */

const execFileAsync = promisify(execFile);

export const repoRoot = resolve(import.meta.dirname, "../..");
export const f0Dir = join(repoRoot, ".cache", "f0");

export const loopback = "127.0.0.1";
export const scratchUser = "memora_app";
export const scratchDatabase = "memora_app";

const slugPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function assertSlug(slug: string): string {
  if (!slugPattern.test(slug)) {
    throw new Error(
      `Invalid --name "${slug}": use 1-40 lowercase letters, digits or dashes, starting with a letter or digit.`
    );
  }
  return slug;
}

// --- Process helpers --------------------------------------------------------------------------

export function resolveBinDir(): string {
  return resolve(
    process.env.MEMORA_POSTGRES_BIN_DIR ??
      join(
        repoRoot,
        "vendor/sidecars/postgres",
        `${process.platform}-${process.arch}`,
        "postgresql-18.4",
        "bin"
      )
  );
}

export function binPath(name: string): string {
  return join(resolveBinDir(), process.platform === "win32" ? `${name}.exe` : name);
}

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Exit codes that are returned instead of thrown. */
  readonly allowExitCodes?: readonly number[];
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 256 * 1024 * 1024
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : -1;
    if (options.allowExitCodes?.includes(exitCode)) {
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode };
    }
    const name = command.split(sep).pop() ?? command;
    const detail = (failure.stderr ?? "").trim() || failure.message;
    throw new Error(`${name} failed (exit ${String(failure.code)}): ${detail}`, { cause: error });
  }
}

async function assertExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`Required PostgreSQL binary is missing or not executable: ${path}`);
  }
}

export async function assertSidecarBinaries(): Promise<string> {
  for (const binary of ["initdb", "postgres", "pg_ctl", "pg_isready", "psql", "pg_restore"]) {
    await assertExecutable(binPath(binary));
  }
  const { stdout } = await run(binPath("postgres"), ["--version"]);
  const version = stdout.trim();
  if (!/\b18\./.test(version)) {
    throw new Error(`Expected a PostgreSQL 18 sidecar, found: ${version}`);
  }
  return version;
}

// --- Layout, locking and connection file -------------------------------------------------------

export interface ScratchLayout {
  readonly slug: string;
  /** `.cache/f0/scratch-<slug>/` */
  readonly root: string;
  readonly dataDir: string;
  readonly logFile: string;
  /** `.cache/f0/scratch-<slug>.json` */
  readonly connectionFile: string;
  readonly lockFile: string;
}

export function scratchLayout(slug: string): ScratchLayout {
  assertSlug(slug);
  const root = join(f0Dir, `scratch-${slug}`);
  return {
    slug,
    root,
    dataDir: join(root, "data"),
    logFile: join(root, "postgres.log"),
    connectionFile: join(f0Dir, `scratch-${slug}.json`),
    lockFile: join(f0Dir, `scratch-${slug}.lock`)
  };
}

function assertInsideF0(path: string): void {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${f0Dir}${sep}scratch-`)) {
    throw new Error(`Refusing to touch a path outside .cache/f0/scratch-*: ${resolved}`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Serializes concurrent invocations for the same slug with a lock file holding the owner PID. */
export async function withLock<T>(layout: ScratchLayout, work: () => Promise<T>): Promise<T> {
  await mkdir(f0Dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(layout.lockFile, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerPid = Number.parseInt(await readFile(layout.lockFile, "utf8").catch(() => ""), 10);
      if (Number.isFinite(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
        throw new Error(
          `Scratch cluster "${layout.slug}" is locked by running process ${ownerPid}.`,
          {
            cause: error
          }
        );
      }
      await unlink(layout.lockFile).catch(() => undefined);
      if (attempt === 1) throw new Error(`Could not acquire ${layout.lockFile}.`, { cause: error });
    }
  }
  try {
    return await work();
  } finally {
    await unlink(layout.lockFile).catch(() => undefined);
  }
}

// --- Cluster lifecycle --------------------------------------------------------------------------

export interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function endpointEnv(endpoint: Pick<Endpoint, "password">): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: endpoint.password, PGCONNECT_TIMEOUT: "10" };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Creates the data directory with the same initdb settings the application uses. */
export async function initCluster(layout: ScratchLayout, password: string): Promise<void> {
  assertInsideF0(layout.root);
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  if (await pathExists(join(layout.dataDir, "PG_VERSION"))) return;
  const passwordFile = join(layout.root, ".initdb-password");
  await writeFile(passwordFile, password, { mode: 0o600 });
  try {
    await run(binPath("initdb"), [
      "-D",
      layout.dataDir,
      "-U",
      scratchUser,
      "--encoding=UTF8",
      "--locale=C",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`
    ]);
  } finally {
    await rm(passwordFile, { force: true });
  }
  await writeFile(
    join(layout.dataDir, "pg_hba.conf"),
    [
      "# Managed by scripts/db/scratch-cluster.ts.",
      "host all all 127.0.0.1/32 scram-sha-256",
      "host all all ::1/128 scram-sha-256",
      "local all all scram-sha-256",
      ""
    ].join("\n")
  );
}

export interface ClusterStatus {
  readonly running: boolean;
  readonly port: number | null;
}

/** `pg_ctl status` exits 0 when running, 3 when stopped and 4 without a data directory. */
export async function clusterStatus(layout: ScratchLayout): Promise<ClusterStatus> {
  if (!(await pathExists(join(layout.dataDir, "PG_VERSION")))) {
    return { running: false, port: null };
  }
  const result = await run(binPath("pg_ctl"), ["-D", layout.dataDir, "status"], {
    allowExitCodes: [3, 4]
  });
  if (result.exitCode !== 0) return { running: false, port: null };
  const pidFile = await readFile(join(layout.dataDir, "postmaster.pid"), "utf8");
  const port = Number.parseInt(pidFile.split("\n")[3] ?? "", 10);
  return { running: true, port: Number.isFinite(port) ? port : null };
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, loopback, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a TCP port."));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function logTail(layout: ScratchLayout, lines = 15): Promise<string> {
  try {
    return (await readFile(layout.logFile, "utf8")).trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no server log)";
  }
}

async function waitUntilReady(port: number, password: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const result = await run(
      binPath("pg_isready"),
      ["-h", loopback, "-p", String(port), "-U", scratchUser],
      { env: endpointEnv({ password }), allowExitCodes: [1, 2, 3], timeoutMs: 5_000 }
    );
    if (result.exitCode === 0) return;
    lastError = result.stdout.trim();
    await delay(150);
  }
  throw new Error(`PostgreSQL did not become ready on port ${port}. ${lastError}`);
}

/** Starts the cluster on a free loopback port and returns the port; reuses a running instance. */
export async function startCluster(layout: ScratchLayout, password: string): Promise<number> {
  const status = await clusterStatus(layout);
  if (status.running && status.port !== null) return status.port;
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await findFreePort();
    const serverOptions = [
      `-p ${port}`,
      `-c listen_addresses=${loopback}`,
      "-c unix_socket_directories=''",
      "-c password_encryption=scram-sha-256",
      "-c maintenance_work_mem=512MB"
    ].join(" ");
    try {
      await run(
        binPath("pg_ctl"),
        [
          "-D",
          layout.dataDir,
          "-l",
          layout.logFile,
          "-w",
          "-t",
          "60",
          "-o",
          serverOptions,
          "start"
        ],
        { env: endpointEnv({ password }), timeoutMs: 90_000 }
      );
      await waitUntilReady(port, password);
      return port;
    } catch (error) {
      lastError = `${String(error)}\n${await logTail(layout)}`;
      await stopCluster(layout);
    }
  }
  throw new Error(`Could not start the scratch cluster after 3 attempts.\n${lastError}`);
}

/** Stops the cluster if it is running. Returns whether it was running. */
export async function stopCluster(layout: ScratchLayout): Promise<boolean> {
  const status = await clusterStatus(layout);
  if (!status.running) return false;
  await run(binPath("pg_ctl"), ["-D", layout.dataDir, "-m", "fast", "-w", "-t", "60", "stop"], {
    timeoutMs: 90_000
  });
  return true;
}

/** Stops the cluster and deletes its directory, connection file and lock. */
export async function removeCluster(layout: ScratchLayout): Promise<void> {
  assertInsideF0(layout.root);
  await stopCluster(layout);
  await rm(layout.root, { recursive: true, force: true });
  await rm(layout.connectionFile, { force: true });
}

// --- SQL helpers ------------------------------------------------------------------------------

/** psql arguments shared by every query: no psqlrc, stop on error, one database. */
export function psqlArgs(endpoint: Endpoint, database: string, extra: readonly string[]): string[] {
  const connection = ["-h", endpoint.host, "-p", String(endpoint.port), "-U", endpoint.user];
  return ["-X", ...connection, "-d", database, "-v", "ON_ERROR_STOP=1", ...extra];
}

/** Runs `sql` through psql and returns its rows as JSON objects. */
export async function queryRows<T = Record<string, unknown>>(
  endpoint: Endpoint,
  sql: string,
  database: string = endpoint.database
): Promise<T[]> {
  const wrapped = `select coalesce(json_agg(t), '[]'::json) from (${sql.trim().replace(/;+$/, "")}) t`;
  const { stdout } = await run(
    binPath("psql"),
    psqlArgs(endpoint, database, ["-A", "-t", "-q", "-c", wrapped]),
    { env: endpointEnv(endpoint) }
  );
  return JSON.parse(stdout.trim() || "[]") as T[];
}

/** Executes statements that return no rows (DDL, ANALYZE). */
export async function execSql(
  endpoint: Endpoint,
  sql: string,
  database: string = endpoint.database
): Promise<void> {
  await run(binPath("psql"), psqlArgs(endpoint, database, ["-q", "-c", sql]), {
    env: endpointEnv(endpoint),
    timeoutMs: 600_000
  });
}

export async function databaseExists(endpoint: Endpoint, database: string): Promise<boolean> {
  const rows = await queryRows<{ n: number }>(
    endpoint,
    `select count(*)::int as n from pg_database where datname = '${database.replace(/'/g, "''")}'`,
    "postgres"
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function createDatabase(endpoint: Endpoint, database: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error(`Invalid database name "${database}".`);
  await execSql(endpoint, `create database ${database} encoding 'UTF8'`, "postgres");
}
