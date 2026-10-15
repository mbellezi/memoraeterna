import { createHash } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";

import {
  createLegacyStateRepository,
  createLegacyWipeRepository,
  hasLegacyContent,
  hasLegacyWipeState,
  legacyWipeTables,
  type LegacyContentCounts,
  type LegacyKeyCounts,
  type LegacyWipeRepository,
  type LegacyWipeRun,
  type LegacyWipeState,
  type PgPool
} from "@app/db";
import type { StorageSettings } from "../../shared/ipc.js";
import {
  BackupService,
  type BackupSnapshot,
  type BackupSnapshotReference
} from "./backup-service.js";
import {
  BackupVerificationError,
  BackupVerifier,
  backupKeyTables,
  type BackupDatabaseContext,
  type BackupTableCounts,
  type BackupVerification
} from "./backup-verifier.js";

/**
 * The legacy wipe (D4): it empties the pre-refactoring wiki, organization, curator and maintenance
 * tables of one database after a restore-verified backup. It runs only from the one-shot DEV knob
 * `MEMORA_LEGACY_WIPE=preview|<token>` (see `runLegacyWipeStartup`) or the rehearsal driver
 * `verify-legacy-wipe.ts`, never as a migration. No Electron import: everything is injected.
 *
 * Phases, logged as `LEGACY_WIPE_PHASE`:
 * 1. `counted`: the key and legacy tables counted in an exported snapshot, the legacy settings, jobs
 *    and vault files counted in a second session on that snapshot, and the token derived from them.
 * 2. `backed_up`: `pg_dump --snapshot` of that snapshot.
 * 3. `verified`: the dump restored into a scratch database with equal counts (`BackupVerifier`).
 * 4. `wiped`: one transaction locks, recounts, truncates, deletes and records (see the repository).
 *
 * Nothing is persisted before `wiped` and that transaction is atomic, so a crash at any point leaves
 * the legacy data either intact or completely wiped; a rerun starts over with a fresh backup.
 */

export const legacyWipeConfig = {
  /** A backup is taken only when the backup root's volume has this many times the database free. */
  freeSpaceFactor: 3,
  /** The wipe waits this long for its table locks, then refuses with nothing changed. */
  lockTimeoutMs: 30_000,
  /** Hex characters of the SHA-256 digest that form the token. */
  tokenLength: 12,
  /** Where the knob writes its backups, relative to the workspace root. */
  backupDirectory: [".cache", "f2", "legacy-wipe", "backups"]
} as const;

export const legacyWipePhases = ["counted", "backed_up", "verified", "wiped"] as const;
export type LegacyWipePhase = (typeof legacyWipePhases)[number];

/** The wipe's backup verifies the library's key tables and every table it empties. */
export const legacyWipeBackupKeyTables: readonly string[] = [
  ...new Set<string>([...backupKeyTables, ...legacyWipeTables])
].sort();

export type LegacyWipeRefusalReason =
  | "packaged"
  | "conflictingKnob"
  | "invalidValue"
  | "tokenMismatch"
  | "foreignKey"
  | "insufficientDisk"
  | "countsChanged";

/** A wipe that was refused before anything changed. `detail` never holds a credential. */
export class LegacyWipeRefusal extends Error {
  public constructor(
    public readonly reason: LegacyWipeRefusalReason,
    public readonly detail: string
  ) {
    super(`${reason}: ${detail}`);
    this.name = "LegacyWipeRefusal";
  }
}

export type LegacyWipeRequest = { mode: "preview" } | { mode: "wipe"; token: string };

export interface LegacyWipeTimings {
  countMs: number;
  dumpMs: number | null;
  verifyMs: number | null;
  lockMs: number | null;
  wipeMs: number | null;
  totalMs: number;
}

export interface LegacyWipeReport {
  /** `nothing`: no legacy rows, settings or jobs; no backup was taken and nothing was written. */
  outcome: "nothing" | "previewed" | "wiped";
  /** The legacy tables, as counted in the snapshot. */
  counts: LegacyWipeState["tables"];
  keyCounts: LegacyKeyCounts;
  /** The other key tables of the snapshot (sources, notes, embeddings, settings, AI profiles). */
  library: BackupTableCounts;
  /** Foreign keys from other tables into legacy ones; any of them blocks the wipe. */
  blockers: string[];
  databaseBytes: number;
  freeBytes: number | null;
  backupPath: string | null;
  verifiedAt: string | null;
  token: string;
  wipedAt: string | null;
  timings: LegacyWipeTimings;
}

/** The second `BackupService` of the wipe, with a hook between the dump and its verification. */
export interface LegacyWipeBackup {
  openSnapshot(): Promise<BackupSnapshot>;
  /** Dumps `snapshot` under `root` and verifies it by restore; `onDumped` runs between the two. */
  createVerified(
    root: string,
    snapshot: BackupSnapshotReference,
    onDumped: () => Promise<void>
  ): Promise<{ path: string; verifiedAt: string }>;
}

export interface LegacyWipeBackupOptions {
  getDatabaseContext: () => BackupDatabaseContext | null;
  getStorageSettings: () => Promise<StorageSettings>;
  logger?: Pick<Console, "warn">;
}

/**
 * A `BackupService` whose key tables are the backup's plus the 30 legacy tables, so the verifying
 * restore proves the dump holds every row the wipe removes. Vault and upload copies follow the
 * storage settings, as in a Settings backup.
 */
export function createLegacyWipeBackup(options: LegacyWipeBackupOptions): LegacyWipeBackup {
  const logger = options.logger ? { logger: options.logger } : {};
  const verifier = new BackupVerifier({
    getDatabaseContext: options.getDatabaseContext,
    ...logger
  });
  const service = (verify: Pick<BackupVerifier, "verify">) =>
    new BackupService({
      getDatabaseContext: options.getDatabaseContext,
      getStorageSettings: options.getStorageSettings,
      keyTables: legacyWipeBackupKeyTables,
      verifier: verify,
      ...logger
    });
  return {
    openSnapshot: () => service(verifier).openSnapshot(),
    async createVerified(root, snapshot, onDumped) {
      const result: { verification?: BackupVerification } = {};
      const backup = await service({
        verify: async (dumpPath, counts) => {
          await onDumped();
          result.verification = await verifier.verify(dumpPath, counts);
          return result.verification;
        }
      }).create(root, { snapshot });
      if (!backup.verified || !result.verification)
        throw new Error(`The legacy wipe backup ${backup.path} was not verified.`);
      return { path: backup.path, verifiedAt: result.verification.verifiedAt };
    }
  };
}

type LegacyWipeRepositoryPort = Pick<
  LegacyWipeRepository,
  "countKeys" | "foreignKeysIntoLegacy" | "wipe"
>;

export interface LegacyWipeServiceOptions {
  pool: PgPool;
  backup: LegacyWipeBackup;
  /** The directory that receives the backups (created with mode 0700). */
  backupRoot: string;
  logger: Pick<Console, "info">;
  now?: () => Date;
  /** Runs after each phase is logged; fault injection kills the process here. */
  afterPhase?: (phase: LegacyWipePhase) => Promise<void> | void;
  /** Free bytes on the volume that holds `path`. */
  freeBytes?: (path: string) => Promise<number>;
  repository?: LegacyWipeRepositoryPort;
}

export class LegacyWipeService {
  private readonly repository: LegacyWipeRepositoryPort;
  private readonly now: () => Date;

  public constructor(private readonly options: LegacyWipeServiceOptions) {
    this.repository = options.repository ?? createLegacyWipeRepository(options.pool);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * `preview` counts, backs up and verifies, then returns the token. `wipe` does the same, refuses
   * unless the token matches, then wipes. With nothing to wipe both return `nothing` and write
   * nothing, not even a backup.
   */
  public async run(request: LegacyWipeRequest): Promise<LegacyWipeReport> {
    const startedAt = this.clock();
    const blockers = (await this.repository.foreignKeysIntoLegacy()).map(
      (key) => `${key.fromTable}.${key.constraint} -> ${key.toTable}`
    );
    const snapshot = await this.options.backup.openSnapshot();
    try {
      const { keys, databaseBytes } = await this.repository.countKeys(snapshot.snapshotId);
      const state = legacyWipeState(snapshot.counts, keys);
      const token = legacyWipeToken(state);
      const report: LegacyWipeReport = {
        outcome: "nothing",
        counts: state.tables,
        keyCounts: keys,
        library: Object.fromEntries(
          Object.entries(snapshot.counts).filter(
            ([table]) => !(legacyWipeTables as readonly string[]).includes(table)
          )
        ),
        blockers,
        databaseBytes,
        freeBytes: null,
        backupPath: null,
        verifiedAt: null,
        token,
        wipedAt: null,
        timings: {
          countMs: this.clock() - startedAt,
          dumpMs: null,
          verifyMs: null,
          lockMs: null,
          wipeMs: null,
          totalMs: 0
        }
      };
      if (!hasLegacyWipeState(state)) return this.finish(report, startedAt);
      if (request.mode === "wipe" && request.token !== token)
        throw new LegacyWipeRefusal(
          "tokenMismatch",
          `the database now gives token ${token}, not ${request.token}; run the preview again`
        );
      if (request.mode === "wipe" && blockers.length > 0)
        throw new LegacyWipeRefusal(
          "foreignKey",
          `${blockers.join(", ")} would make the TRUNCATE fail; apply migration 0052 first`
        );

      await mkdir(this.options.backupRoot, { recursive: true, mode: 0o700 });
      report.freeBytes = await (this.options.freeBytes ?? freeBytesOnVolume)(
        this.options.backupRoot
      );
      if (report.freeBytes < legacyWipeConfig.freeSpaceFactor * databaseBytes)
        throw new LegacyWipeRefusal(
          "insufficientDisk",
          `${report.freeBytes} bytes free at the backup root, ${legacyWipeConfig.freeSpaceFactor} x ${databaseBytes} bytes required`
        );
      await this.phase("counted", report.timings.countMs);

      const dumpStartedAt = this.clock();
      let verifyStartedAt = dumpStartedAt;
      const backup = await this.options.backup.createVerified(
        this.options.backupRoot,
        snapshot,
        async () => {
          // The dump has imported the snapshot; holding it through the restore only delays vacuum.
          await snapshot.release();
          report.timings.dumpMs = this.clock() - dumpStartedAt;
          await this.phase("backed_up", report.timings.dumpMs);
          verifyStartedAt = this.clock();
        }
      );
      report.backupPath = backup.path;
      report.verifiedAt = backup.verifiedAt;
      report.timings.verifyMs = this.clock() - verifyStartedAt;
      await this.phase("verified", report.timings.verifyMs);
      if (request.mode === "preview")
        return this.finish({ ...report, outcome: "previewed" }, startedAt);

      const at = this.now().toISOString();
      const run: LegacyWipeRun = {
        reason: "wiped",
        at,
        backupPath: backup.path,
        verifiedAt: backup.verifiedAt,
        counts: state,
        token
      };
      const result = await this.repository.wipe(state, run, {
        lockTimeoutMs: legacyWipeConfig.lockTimeoutMs
      });
      if (result.outcome === "changed")
        throw new LegacyWipeRefusal(
          "countsChanged",
          `legacy data changed after the snapshot (${result.differences.join("; ")}); nothing was wiped, run the preview again`
        );
      report.timings.lockMs = result.lockMs;
      report.timings.wipeMs = result.wipeMs;
      await this.phase("wiped", result.lockMs + result.wipeMs);
      return this.finish({ ...report, outcome: "wiped", wipedAt: at }, startedAt);
    } finally {
      await snapshot.release();
    }
  }

  private finish(report: LegacyWipeReport, startedAt: number): LegacyWipeReport {
    return { ...report, timings: { ...report.timings, totalMs: this.clock() - startedAt } };
  }

  private async phase(phase: LegacyWipePhase, ms: number): Promise<void> {
    this.options.logger.info(`LEGACY_WIPE_PHASE ${JSON.stringify({ phase, ms })}`);
    await this.options.afterPhase?.(phase);
  }

  private clock(): number {
    return this.now().getTime();
  }
}

/** The legacy tables picked from a snapshot's counts, with the keys counted in the same snapshot. */
export function legacyWipeState(counts: BackupTableCounts, keys: LegacyKeyCounts): LegacyWipeState {
  const tables = Object.fromEntries(
    legacyWipeTables.map((table) => {
      const value = counts[table];
      if (value === undefined) throw new Error(`The snapshot did not count ${table}.`);
      return [table, value];
    })
  ) as LegacyWipeState["tables"];
  return { tables, keys };
}

/**
 * A short hash of everything the wipe removes or reports: a preview's token works only on a
 * database whose legacy state has not changed since.
 */
export function legacyWipeToken(state: LegacyWipeState): string {
  return createHash("sha256")
    .update(`legacy.wipe.v1\n${canonicalJson(state)}`)
    .digest("hex")
    .slice(0, legacyWipeConfig.tokenLength);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

async function freeBytesOnVolume(path: string): Promise<number> {
  const volume = await statfs(path);
  return Number(volume.bavail) * Number(volume.bsize);
}

// --- Startup: the LEGACY_RECREATED detector and the DEV knob ----------------------------------

export const legacyWipeKnob = "MEMORA_LEGACY_WIPE";

/** DEV knobs that change the library or start work; the wipe never runs beside one of them. */
export const legacyWipeConflictingKnobs = [
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK",
  "MEMORA_PROFILE_RESET"
] as const;

const tokenPattern = new RegExp(`^[0-9a-f]{${legacyWipeConfig.tokenLength}}$`);

/** Reads `MEMORA_LEGACY_WIPE`: null when unset; a refusal when packaged, mixed or malformed. */
export function readLegacyWipeKnob(
  env: NodeJS.ProcessEnv,
  options: { isPackaged: boolean }
): LegacyWipeRequest | null {
  const raw = env[legacyWipeKnob]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new LegacyWipeRefusal("packaged", `${legacyWipeKnob} is refused in packaged builds`);
  const others = legacyWipeConflictingKnobs.filter((name) => env[name]?.trim());
  if (others.length > 0)
    throw new LegacyWipeRefusal(
      "conflictingKnob",
      `${legacyWipeKnob} cannot run with ${others.join(", ")}`
    );
  if (raw === "preview") return { mode: "preview" };
  if (!tokenPattern.test(raw))
    throw new LegacyWipeRefusal(
      "invalidValue",
      `${legacyWipeKnob} must be "preview" or the token a preview printed`
    );
  return { mode: "wipe", token: raw };
}

/**
 * Logs `LEGACY_RECREATED` when this database was wiped and legacy content exists again: something
 * re-created what the wipe removed (old code, a stray writer).
 */
export async function detectLegacyRecreated(
  pool: PgPool,
  logger: Pick<Console, "warn">
): Promise<LegacyContentCounts | null> {
  const record = await createLegacyWipeRepository(pool).readRecord();
  const lastWipe = record?.runs.at(-1);
  if (!lastWipe) return null;
  const counts = await createLegacyStateRepository(pool).legacyContentCounts();
  if (!hasLegacyContent(counts)) return null;
  logger.warn(`LEGACY_RECREATED ${JSON.stringify({ counts, lastWipeAt: lastWipe.at })}`);
  return counts;
}

export interface LegacyWipeStartupOptions extends LegacyWipeBackupOptions {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  pool: PgPool;
  workspaceRoot: string;
  logger: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

/**
 * Runs at startup after the knowledge defaults and before the local models, job supervisor,
 * gateway and vault reconcile start. `quit` means the app must quit now: a preview, a wipe or a
 * refusal of the one-shot knob. `continue` means a normal start: no knob, or nothing to wipe.
 */
export async function runLegacyWipeStartup(
  options: LegacyWipeStartupOptions
): Promise<"continue" | "quit"> {
  await detectLegacyRecreated(options.pool, options.logger).catch((error: unknown) =>
    options.logger.warn(`LEGACY_RECREATED check failed: ${describeLegacyWipeError(error)}`)
  );
  let request: LegacyWipeRequest | null;
  try {
    request = readLegacyWipeKnob(options.env, { isPackaged: options.isPackaged });
  } catch (error) {
    options.logger.error(`LEGACY_WIPE refused: ${describeLegacyWipeError(error)}`);
    return "quit";
  }
  if (!request) return "continue";
  const service = new LegacyWipeService({
    pool: options.pool,
    backup: createLegacyWipeBackup(options),
    backupRoot: join(options.workspaceRoot, ...legacyWipeConfig.backupDirectory),
    logger: options.logger,
    ...(options.now ? { now: options.now } : {})
  });
  try {
    const report = await service.run(request);
    if (request.mode === "preview") {
      options.logger.info(`LEGACY_WIPE_PREVIEW ${JSON.stringify(previewFields(report))}`);
      return "quit";
    }
    if (report.outcome === "nothing") {
      options.logger.info("LEGACY_WIPE nothing to wipe; starting normally");
      return "continue";
    }
    options.logger.info(`LEGACY_WIPE ${JSON.stringify(report)}`);
    return "quit";
  } catch (error) {
    options.logger.error(`LEGACY_WIPE refused: ${describeLegacyWipeError(error)}`);
    return "quit";
  }
}

/** The preview line: what the wipe would remove, the sizes, the backup and the token. */
export function previewFields(report: LegacyWipeReport) {
  return {
    counts: report.counts,
    keyCounts: report.keyCounts,
    library: report.library,
    blockers: report.blockers,
    databaseBytes: report.databaseBytes,
    freeBytes: report.freeBytes,
    backupPath: report.backupPath,
    token: report.token,
    timings: report.timings
  };
}

/** A one-line reason for a refusal or failure; verification details are already redacted. */
export function describeLegacyWipeError(error: unknown): string {
  if (error instanceof LegacyWipeRefusal) return error.message;
  if (error instanceof BackupVerificationError)
    return `backup verification failed (${error.failure}): ${error.detail}${
      error.backupPath ? `; kept ${error.backupPath}` : ""
    }`;
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .slice(0, 400);
}
