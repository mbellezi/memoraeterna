import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { NodeSidecarCommandRunner } from "./nodeRunner.js";
import type {
  PostgresSidecarConfig,
  PostgresSidecarConnection,
  PostgresSidecarState,
  SidecarCommandRunner
} from "./types.js";

const defaultHost = "127.0.0.1";
const defaultCommandTimeoutMs = 10_000;

export class PostgresSidecarManager {
  private readonly binDir: string;
  private readonly dataDir: string;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly host: string;
  private readonly configuredPort: number | undefined;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly extraServerOptions: readonly string[];
  private readonly runner: SidecarCommandRunner;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error"> | undefined;
  private child: ChildProcess | null = null;
  private currentConnection: PostgresSidecarConnection | null = null;
  private state: PostgresSidecarState = "stopped";

  constructor(config: PostgresSidecarConfig) {
    this.binDir = resolve(config.binDir);
    this.dataDir = resolve(config.dataDir);
    this.database = config.database;
    this.user = config.user;
    this.password = config.password;
    this.host = config.host ?? defaultHost;
    this.configuredPort = config.port;
    this.startupTimeoutMs = config.startupTimeoutMs ?? 15_000;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;
    this.extraServerOptions = config.extraServerOptions ?? [];
    this.runner = config.runner ?? new NodeSidecarCommandRunner();
    this.logger = config.logger;
  }

  getState(): PostgresSidecarState {
    return this.state;
  }

  getConnection(): PostgresSidecarConnection | null {
    return this.currentConnection;
  }

  async initdb(): Promise<void> {
    await this.ensureBinaries();
    if (await pathExists(join(this.dataDir, "PG_VERSION"))) {
      return;
    }

    await mkdir(this.dataDir, { recursive: true });
    const passwordFile = join(dirname(this.dataDir), `.memora-initdb-password-${process.pid}`);
    await writeFile(passwordFile, this.password, { mode: 0o600 });
    try {
      await this.runner.execFile(this.bin("initdb"), [
        "-D",
        this.dataDir,
        "-U",
        this.user,
        "--encoding=UTF8",
        "--locale=C",
        "--auth=scram-sha-256",
        `--pwfile=${passwordFile}`
      ]);
    } finally {
      await rm(passwordFile, { force: true });
    }

    await writeFile(
      join(this.dataDir, "pg_hba.conf"),
      [
        "# Managed by Memora Eterna.",
        "host all all 127.0.0.1/32 scram-sha-256",
        "host all all ::1/128 scram-sha-256",
        "local all all scram-sha-256",
        ""
      ].join("\n")
    );
  }

  async start(): Promise<PostgresSidecarConnection> {
    if (this.state === "running" && this.currentConnection) {
      return this.currentConnection;
    }
    if (this.state !== "stopped") {
      throw new Error(`Cannot start Postgres sidecar while state is ${this.state}.`);
    }

    this.state = "starting";
    try {
      await this.initdb();
      await this.recoverPostmasterPid();
      const port = this.configuredPort ?? (await findAvailablePort(this.host));
      const args = [
        "-D",
        this.dataDir,
        "-c",
        `listen_addresses=${this.host}`,
        "-c",
        `port=${port}`,
        "-c",
        "password_encryption=scram-sha-256",
        ...this.extraServerOptions
      ];
      const env = this.envWithPassword();
      this.child = this.runner.spawn(this.bin("postgres"), args, { env });
      this.child.once("exit", () => {
        if (this.state !== "stopping") {
          this.logger?.warn("Postgres sidecar exited outside a managed shutdown.");
        }
        this.child = null;
        this.currentConnection = null;
        if (this.state !== "stopping") {
          this.state = "stopped";
        }
      });

      await this.waitUntilReady(port);
      await this.ensureDatabase(port);
      this.currentConnection = {
        host: this.host,
        port,
        database: this.database,
        user: this.user,
        password: this.password,
        connectionString: buildConnectionString({
          host: this.host,
          port,
          database: this.database,
          user: this.user,
          password: this.password
        })
      };
      this.state = "running";
      return this.currentConnection;
    } catch (error) {
      this.state = "stopped";
      this.currentConnection = null;
      if (this.child) {
        this.child.kill("SIGTERM");
        this.child = null;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }

    this.state = "stopping";
    try {
      await this.runner.execFile(this.bin("pg_ctl"), ["-D", this.dataDir, "-m", "fast", "-w", "stop"], {
        env: this.envWithPassword(),
        timeoutMs: this.shutdownTimeoutMs
      });
    } catch (error) {
      this.logger?.warn(`pg_ctl stop failed, falling back to process signal: ${String(error)}`);
      if (this.child) {
        await terminateChild(this.child, this.shutdownTimeoutMs);
      }
    } finally {
      this.child = null;
      this.currentConnection = null;
      this.state = "stopped";
    }
  }

  async restart(): Promise<PostgresSidecarConnection> {
    await this.stop();
    return this.start();
  }

  private async ensureBinaries(): Promise<void> {
    await Promise.all(["initdb", "postgres", "pg_ctl", "pg_isready", "createdb"].map((binary) => assertExecutable(this.bin(binary))));
  }

  private async recoverPostmasterPid(): Promise<void> {
    const pidFile = join(this.dataDir, "postmaster.pid");
    if (!(await pathExists(pidFile))) {
      return;
    }

    const content = await readFile(pidFile, "utf8");
    const pid = Number.parseInt(content.split("\n")[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0 || !isProcessAlive(pid)) {
      this.logger?.warn("Removing stale postmaster.pid before starting Postgres sidecar.");
      await unlink(pidFile);
      return;
    }

    this.logger?.warn(`Found live Postgres pid ${pid}; requesting clean shutdown before restart.`);
    await this.runner.execFile(this.bin("pg_ctl"), ["-D", this.dataDir, "-m", "fast", "-w", "stop"], {
      env: this.envWithPassword(),
      timeoutMs: this.shutdownTimeoutMs
    });
  }

  private async waitUntilReady(port: number): Promise<void> {
    const startedAt = Date.now();
    let lastError = "";
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      try {
        await this.runner.execFile(this.bin("pg_isready"), ["-h", this.host, "-p", String(port), "-U", this.user], {
          env: this.envWithPassword(),
          timeoutMs: 2_000
        });
        return;
      } catch (error) {
        lastError = String(error);
        await delay(150);
      }
    }
    throw new Error(`Postgres sidecar did not become ready within ${this.startupTimeoutMs}ms. ${lastError}`);
  }

  private async ensureDatabase(port: number): Promise<void> {
    try {
      await this.runner.execFile(
        this.bin("createdb"),
        [
          "-h",
          this.host,
          "-p",
          String(port),
          "-U",
          this.user,
          "--maintenance-db=postgres",
          this.database
        ],
        {
          env: this.envWithPassword(),
          timeoutMs: defaultCommandTimeoutMs
        }
      );
    } catch (error) {
      const message = String(error);
      if (!message.includes("already exists")) {
        throw error;
      }
    }
  }

  private envWithPassword(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PGCONNECT_TIMEOUT: "5",
      PGPASSWORD: this.password
    };
  }

  private bin(name: string): string {
    return join(this.binDir, process.platform === "win32" ? `${name}.exe` : name);
  }
}

export function buildConnectionString(connection: Omit<PostgresSidecarConnection, "connectionString">): string {
  const user = encodeURIComponent(connection.user);
  const password = encodeURIComponent(connection.password);
  const database = encodeURIComponent(connection.database);
  return `postgresql://${user}:${password}@${connection.host}:${connection.port}/${database}`;
}

async function assertExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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

async function findAvailablePort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a dynamic TCP port."));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    delay(timeoutMs).then(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    })
  ]);
}
