import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

interface CommandResult {
  stdout: string;
  stderr: string;
}

const defaultSidecarRoot = join(
  process.cwd(),
  "vendor/sidecars/postgres",
  `${process.platform}-${process.arch}`,
  "postgresql-18.4"
);
const binDir = process.env.MEMORA_POSTGRES_BIN_DIR ?? join(defaultSidecarRoot, "bin");
const extensionDir = process.env.MEMORA_POSTGRES_EXTENSION_DIR ?? join(defaultSidecarRoot, "lib/postgresql");

if (!binDir) {
  throw new Error("MEMORA_POSTGRES_BIN_DIR must point to a PostgreSQL 18 sidecar bin directory.");
}

const requiredBinaries = ["initdb", "postgres", "pg_ctl", "pg_isready", "psql", "createdb"];
for (const binary of requiredBinaries) {
  await assertExecutable(bin(binary));
}

const user = "memora_spike";
const database = "memora_spike";
const password = `memora-${process.pid}-${Date.now()}`;
const workDir = await mkdtemp(join(tmpdir(), "memora-postgres-spike-"));
const dataDir = join(workDir, "data");
const passwordFile = join(workDir, "password.txt");
const port = await findAvailablePort();
const env = {
  ...process.env,
  PGPASSWORD: password
};

const startedAt = performance.now();

try {
  await writeFile(passwordFile, password, { mode: 0o600 });
  await run(bin("initdb"), [
    "-D",
    dataDir,
    "-U",
    user,
    "--encoding=UTF8",
    "--locale=C",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`
  ]);

  await writeFile(
    join(dataDir, "pg_hba.conf"),
    [
      "# Managed by Memora Eterna sidecar spike.",
      "host all all 127.0.0.1/32 scram-sha-256",
      "host all all ::1/128 scram-sha-256",
      "local all all scram-sha-256",
      ""
    ].join("\n")
  );

  const serverOptions = [
    "-o",
    [
      `-p ${port}`,
      "-c listen_addresses=127.0.0.1",
      extensionDir ? `-c dynamic_library_path='${extensionDir}'` : ""
    ]
      .filter(Boolean)
      .join(" ")
  ];

  const coldStartStartedAt = performance.now();
  await run(bin("pg_ctl"), ["-D", dataDir, "-w", "start", ...serverOptions], { env });
  const coldStartMs = performance.now() - coldStartStartedAt;

  try {
    await waitReady(port, env);
    await run(bin("createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", user, database], {
      env
    });

    const version = await psql("select version();", env);
    const pgVersion = await readFile(join(dataDir, "PG_VERSION"), "utf8");
    await psql("create extension if not exists vector;", env);
    await psql("create extension if not exists age;", env);
    await psql("load 'age'; set search_path = ag_catalog, '$user', public; select create_graph('memora_spike_graph');", env);
    await psql(
      "load 'age'; set search_path = ag_catalog, '$user', public; select * from cypher('memora_spike_graph', $$ return 1 as ok $$) as (ok agtype);",
      env
    );
    await psql("select '[1,2,3]'::vector <-> '[1,2,4]'::vector as distance;", env);

    const extensions = await psql(
      "select extname, extversion from pg_extension where extname in ('vector', 'age') order by extname;",
      env
    );

    await run(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { env });

    const restartStartedAt = performance.now();
    await run(bin("pg_ctl"), ["-D", dataDir, "-w", "start", ...serverOptions], { env });
    await waitReady(port, env);
    const restartMs = performance.now() - restartStartedAt;
    await run(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { env });

    console.info(
      JSON.stringify(
        {
          postgresPgVersion: pgVersion.trim(),
          postgresVersion: version.stdout.trim(),
          extensions: extensions.stdout.trim().split("\n").filter(Boolean),
          coldStartMs: Math.round(coldStartMs),
          restartMs: Math.round(restartMs),
          totalMs: Math.round(performance.now() - startedAt)
        },
        null,
        2
      )
    );
  } catch (error) {
    await run(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { env }).catch(() => undefined);
    throw error;
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

function bin(name: string): string {
  return join(binDir!, process.platform === "win32" ? `${name}.exe` : name);
}

async function assertExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`Required PostgreSQL sidecar binary is missing or not executable: ${path}`);
  }
}

async function psql(sql: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return run(
    bin("psql"),
    ["-h", "127.0.0.1", "-p", String(port), "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { env }
  );
}

async function waitReady(port: number, env: NodeJS.ProcessEnv): Promise<void> {
  const timeoutAt = Date.now() + 15_000;
  let lastError = "";
  while (Date.now() < timeoutAt) {
    try {
      await run(bin("pg_isready"), ["-h", "127.0.0.1", "-p", String(port), "-U", user], {
        env,
        timeoutMs: 2_000
      });
      return;
    } catch (error) {
      lastError = String(error);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Postgres did not become ready on port ${port}. ${lastError}`);
}

function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        }, options.timeoutMs)
      : null;

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.once("exit", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`));
    });
  });
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local TCP port."));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}
