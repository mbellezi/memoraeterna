// The database lints of AUDIT (F4 D19, spec 3.7), run by `topic-audit` after its engine turn: they
// read the notes and the persisted addresses, never the tree's cache, so they hold no tree lock.
// Duplicate notes (the nearest neighbours of the notes embedded since the last audit, and equal
// titles), broken `memora://` addresses, and vectors that are missing or older than their note.
// The findings go to `gardener_findings`; a stale vector is queued as one `note-embedding` job.
// Each lint fails alone and is incremental: a cursor in the settings marks where the scan of the
// notes stopped, a time budget bounds one audit and the audit asks for another while a scan has
// more to read. Nothing here writes the topic tree (the engine is its single writer).
import {
  createAuditLintRepository,
  createGardenerFindingRepository,
  createJobRepository,
  createSettingsRepository,
  gardenerFindingBatchMax
} from "@app/db";
import type {
  AuditEmbeddingSpace,
  JsonObject,
  PgPool,
  RecordFindingsResult,
  ScanCursor
} from "@app/db";
import {
  addressTargets,
  brokenLinkFindings,
  defaultAuditLintConfig,
  duplicateFindings,
  pairHolds,
  parseObjectAddress,
  staleEmbeddings
} from "@app/domain";
import type { AuditLintConfig, EmbeddingFact, LintFinding } from "@app/domain";
import { z } from "zod";

import { atomicNoteEmbeddingHash } from "../note-embedding-text.js";

/** Where the scans' cursors are kept: one row for all trees (a tree has one while it is active). */
export const auditCursorsSettingKey = "gardener.audit.cursors.v1";

const CursorSchema = z.object({ at: z.string().min(1).max(40), id: z.string().uuid() }).strict();
const TreeCursorsSchema = z
  .object({
    /** The scans are of this space; another space starts them over. */
    spaceKey: z.string().min(1).max(400),
    duplicates: CursorSchema.nullable().default(null),
    edited: CursorSchema.nullable().default(null)
  })
  .strict();
const CursorsSchema = z
  .object({ trees: z.record(z.string(), TreeCursorsSchema).default({}) })
  .strict();
type TreeCursors = z.infer<typeof TreeCursorsSchema>;

/** Trees whose cursors are kept (the active one and a few retired ones). */
const cursorTreesKept = 4;

/** The tree an audit lints: its space picks the embedding table and the vectors read. */
export interface AuditLintTree {
  id: string;
  spaceKey: string;
  dimensions: 256 | 768 | 1024;
  embeddingModel: string;
}

export interface AuditLintsOptions {
  getPool: () => PgPool | null;
  config?: AuditLintConfig;
  logger?: Pick<Console, "warn">;
}

export interface AuditLintsInput {
  /** The tree's space is not the route's (D26): the space change re-embeds, not this lint. */
  spaceChanged: boolean;
  /** Re-embedding is model work: off in a deterministic (golden) run. */
  allowEmbedding: boolean;
}

export type LintSummary = JsonObject & { state: "done" | "off" | "failed" };

export interface AuditLintsReport {
  duplicates: LintSummary;
  brokenLinks: LintSummary;
  staleEmbeddings: LintSummary;
  /** A scan stopped before its end: another audit should follow. */
  more: boolean;
}

const round = (value: number): number => Math.round(value * 10) / 10;

function spaceOf(tree: AuditLintTree): AuditEmbeddingSpace {
  return { dimensions: tree.dimensions, spaceKey: tree.spaceKey, model: tree.embeddingModel };
}

export class AuditLints {
  private readonly config: AuditLintConfig;

  public constructor(private readonly options: AuditLintsOptions) {
    this.config = options.config ?? defaultAuditLintConfig;
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }

  /** Records findings in batches the table's repository accepts. */
  private async record(findings: readonly LintFinding[]): Promise<RecordFindingsResult> {
    const repository = createGardenerFindingRepository(this.requirePool());
    const total: RecordFindingsResult = {
      created: 0,
      reopened: 0,
      updated: 0,
      unchanged: 0,
      dismissed: 0
    };
    for (let at = 0; at < findings.length; at += gardenerFindingBatchMax) {
      const result = await repository.record(findings.slice(at, at + gardenerFindingBatchMax));
      for (const key of Object.keys(total) as (keyof RecordFindingsResult)[]) {
        total[key] += result[key];
      }
    }
    return total;
  }

  /**
   * The findings of redirects the engine could not fix (a cycle or a missing target), recorded by
   * the audit after its engine turn; the ones no longer found are resolved.
   */
  public async recordRedirectFindings(findings: readonly LintFinding[]): Promise<JsonObject> {
    const recorded = await this.record(findings);
    const resolved = await createGardenerFindingRepository(this.requirePool()).resolveMissing(
      "redirect_chain",
      findings.map((finding) => finding.fingerprint)
    );
    return { unresolved: findings.length, ...recorded, resolved };
  }

  public async run(tree: AuditLintTree, input: AuditLintsInput): Promise<AuditLintsReport> {
    const cursors = await this.readCursors(tree);
    let more = false;
    const guarded = async (
      name: string,
      work: () => Promise<{ summary: JsonObject; more?: boolean }>
    ): Promise<LintSummary> => {
      const begin = performance.now();
      try {
        const { summary, more: remaining } = await work();
        if (remaining) more = true;
        return {
          state: "done",
          ...summary,
          ms: round(performance.now() - begin)
        } as LintSummary;
      } catch (error) {
        this.options.logger?.warn(`The ${name} lint of the audit failed`, error);
        return {
          state: "failed",
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown"
        };
      }
    };
    const duplicates = await guarded("duplicate notes", () => this.duplicates(tree, cursors));
    const brokenLinks = await guarded("broken links", () => this.brokenLinks());
    const stale: LintSummary = !input.allowEmbedding
      ? { state: "off", reason: "deterministic" }
      : input.spaceChanged
        ? { state: "off", reason: "space_changed" }
        : await guarded("stale embeddings", () => this.staleEmbeddings(tree, cursors));
    try {
      await this.writeCursors(tree, cursors);
    } catch (error) {
      this.options.logger?.warn("The audit's scan cursors could not be saved", error);
    }
    return { duplicates, brokenLinks, staleEmbeddings: stale, more };
  }

  // -------------------------------------------------------------------------
  // Duplicate notes

  private async duplicates(
    tree: AuditLintTree,
    cursors: TreeCursors
  ): Promise<{ summary: JsonObject; more: boolean }> {
    const config = this.config.duplicates;
    const pool = this.requirePool();
    const lints = createAuditLintRepository(pool);
    const space = spaceOf(tree);
    const begin = performance.now();
    const found = new Map<string, LintFinding>();
    let cursor: ScanCursor | null = cursors.duplicates;
    let examined = 0;
    let generic = 0;
    let exhausted = false;
    while (examined < config.perRun) {
      const limit = Math.min(config.batch, config.perRun - examined);
      const batch = await lints.duplicateBatch(space, cursor, limit, config.neighbours);
      if (batch.notes.length === 0) {
        exhausted = true;
        break;
      }
      const groups = await lints.titleGroups(batch.notes.map((note) => note.id));
      const result = duplicateFindings(
        { neighbours: batch.neighbours, titleGroups: groups },
        { duplicates: config }
      );
      generic += result.genericTitleGroups;
      for (const finding of result.findings) found.set(finding.fingerprint, finding);
      const last = batch.notes[batch.notes.length - 1] as { at: string; id: string };
      cursor = { at: last.at, id: last.id };
      examined += batch.notes.length;
      if (batch.notes.length < limit) {
        exhausted = true;
        break;
      }
      if (found.size >= config.findingsPerRun) break;
      if (performance.now() - begin >= config.budgetMs) break;
    }
    const recorded = await this.record([...found.values()]);
    // The scan resumes after these notes only once their findings are recorded.
    cursors.duplicates = cursor;
    const revalidated = await this.revalidateDuplicates(space);
    return {
      summary: {
        examined,
        pairs: found.size,
        ...recorded,
        genericTitleGroups: generic,
        exhausted,
        revalidated: revalidated.checked,
        resolved: revalidated.resolved
      },
      more: !exhausted
    };
  }

  /** Checks the open duplicate findings that waited longest: still current notes and still alike. */
  private async revalidateDuplicates(
    space: AuditEmbeddingSpace
  ): Promise<{ checked: number; resolved: number }> {
    const pool = this.requirePool();
    const findings = createGardenerFindingRepository(pool);
    const due = await findings.dueForCheck("duplicate", this.config.duplicates.revalidate);
    if (due.length === 0) return { checked: 0, resolved: 0 };
    const pairs: { id: string; fingerprint: string; notes: [string, string] }[] = [];
    const unreadable: string[] = [];
    for (const finding of due) {
      const ids = finding.objectRefs
        .map((address) => parseObjectAddress(address))
        .filter((parsed) => parsed?.kind === "note")
        .map((parsed) => (parsed as { id: string }).id);
      if (ids.length === 2)
        pairs.push({
          id: finding.id,
          fingerprint: finding.fingerprint,
          notes: [ids[0] as string, ids[1] as string]
        });
      else unreadable.push(finding.fingerprint);
    }
    const evidence = await createAuditLintRepository(pool).pairEvidence(
      space,
      pairs.map((pair) => pair.notes)
    );
    const gone: string[] = [...unreadable];
    const holding: string[] = [];
    pairs.forEach((pair, index) => {
      const row = evidence[index];
      if (row && row.bothCurrent && pairHolds(row, this.config)) holding.push(pair.id);
      else gone.push(pair.fingerprint);
    });
    const resolved = await findings.resolve("duplicate", gone);
    await findings.touch(holding);
    return { checked: due.length, resolved };
  }

  // -------------------------------------------------------------------------
  // Broken links

  private async brokenLinks(): Promise<{ summary: JsonObject }> {
    const pool = this.requirePool();
    const lints = createAuditLintRepository(pool);
    const config = this.config.links;
    const targets = addressTargets(await lints.persistedAddresses(config.addressesPerRun));
    const resolutions = await lints.addressResolutions(targets, config.maxHops);
    const findings = brokenLinkFindings(targets, resolutions);
    const recorded = await this.record(findings);
    const resolved = await createGardenerFindingRepository(pool).resolveMissing(
      "broken_link",
      findings.map((finding) => finding.fingerprint)
    );
    return { summary: { checked: targets.length, broken: findings.length, ...recorded, resolved } };
  }

  // -------------------------------------------------------------------------
  // Stale embeddings

  private async staleEmbeddings(
    tree: AuditLintTree,
    cursors: TreeCursors
  ): Promise<{ summary: JsonObject; more: boolean }> {
    const config = this.config.staleEmbeddings;
    if (config.perRun === 0) return { summary: { queued: 0 }, more: false };
    const lints = createAuditLintRepository(this.requirePool());
    const space = spaceOf(tree);
    const missing = await lints.notesWithoutVector(space, config.perRun, config.retryHours);
    const scan = Math.max(config.perRun, 50);
    const edited = await lints.notesEditedAfterVector(
      space,
      cursors.edited,
      scan,
      config.retryHours
    );
    const sources = new Map<string, string>();
    const facts: EmbeddingFact[] = [];
    for (const note of missing) {
      sources.set(note.id, note.sourceItemId);
      facts.push({ noteId: note.id, expectedHash: "", storedHash: null });
    }
    for (const note of edited) {
      sources.set(note.id, note.sourceItemId);
      facts.push({
        noteId: note.id,
        expectedHash: atomicNoteEmbeddingHash(note),
        storedHash: note.storedHash
      });
    }
    const result = staleEmbeddings(facts, { staleEmbeddings: config });
    const queued = await createJobRepository(this.requirePool()).enqueueNoteEmbeddings(
      result.stale.map((entry) => ({
        atomicNoteId: entry.noteId,
        sourceItemId: sources.get(entry.noteId) as string
      })),
      { spaceKey: tree.spaceKey }
    );
    // The scan resumes after these notes only once their re-embeddings are queued.
    const last = edited.at(-1);
    if (last) cursors.edited = { at: last.at, id: last.id };
    return {
      summary: {
        examined: edited.length,
        missing: result.missing,
        content: result.content,
        queued,
        deferred: result.deferred
      },
      more: edited.length >= scan || missing.length >= config.perRun
    };
  }

  // -------------------------------------------------------------------------
  // The scans' cursors

  private async readCursors(tree: AuditLintTree): Promise<TreeCursors> {
    const stored = await createSettingsRepository(this.requirePool()).get(auditCursorsSettingKey);
    const parsed = CursorsSchema.safeParse(stored ?? {});
    const own = parsed.success ? parsed.data.trees[tree.id] : undefined;
    if (!own || own.spaceKey !== tree.spaceKey) {
      return { spaceKey: tree.spaceKey, duplicates: null, edited: null };
    }
    return own;
  }

  private async writeCursors(tree: AuditLintTree, cursors: TreeCursors): Promise<void> {
    const settings = createSettingsRepository(this.requirePool());
    const stored = await settings.get(auditCursorsSettingKey);
    const parsed = CursorsSchema.safeParse(stored ?? {});
    const trees = parsed.success ? parsed.data.trees : {};
    const next = { ...trees, [tree.id]: cursors };
    // Keep the tree just linted and the most recent others (insertion order of the object).
    const ids = Object.keys(next).filter((id) => id !== tree.id);
    const kept = Object.fromEntries(
      [...ids.slice(-(cursorTreesKept - 1)), tree.id].map((id) => [id, next[id]])
    );
    if (JSON.stringify(kept) === JSON.stringify(trees)) return;
    await settings.set(auditCursorsSettingKey, { trees: kept });
  }
}
