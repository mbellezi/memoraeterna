import {
  ChangeSetCursorError,
  createAtomicNoteRepository,
  createChangeSetRepository,
  createJobRepository,
  createRelationEventRepository,
  createTopicOverviewRepository,
  immediateJobDebounce,
  type PgPool,
  type Queryable,
  type RelationRevertBlocker,
  type RelationRevertOptions
} from "@app/db";
import {
  ChangesDiffInputSchema,
  ChangesDiffSchema,
  ChangesListInputSchema,
  ChangesListSchema,
  ChangesPendingCountsSchema,
  ChangesReviewInputSchema,
  ChangesReviewResultSchema,
  ChangesUndoInputSchema,
  ChangesUndoResultSchema,
  changeSetReadLimits,
  type ChangeSetBlocker,
  type ChangeSetBlockerCode,
  type ChangeSetRef,
  type ChangeSetStatus,
  type ChangeSetSummary,
  type ChangesDiff,
  type ChangesList,
  type ChangesPendingCounts,
  type ChangesReviewResult,
  type ChangesUndoResult,
  type TopicReviewInput,
  type TopicReviewResult,
  type TopicUndoBlocker,
  type TopicUndoInput,
  type TopicUndoResult
} from "@app/domain";

import {
  linkRootOf,
  relationPromoteDedupeKey,
  relationPromoteJobType
} from "../relations/relation-link.js";

/** The topic engine's own undo and review: the single writer settles statistics and pushes. */
export interface TopicChangeHandlers {
  undo(input: TopicUndoInput): Promise<TopicUndoResult>;
  review(input: TopicReviewInput): Promise<TopicReviewResult>;
}

export interface ChangesServiceOptions {
  getPool: () => PgPool | null;
  /** The topic service; null while the engine is not running. */
  topics?: () => TopicChangeHandlers | null;
  /** After a relation pass was reverted: the notes whose relations changed (pages read again). */
  relationsChanged?: (noteIds: string[]) => void;
  /** After an overview was restored or a proposal applied: its topic. */
  overviewChanged?: (topicId: string) => void;
  /**
   * A proposal the owner applied was made on a version written again since: REFRESH proposes it
   * again on the version of now (F4 D17).
   */
  overviewMoved?: (topicId: string) => void;
  /** After any change-set changed status (Activity and Inbox read again). */
  changed?: (ref: ChangeSetRef) => void;
}

const errors = {
  notFound: "changes.errors.notFound",
  invalidCursor: "changes.errors.invalidCursor",
  unavailable: "changes.errors.unavailable"
} as const;

/**
 * Blockers as the interface words them: unique, the first `blockersMax`; `more` counts the unique
 * ones left out plus those the store counted without naming them (`total` past `blockers`).
 */
function blockedResult(blockers: readonly ChangeSetBlocker[], total = blockers.length) {
  const unique = new Map<string, ChangeSetBlocker>();
  for (const blocker of blockers)
    unique.set(
      `${blocker.code}:${blocker.changeSet?.kind ?? ""}:${blocker.changeSet?.id ?? ""}`,
      blocker
    );
  const listed = [...unique.values()].slice(0, changeSetReadLimits.blockersMax);
  if (listed.length === 0) listed.push({ code: "conflict", changeSet: null });
  return {
    status: "blocked" as const,
    blockers: listed,
    more: Math.max(0, unique.size - listed.length) + Math.max(0, total - blockers.length)
  };
}

const blocker = (code: ChangeSetBlockerCode, changeSet: ChangeSetRef | null = null) => ({
  code,
  changeSet
});

/** The topic engine's undo blockers, as change-set blockers. */
export function topicBlockers(blockers: readonly TopicUndoBlocker[]): ChangeSetBlocker[] {
  return blockers.map((entry) => {
    switch (entry.kind) {
      case "changeSet":
        return blocker("later_change", { kind: "topic", id: entry.changeSetId });
      case "itemDeleted":
        return blocker("item_deleted");
      case "notApplied":
        return blocker("not_applied");
      case "conflict":
        return blocker(entry.code === "notUndoable" ? "not_undoable" : "conflict");
    }
  });
}

/** A relation revert's blockers; a later human verdict is not a change-set, so it names none. */
export function relationBlockers(blockers: readonly RelationRevertBlocker[]): ChangeSetBlocker[] {
  return blockers.map((entry) => {
    switch (entry.code) {
      case "run_open":
        return blocker("run_open");
      case "later_run":
        return entry.runKind === "review" || entry.runKind === "veto"
          ? blocker("changed_since")
          : blocker("later_change", { kind: "relation", id: entry.runId });
      case "row_missing":
        return blocker("item_deleted");
      case "changed_since":
      case "row_exists":
      case "restore_refused":
        return blocker("changed_since");
    }
  });
}

/** Why the view already says an undo cannot run. */
const unavailableCode = (summary: ChangeSetSummary): ChangeSetBlockerCode =>
  summary.status === "applied" ? "not_undoable" : "not_applied";

/**
 * The notes at the ends of the note relations a revert changed: their roots are promoted again in
 * the revert's own transaction (I-R10), so no promoted source relation keeps evidence the revert
 * took away. A pass that changed only source relations re-promotes nothing (that would rebuild
 * what was undone).
 */
async function repromote(client: Queryable, runId: string, pool: PgPool): Promise<string[]> {
  const noteIds = await createRelationEventRepository(pool).runNoteIds(runId, client);
  const notes = createAtomicNoteRepository(client);
  const homes = new Set<string>();
  for (const noteId of noteIds) {
    const home = (await notes.findById(noteId))?.createdFromSourceItemId;
    if (home) homes.add(home);
  }
  const roots = new Set<string>();
  for (const homeId of homes) roots.add(await linkRootOf(client, homeId));
  const jobs = createJobRepository(client);
  for (const rootId of [...roots].sort())
    await jobs.enqueueDeduped({
      type: relationPromoteJobType,
      lane: "light",
      dedupeKey: relationPromoteDedupeKey(rootId),
      payload: { rootId },
      debounce: immediateJobDebounce
    });
  return noteIds;
}

/**
 * `changes.*` (F4 D10, spec 3.4): one read model over the three change-set stores and one undo
 * and review that each store carries out with its own exact writer: the topic engine for topic
 * change-sets, the relation event log for relation passes, the overview repository for overview
 * writes. Nothing here calls AI. Every request is validated here, every answer before it leaves.
 */
export class ChangesService {
  constructor(private readonly options: ChangesServiceOptions) {}

  private pool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error(errors.unavailable);
    return pool;
  }

  private async summary(pool: PgPool, ref: ChangeSetRef): Promise<ChangeSetSummary> {
    const summary = await createChangeSetRepository(pool).get(ref.kind, ref.id);
    if (!summary) throw new Error(errors.notFound);
    return summary;
  }

  private topics(): TopicChangeHandlers {
    const topics = this.options.topics?.() ?? null;
    if (!topics) throw new Error(errors.unavailable);
    return topics;
  }

  /** Newest first, filtered by kind, status or risk. */
  async list(input: unknown): Promise<ChangesList> {
    const parsed = ChangesListInputSchema.parse(input ?? {});
    try {
      return ChangesListSchema.parse(
        await createChangeSetRepository(this.pool()).list({
          ...(parsed.kind ? { kind: parsed.kind } : {}),
          ...(parsed.status ? { status: parsed.status } : {}),
          ...(parsed.risk ? { risk: parsed.risk } : {}),
          cursor: parsed.cursor ?? null,
          limit: parsed.limit
        })
      );
    } catch (error) {
      if (error instanceof ChangeSetCursorError)
        throw new Error(errors.invalidCursor, { cause: error });
      throw error;
    }
  }

  /** Change-sets that wait for the owner, per store and risk. */
  async pendingCounts(): Promise<ChangesPendingCounts> {
    return ChangesPendingCountsSchema.parse(
      await createChangeSetRepository(this.pool()).pendingCounts()
    );
  }

  /** A bounded before and after of one change-set; null when it is not a change-set. */
  async diff(input: unknown): Promise<ChangesDiff | null> {
    const ref = ChangesDiffInputSchema.parse(input);
    const diff = await createChangeSetRepository(this.pool()).diff(ref.kind, ref.id);
    return diff ? ChangesDiffSchema.parse(diff) : null;
  }

  /** Undoes a change-set exactly in its own store, or names what blocks it. */
  async undo(input: unknown): Promise<ChangesUndoResult> {
    const ref = ChangesUndoInputSchema.parse(input);
    const pool = this.pool();
    const summary = await this.summary(pool, ref);
    if (summary.undo === "unavailable")
      return ChangesUndoResultSchema.parse(blockedResult([blocker(unavailableCode(summary))]));
    const result = await this.undoIn(pool, summary);
    if (result.status === "undone") this.options.changed?.(ref);
    return ChangesUndoResultSchema.parse(result);
  }

  private async undoIn(pool: PgPool, summary: ChangeSetSummary): Promise<ChangesUndoResult> {
    const undone = { status: "undone" as const, kind: summary.kind, id: summary.id };
    if (summary.kind === "topic") {
      let result: TopicUndoResult;
      try {
        result = await this.topics().undo({ changeSetId: summary.id });
      } catch (error) {
        // A change-set of a tree that is no longer the active one.
        if (error instanceof Error && error.message === "topics.errors.notFound")
          throw new Error(errors.notFound, { cause: error });
        throw error;
      }
      return result.status === "undone" ? undone : blockedResult(topicBlockers(result.blockers));
    }
    if (summary.kind === "relation") {
      let noteIds: string[] = [];
      const options: RelationRevertOptions = {
        onReverted: async (client) => {
          noteIds = await repromote(client, summary.id, pool);
        }
      };
      const result = await createRelationEventRepository(pool).revertRun(summary.id, options);
      switch (result.kind) {
        case "reverted":
          if (noteIds.length > 0) this.options.relationsChanged?.(noteIds);
          return undone;
        case "blocked":
          return blockedResult(relationBlockers(result.blockers), result.blockerCount);
        case "already_reverted":
          return blockedResult([blocker("not_applied")]);
        case "not_found":
          throw new Error(errors.notFound);
      }
    }
    const result = await createTopicOverviewRepository(pool).undoVersion(summary.id);
    switch (result.kind) {
      case "undone":
        if (summary.subjectId) this.options.overviewChanged?.(summary.subjectId);
        return undone;
      case "blocked":
        return blockedResult([blocker(result.code)]);
      case "not_found":
        throw new Error(errors.notFound);
    }
  }

  /**
   * The owner's verdict on a change-set that waits for review: `apply` keeps it (applies a
   * proposal), `dismiss` drops it (reverts a relation pass). A change-set that does not wait
   * answers the status that stands.
   */
  async review(input: unknown): Promise<ChangesReviewResult> {
    const parsed = ChangesReviewInputSchema.parse(input);
    const ref = { kind: parsed.kind, id: parsed.id };
    const pool = this.pool();
    const summary = await this.summary(pool, ref);
    if (summary.status !== "pending_review")
      return ChangesReviewResultSchema.parse({ status: summary.status });
    const result = await this.reviewIn(pool, summary, parsed.verdict);
    if (result.status !== "blocked" && result.status !== "stale") this.options.changed?.(ref);
    return ChangesReviewResultSchema.parse(result);
  }

  private async reviewIn(
    pool: PgPool,
    summary: ChangeSetSummary,
    verdict: "apply" | "dismiss"
  ): Promise<ChangesReviewResult> {
    if (summary.kind === "topic") {
      const result = await this.topics().review({ changeSetId: summary.id, decision: verdict });
      return { status: result.status };
    }
    if (summary.kind === "relation") {
      let noteIds: string[] = [];
      const result = await createRelationEventRepository(pool).reviewRun(
        summary.id,
        verdict === "apply" ? "keep" : "dismiss",
        {
          onReverted: async (client) => {
            noteIds = await repromote(client, summary.id, pool);
          }
        }
      );
      switch (result.kind) {
        case "kept":
          return { status: "applied" };
        case "dismissed":
          if (noteIds.length > 0) this.options.relationsChanged?.(noteIds);
          return { status: "dismissed" };
        case "not_pending":
          return { status: verdictStatus(result.reviewStatus, summary.status) };
        case "blocked":
          return blockedResult(relationBlockers(result.blockers), result.blockerCount);
        case "not_found":
          throw new Error(errors.notFound);
      }
    }
    const result = await createTopicOverviewRepository(pool).resolveProposal(summary.id, verdict);
    switch (result.kind) {
      case "applied":
        if (summary.subjectId) this.options.overviewChanged?.(summary.subjectId);
        return { status: "applied" };
      case "dismissed":
        return { status: "dismissed" };
      case "moved":
        if (summary.subjectId) this.options.overviewMoved?.(summary.subjectId);
        return { status: "stale" };
      case "retired":
        return { status: "stale" };
      case "not_pending":
        return { status: result.status as ChangeSetStatus };
      case "not_found":
        throw new Error(errors.notFound);
    }
  }
}

/** The status a relation pass's stored verdict reads as in the view. */
function verdictStatus(
  verdict: "kept" | "dismissed" | null,
  fallback: ChangeSetStatus
): ChangeSetStatus {
  if (verdict === "kept") return "applied";
  if (verdict === "dismissed") return "dismissed";
  return fallback;
}
