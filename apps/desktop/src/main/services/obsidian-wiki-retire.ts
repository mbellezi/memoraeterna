import { z } from "zod";

import {
  createObsidianSyncRepository,
  createObsidianWikiRepository,
  type ObsidianSyncFileRecord,
  type PgPool
} from "@app/db";

import {
  readRegularFile,
  safeVaultPath,
  type ObsidianArchiveInput,
  type ObsidianArchiveResult
} from "../workers/obsidian-sync.worker.js";

/**
 * Retires vault files the projection no longer produces: the old wiki's pages and indexes (every
 * page file, now that topics replace pages) and the maps of topics that left the tree (merged or
 * removed). A registered file of those kinds that the current plan does not produce is taken out
 * of the projection without ever deleting what a person may have written:
 *
 * - bytes equal to the last projected file: archived to
 *   `<managedRoot>/.memora-recovery/retired-wiki/<stamp>/`, then the row is `retired`;
 * - anything else (edited, no proof it is unedited, unsafe path): the file stays in place, the row is
 *   `retired` and the file is reported so the person can move it to recovery;
 * - no file at the path: the row is `retired`.
 *
 * A retired row keeps its relative path, so the registry still reserves the path (a new target is
 * placed beside it, never over it). The map of a live topic is never retired, even when the
 * projection scope leaves it out. Nothing here deletes a vault file.
 */
export const retiredOutcomes = ["archived", "kept", "absent"] as const;
export const keptReasons = ["edited", "unverified", "unsafe", "limit"] as const;
export type RetiredOutcome = (typeof retiredOutcomes)[number];
export type KeptReason = (typeof keptReasons)[number];

const retiredMetadataSchema = z.object({
  at: z.string(),
  outcome: z.enum(retiredOutcomes),
  reason: z.enum(keptReasons).optional(),
  archivedPath: z.string().optional(),
  previousStatus: z.string().optional(),
  movedAt: z.string().optional()
});
export type RetiredMetadata = z.infer<typeof retiredMetadataSchema>;

export interface RetiredReport {
  archived: number;
  absent: number;
  keptTotal: number;
  kept: Array<{ id: string; relativePath: string; reason: KeptReason }>;
}
export interface RetireSummary {
  archived: number;
  kept: number;
  absent: number;
  /** Files that could not be handled this time (I/O, database); their rows are unchanged and retried. */
  failed: number;
}
/** At most this many kept files are listed in the report; the total is always exact. */
const reportedKeptLimit = 200;

/** The database operations the retirement needs, so the logic runs without PostgreSQL in tests. */
export interface RetirementStore {
  /** Registered wiki page, wiki index and topic map files: the live ones, or the retired ones. */
  retirableFiles(retired: boolean): Promise<ObsidianSyncFileRecord[]>;
  find(memoraId: string): Promise<ObsidianSyncFileRecord | null>;
  retire(file: ObsidianSyncFileRecord, metadata: RetiredMetadata): Promise<void>;
  /** `rendered_hash` of the last file written for this target in this vault, if any. */
  writtenHash(memoraId: string, binding: string): Promise<string | null>;
  /** Which of these topics are live in the active tree. */
  liveTopicIds(ids: string[]): Promise<string[]>;
  /** Serializes work on one target with projection writes and editorial operations. */
  withTarget<T>(memoraId: string, work: () => Promise<T>): Promise<T>;
}

export function createPgRetirementStore(pool: PgPool): RetirementStore {
  const sync = createObsidianSyncRepository(pool),
    wiki = createObsidianWikiRepository(pool);
  return {
    retirableFiles: (retired) => sync.listRetirableFiles(retired),
    find: (memoraId) => sync.findByMemoraId(memoraId),
    retire: async (file, metadata) => {
      await sync.update(file.id, {
        status: "retired",
        metadata: { ...file.metadata, retired: { ...metadata } }
      });
    },
    writtenHash: async (memoraId, binding) =>
      (await wiki.base(memoraId, binding))?.rendered_hash ?? null,
    liveTopicIds: (ids) => wiki.liveTopicIds(ids),
    withTarget: (memoraId, work) => wiki.withTargetLock(memoraId, work)
  };
}

export interface RetirementOptions {
  store: RetirementStore;
  /** Moves one file into recovery (the Obsidian sync worker). */
  archive: (input: ObsidianArchiveInput) => Promise<ObsidianArchiveResult>;
  /** The projection hash of a file's text (line endings do not count). */
  hash: (text: string) => string;
  now?: () => Date;
}
export interface RetireContext {
  vaultPath: string;
  managedRoot: string;
  /** The vault binding that deliveries and the last written hash are recorded under. */
  binding: string;
  /** Checked before every file: a paused sync or a changed vault stops the pass. */
  assertBinding: () => Promise<void>;
  signal?: AbortSignal | undefined;
}

/** Errors that stop the whole pass instead of failing one file. */
const stops = (error: unknown) => /obsidianWiki\.errors\.(paused|binding)/.test(String(error));

export function retiredMetadata(file: ObsidianSyncFileRecord): RetiredMetadata | null {
  const parsed = retiredMetadataSchema.safeParse(file.metadata.retired);
  return parsed.success ? parsed.data : null;
}

export class ObsidianWikiRetirement {
  constructor(private readonly options: RetirementOptions) {}

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /**
   * Retires every registered retirable file the plan does not produce, except the map of a topic
   * that is still live (out of the projection scope, not gone). Safe to run again: retired rows are
   * skipped.
   */
  async retire(context: RetireContext, produced: ReadonlySet<string>): Promise<RetireSummary> {
    const summary: RetireSummary = { archived: 0, kept: 0, absent: 0, failed: 0 };
    const store = this.options.store;
    const pending = (await store.retirableFiles(false)).filter(
      (file) => file.status !== "retired" && !produced.has(file.memoraId)
    );
    if (!pending.length) return summary;
    const alive = new Set<string>();
    const topicIds = pending.filter((f) => f.memoraType === "topic").map((f) => f.memoraId);
    for (let i = 0; i < topicIds.length; i += 500)
      for (const id of await store.liveTopicIds(topicIds.slice(i, i + 500))) alive.add(id);
    const stamp = this.now().replace(/[^0-9A-Za-z]/g, "-");
    for (const candidate of pending) {
      if (alive.has(candidate.memoraId)) continue;
      if (context.signal?.aborted) throw new Error("obsidianWiki.errors.paused");
      try {
        await context.assertBinding();
        const outcome = await store.withTarget(candidate.memoraId, () =>
          this.retireOne(context, candidate.memoraId, stamp)
        );
        if (outcome) summary[outcome] += 1;
      } catch (error) {
        if (stops(error)) throw error;
        summary.failed += 1;
      }
    }
    return summary;
  }

  private async retireOne(
    context: RetireContext,
    memoraId: string,
    stamp: string
  ): Promise<RetiredOutcome | null> {
    const store = this.options.store;
    // Read again under the target lock: another pass or an editorial write may have changed the row.
    const file = await store.find(memoraId);
    if (!file || file.status === "retired") return null;
    const metadata = (outcome: RetiredOutcome, extra: Partial<RetiredMetadata> = {}) => ({
      at: this.now(),
      outcome,
      previousStatus: file.status,
      ...extra
    });
    const keep = async (reason: KeptReason) => {
      await store.retire(file, metadata("kept", { reason }));
      return "kept" as const;
    };
    if (!file.relativePath.startsWith(`${context.managedRoot}/`)) return keep("unsafe");
    let bytes: Buffer | null;
    try {
      bytes = await readRegularFile(await safeVaultPath(context.vaultPath, file.relativePath));
    } catch (error) {
      if (String(error).includes("obsidianWiki.errors.limit")) return keep("limit");
      if (String(error).includes("unsafe_obsidian")) return keep("unsafe");
      throw error;
    }
    if (bytes === null) {
      await store.retire(file, metadata("absent"));
      return "absent";
    }
    const written = await store.writtenHash(memoraId, context.binding);
    if (written === null) return keep("unverified");
    if (this.options.hash(bytes.toString("utf8")) !== written) return keep("edited");
    let result: ObsidianArchiveResult;
    try {
      result = await this.options.archive({
        vaultPath: context.vaultPath,
        relativePath: file.relativePath,
        managedRoot: context.managedRoot,
        stamp,
        expectedHash: written
      });
    } catch (error) {
      // Edited between the check and the move: the worker put it back, so it is a kept file.
      if (String(error).includes("obsidianWiki.errors.conflict")) return keep("edited");
      if (String(error).includes("unsafe_obsidian")) return keep("unsafe");
      throw error;
    }
    if (result.outcome === "absent") {
      await store.retire(file, metadata("absent"));
      return "absent";
    }
    await store.retire(file, metadata("archived", { archivedPath: result.archivedPath }));
    return "archived";
  }

  /**
   * The explicit "Move to recovery" of a kept file: whatever bytes the file holds now are copied to
   * recovery and the original is moved out, with the same late-edit check as the automatic pass.
   */
  async moveToRecovery(context: RetireContext, memoraId: string): Promise<RetiredOutcome> {
    const store = this.options.store;
    await context.assertBinding();
    return store.withTarget(memoraId, async () => {
      const file = await store.find(memoraId);
      const previous = file ? retiredMetadata(file) : null;
      if (!file || file.status !== "retired" || previous?.outcome !== "kept")
        throw new Error("obsidianWiki.errors.binding");
      if (!file.relativePath.startsWith(`${context.managedRoot}/`))
        throw new Error("obsidianWiki.errors.binding");
      const result = await this.options.archive({
        vaultPath: context.vaultPath,
        relativePath: file.relativePath,
        managedRoot: context.managedRoot,
        stamp: this.now().replace(/[^0-9A-Za-z]/g, "-")
      });
      // The move replaces how the file was kept: only when it was first retired and when it was moved stay.
      const base = {
        at: previous.at,
        movedAt: this.now(),
        ...(previous.previousStatus ? { previousStatus: previous.previousStatus } : {})
      };
      if (result.outcome === "absent") {
        await store.retire(file, { ...base, outcome: "absent" });
        return "absent";
      }
      await store.retire(file, { ...base, outcome: "archived", archivedPath: result.archivedPath });
      return "archived";
    });
  }

  async report(): Promise<RetiredReport> {
    const report: RetiredReport = { archived: 0, absent: 0, keptTotal: 0, kept: [] };
    for (const file of await this.options.store.retirableFiles(true)) {
      const metadata = retiredMetadata(file);
      if (!metadata) continue;
      if (metadata.outcome === "archived") report.archived += 1;
      else if (metadata.outcome === "absent") report.absent += 1;
      else {
        report.keptTotal += 1;
        if (report.kept.length < reportedKeptLimit)
          report.kept.push({
            id: file.memoraId,
            relativePath: file.relativePath,
            reason: metadata.reason ?? "edited"
          });
      }
    }
    return report;
  }
}
