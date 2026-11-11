// Starts a throwaway PostgreSQL server on a profile-shaped scratch folder (F5 T169).
//
// A profile-shaped folder is the layout `database-service.ts` uses: `<dir>/database/postgres-data`
// is the cluster and `<dir>/database/dev-connection.json` the development descriptor (mode 0600,
// never printed). Starting PostgreSQL writes to its data folder, so only folders under
// `<repo>/.cache/f<N>/scratch/` are accepted: `.cache/profiles/*`, the default `userData` and any
// path that escapes the root (`..`, a symlink) are refused.
import { chmod, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "@app/db";

const phasePattern = /^f\d+$/u;

async function realpathOfNearestAncestor(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...[...missing].reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Returns the real path of `path` (absolute, may not exist yet) when it is a folder strictly
 * inside `<repo>/.cache/f<N>/scratch/`; throws otherwise. The message never holds a credential.
 */
export async function assertScratchProfilePath(path: string, repoRoot: string): Promise<string> {
  const refusal = () =>
    new Error(
      `Refusing ${path}: a scratch profile must be an absolute folder under ` +
        `${join(repoRoot, ".cache", "f<N>", "scratch")}${sep} (never .cache/profiles/* or the default userData).`
    );
  if (!isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw refusal();
  const real = await realpathOfNearestAncestor(path);
  const cacheRoot = await realpathOfNearestAncestor(join(repoRoot, ".cache"));
  const parts = relative(cacheRoot, real).split(sep);
  const [phase, scratch, name] = parts;
  if (
    parts[0] === ".." ||
    phase === undefined ||
    !phasePattern.test(phase) ||
    scratch !== "scratch" ||
    name === undefined ||
    name === ""
  )
    throw refusal();
  return real;
}

/**
 * Resolves the paths a server will write to (`database/`, `postgres-data/`, the descriptor) and
 * refuses any that leaves the profile's real folder: a symlinked `database/` or `postgres-data`
 * would otherwise start PostgreSQL on a real profile although the root passed the check.
 */
export async function assertScratchProfileTree(real: string, repoRoot: string): Promise<void> {
  const paths = profilePaths(real);
  const inside = (path: string) => path.startsWith(`${real}${sep}`);
  for (const path of [
    paths.databaseDir,
    paths.dataDir,
    paths.connectionFile,
    paths.completionFile
  ]) {
    const resolved = await realpathOfNearestAncestor(path);
    if (!inside(resolved) || path !== resolved)
      throw new Error(
        `Refusing ${real}: ${relative(real, path)} resolves outside the scratch profile ` +
          `(a symlink under ${join(repoRoot, ".cache", "f<N>", "scratch")}${sep} is not followed).`
      );
  }
}

export const profileConnectionFileSchema = z
  .object({
    version: z.literal(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1)
  })
  .passthrough();
export type ProfileConnectionFile = z.infer<typeof profileConnectionFileSchema>;

export function profilePaths(profileDir: string) {
  const databaseDir = join(profileDir, "database");
  return {
    databaseDir,
    dataDir: join(databaseDir, "postgres-data"),
    connectionFile: join(databaseDir, "dev-connection.json"),
    completionFile: join(databaseDir, "seed-complete.json")
  };
}

/** Marks a kept cluster as fully migrated and seeded; written last, so a failed run has none. */
export async function writeProfileCompletionMarker(
  profileDir: string,
  facts: Record<string, string | number>
): Promise<void> {
  await writeFile(
    profilePaths(profileDir).completionFile,
    `${JSON.stringify({ version: 1, ...facts, completedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

/** Writes the development descriptor (mode 0600). The password stays in the file, never in logs. */
export async function writeProfileConnectionFile(
  profileDir: string,
  connection: { host: string; port: number; database: string; user: string; password: string }
): Promise<void> {
  const { databaseDir, connectionFile } = profilePaths(profileDir);
  await mkdir(databaseDir, { recursive: true });
  const body = {
    version: 1,
    developmentOnly: true,
    ...connection,
    connectionString: `postgresql://${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`,
    updatedAt: new Date().toISOString()
  };
  await writeFile(connectionFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await chmod(connectionFile, 0o600);
}

export interface ProfileServer {
  /** Contains the password: pass it to the driver only, never print it. */
  readonly connectionString: string;
  readonly database: string;
  readonly profileDir: string;
  stop(): Promise<void>;
}

export interface StartProfileServerOptions {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  /** Start a cluster that carries no completion marker (a half-seeded one). Default false. */
  readonly allowIncomplete?: boolean;
}

/** Starts the cluster of a scratch profile on a dynamic port (the descriptor's port is stale). */
export async function startProfileServer(
  profileDir: string,
  options: StartProfileServerOptions
): Promise<ProfileServer> {
  const real = await assertScratchProfilePath(profileDir, options.repoRoot);
  await assertScratchProfileTree(real, options.repoRoot);
  const paths = profilePaths(real);
  let descriptor: ProfileConnectionFile;
  try {
    descriptor = profileConnectionFileSchema.parse(
      JSON.parse(await readFile(paths.connectionFile, "utf8"))
    );
  } catch {
    throw new Error(`The scratch profile has no readable database/dev-connection.json: ${real}`);
  }
  if (!options.allowIncomplete) {
    try {
      await readFile(paths.completionFile, "utf8");
    } catch {
      throw new Error(
        `The scratch profile is not marked complete (database/seed-complete.json): a seeding run ` +
          `that failed or is still running leaves none: ${real}`
      );
    }
  }
  const sidecar = resolvePostgresSidecarPaths({
    cwd: options.repoRoot,
    env: options.env ?? process.env
  });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: paths.dataDir,
    database: descriptor.database,
    user: descriptor.user,
    password: descriptor.password,
    startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
    shutdownTimeoutMs: 10_000
  });
  const started = await manager.start();
  return {
    connectionString: started.connectionString,
    database: descriptor.database,
    profileDir: real,
    stop: () => manager.stop()
  };
}

export interface JournalEntry {
  readonly tag: string;
  readonly [key: string]: unknown;
}

/** The journal with its entries up to and including `tag`; throws when the tag is unknown. */
export function truncateJournal<T extends { entries: JournalEntry[] }>(journal: T, tag: string): T {
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`Unknown migration tag "${tag}".`);
  return { ...journal, entries: journal.entries.slice(0, index + 1) };
}

/**
 * Copies a Drizzle folder to `destination` with its journal truncated after `tag`, so
 * `runMigrations` stops at that migration. Returns the number of migrations kept; the caller
 * removes `destination`.
 */
export async function copyMigrationsToTag(
  source: string,
  destination: string,
  tag: string
): Promise<number> {
  const journal = truncateJournal(
    JSON.parse(await readFile(join(source, "meta", "_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    },
    tag
  );
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  await writeFile(
    join(destination, "meta", "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`
  );
  return journal.entries.length;
}
