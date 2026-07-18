import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeStorage } from "electron";
import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type PostgresSidecarConnection
} from "@app/db";
import type {
  DatabaseLifecycleState,
  DatabaseStatus,
  DatabaseStatusMessageKey
} from "../../shared/ipc";
import { resolveWorkspaceRoot } from "./workspace-paths.js";

interface StoredDatabaseCredentials {
  readonly version: 1;
  readonly database: string;
  readonly user: string;
  readonly encryptedPassword: string;
  readonly createdAt: string;
}

interface DatabaseCredentials {
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export interface DatabaseServiceOptions {
  readonly userDataPath: string;
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Pick<Console, "debug" | "info" | "error" | "warn">;
}

const statusMessageKeys = {
  starting: "database.status.starting",
  migrating: "database.status.migrating",
  ready: "database.status.ready",
  failed: "database.status.failed",
  stopping: "database.status.stopping",
  stopped: "database.status.stopped"
} satisfies Record<DatabaseLifecycleState, DatabaseStatusMessageKey>;

export class DatabaseService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Pick<Console, "debug" | "info" | "error" | "warn"> | undefined;
  private readonly databaseDir: string;
  private readonly dataDir: string;
  private readonly credentialsPath: string;
  private readonly developmentConnectionPath: string;
  private status: DatabaseStatus = createStatus("stopped");
  private manager: PostgresSidecarManager | null = null;
  private pool: PgPool | null = null;
  private connection: PostgresSidecarConnection | null = null;
  private sidecarBinDir: string | null = null;
  private startPromise: Promise<void> | null = null;

  public constructor(private readonly options: DatabaseServiceOptions) {
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.databaseDir = join(options.userDataPath, "database");
    this.dataDir = join(this.databaseDir, "postgres-data");
    this.credentialsPath = join(this.databaseDir, "credentials.json");
    this.developmentConnectionPath = join(this.databaseDir, "dev-connection.json");
  }

  public getStatus(): DatabaseStatus {
    return this.status;
  }

  public getPool(): PgPool | null {
    if (this.status.state !== "ready") {
      return null;
    }

    return this.pool;
  }

  public getConnection(): PostgresSidecarConnection | null {
    if (this.status.state !== "ready") {
      return null;
    }

    return this.connection;
  }

  public getBackupContext(): { connection: PostgresSidecarConnection; pgDumpPath: string } | null {
    if (this.status.state !== "ready" || !this.connection || !this.sidecarBinDir) return null;
    return {
      connection: this.connection,
      pgDumpPath: join(this.sidecarBinDir, process.platform === "win32" ? "pg_dump.exe" : "pg_dump")
    };
  }

  public async start(): Promise<DatabaseStatus> {
    if (this.status.state === "ready") {
      return this.getStatus();
    }

    if (this.status.state === "stopping") {
      return this.getStatus();
    }

    if (this.startPromise) {
      await this.startPromise;
      return this.getStatus();
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }

    return this.getStatus();
  }

  public async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
    }

    if (this.status.state === "stopped") {
      return;
    }

    this.setStatus("stopping");
    await this.closePool();

    try {
      await this.manager?.stop();
    } catch (error) {
      this.logger?.warn(redactError(error));
    } finally {
      this.connection = null;
      this.sidecarBinDir = null;
      this.manager = null;
      this.setStatus("stopped");
    }
  }

  private async startInternal(): Promise<void> {
    this.setStatus("starting");

    try {
      const credentials = await this.getOrCreateCredentials();
      const workspaceRoot = resolveWorkspaceRoot(this.options.cwd, this.env);
      const sidecarPaths = resolvePostgresSidecarPaths({
        cwd: workspaceRoot,
        env: this.env,
        ...(this.options.isPackaged ? { resourcesPath: this.options.resourcesPath } : {})
      });
      this.sidecarBinDir = sidecarPaths.binDir;
      const migrationsFolder = resolveMigrationsFolder({
        env: this.env,
        isPackaged: this.options.isPackaged,
        resourcesPath: this.options.resourcesPath,
        workspaceRoot
      });
      const seedFolder = resolveSeedFolder({
        env: this.env,
        isPackaged: this.options.isPackaged,
        resourcesPath: this.options.resourcesPath,
        workspaceRoot
      });
      const configuredPort = resolveConfiguredDatabasePort(this.env, this.logger);

      this.manager = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: this.dataDir,
        database: credentials.database,
        user: credentials.user,
        password: credentials.password,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000,
        ...(configuredPort !== undefined ? { port: configuredPort } : {}),
        ...(this.logger ? { logger: this.logger } : {})
      });

      this.connection = await withTimeout(this.manager.start(), 45_000, "Postgres sidecar start timed out.");
      this.setStatus("migrating");
      this.pool = createPgPool({
        connectionString: this.connection.connectionString,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        onError: (error) => {
          if (this.status.state !== "stopping" && this.status.state !== "stopped") {
            this.logger?.warn(redactError(error));
          }
        }
      });
      await withTimeout(
        runMigrations(this.pool, migrationsFolder, { seedFolder }),
        30_000,
        "Database migrations timed out."
      );
      if (!this.options.isPackaged) {
        await this.writeDevelopmentConnectionDescriptor(this.connection, sidecarPaths.binDir);
      }
      this.setStatus("ready");
    } catch (error) {
      await this.closePool();
      try {
        await this.manager?.stop();
      } catch (stopError) {
        this.logger?.warn(redactError(stopError));
      }
      this.connection = null;
      this.sidecarBinDir = null;
      this.manager = null;
      const redactedError = redactError(error);
      this.logger?.error(redactedError);
      this.setStatus("failed", redactedError);
    }
  }

  private async getOrCreateCredentials(): Promise<DatabaseCredentials> {
    await mkdir(this.databaseDir, { recursive: true });
    const hasExistingDataDir = existsSync(join(this.dataDir, "PG_VERSION"));
    const storedCredentials = await this.readStoredCredentials();

    if (storedCredentials) {
      return {
        database: storedCredentials.database,
        user: storedCredentials.user,
        password: decryptPassword(storedCredentials.encryptedPassword)
      };
    }

    if (hasExistingDataDir) {
      throw new Error("Database credentials are missing for the existing local data directory.");
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage is not available for local database credentials.");
    }

    const password = randomBytes(32).toString("hex");
    const stored: StoredDatabaseCredentials = {
      version: 1,
      database: "memora_app",
      user: "memora_app",
      encryptedPassword: safeStorage.encryptString(password).toString("base64"),
      createdAt: new Date().toISOString()
    };

    await mkdir(dirname(this.credentialsPath), { recursive: true });
    await writeFile(this.credentialsPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

    return {
      database: stored.database,
      user: stored.user,
      password
    };
  }

  private async readStoredCredentials(): Promise<StoredDatabaseCredentials | null> {
    try {
      const raw = await readFile(this.credentialsPath, "utf8");
      return parseStoredCredentials(raw);
    } catch {
      return null;
    }
  }

  private async writeDevelopmentConnectionDescriptor(
    connection: PostgresSidecarConnection,
    binDir: string
  ): Promise<void> {
    const descriptor = {
      version: 1,
      developmentOnly: true,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      connectionString: connection.connectionString,
      psqlPath: join(binDir, process.platform === "win32" ? "psql.exe" : "psql"),
      updatedAt: new Date().toISOString()
    };
    await writeFile(this.developmentConnectionPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.developmentConnectionPath, 0o600);
    this.logger?.debug(`DEV database connection descriptor: ${this.developmentConnectionPath}`);
  }

  private async closePool(): Promise<void> {
    const pool = this.pool;
    this.pool = null;

    if (!pool) {
      return;
    }

    try {
      await closePgPool(pool);
    } catch (error) {
      this.logger?.warn(redactError(error));
    }
  }

  private setStatus(state: DatabaseLifecycleState, error?: string): void {
    this.status = createStatus(state, error);
    this.logger?.info(`Database status: ${state}${error ? ` (${error})` : ""}`);
  }
}

function createStatus(state: DatabaseLifecycleState, error?: string): DatabaseStatus {
  return {
    state,
    messageKey: statusMessageKeys[state],
    updatedAt: new Date().toISOString(),
    ...(error ? { error } : {})
  };
}

function decryptPassword(encryptedPassword: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is not available for local database credentials.");
  }

  return safeStorage.decryptString(Buffer.from(encryptedPassword, "base64"));
}

function parseStoredCredentials(raw: string): StoredDatabaseCredentials | null {
  const value = JSON.parse(raw) as Partial<StoredDatabaseCredentials>;

  if (
    value.version !== 1 ||
    typeof value.database !== "string" ||
    typeof value.user !== "string" ||
    typeof value.encryptedPassword !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    version: 1,
    database: value.database,
    user: value.user,
    encryptedPassword: value.encryptedPassword,
    createdAt: value.createdAt
  };
}

function resolveMigrationsFolder(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly workspaceRoot: string;
}): string {
  if (input.env.MEMORA_DB_MIGRATIONS_DIR) {
    return resolve(input.env.MEMORA_DB_MIGRATIONS_DIR);
  }

  if (input.isPackaged) {
    return resolve(input.resourcesPath, "drizzle");
  }

  return resolve(input.workspaceRoot, "packages/db/drizzle");
}

function resolveSeedFolder(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly workspaceRoot: string;
}): string {
  if (input.env.MEMORA_DB_SEED_DIR) {
    return resolve(input.env.MEMORA_DB_SEED_DIR);
  }

  if (input.isPackaged) {
    return resolve(input.resourcesPath, "db-seed");
  }

  return resolve(input.workspaceRoot, "packages/db/seed");
}

function resolveConfiguredDatabasePort(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "warn"> | undefined
): number | undefined {
  const rawPort = env.MEMORA_DATABASE_PORT?.trim();
  if (!rawPort) {
    return undefined;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    logger?.warn(`Ignoring invalid MEMORA_DATABASE_PORT "${rawPort}"; falling back to a dynamic port.`);
    return undefined;
  }

  return port;
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/([^:\s/@]+):([^@\s]+)@/gi, "postgresql://$1:[redacted]@")
    .replace(/PGPASSWORD=([^\s]+)/g, "PGPASSWORD=[redacted]");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
