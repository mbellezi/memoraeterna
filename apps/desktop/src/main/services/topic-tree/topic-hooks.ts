// The hooks the rest of the main process calls when notes or sources change (F2 T15b): place a
// note once it has a vector, unplace it when it stops being current, place a source once its
// composite vector exists, and repair the tree when items were deleted. They sit on the trigger
// API (`topic-triggers.ts`) and add the one policy callers need: a hook never fails its caller.
// Deriving topic placements is background work; ingestion, review and deletion must not break on
// it, and the sweep (startup, every cache load, `topic-sweep`) finds whatever a hook missed.
import type { Queryable } from "@app/db";

import type { TopicTriggerOptions, TopicTriggers } from "./topic-triggers.js";

/** Where a hook enqueues: in the caller's open transaction (`client`), or on its own. */
export type TopicHookOptions = TopicTriggerOptions;

export interface TopicChangeHooks {
  /**
   * Notes were embedded or re-embedded, or stopped being current (rejected, archived,
   * superseded): PLACE their roots. Deleted notes send the tree to the sweep.
   */
  notesChanged(noteIds: readonly string[], options?: TopicHookOptions): Promise<void>;
  /** A source's composite vector was written: PLACE its root. */
  sourcesChanged(sourceItemIds: readonly string[], options?: TopicHookOptions): Promise<void>;
  /**
   * Notes or sources were deleted, and their placements left by cascade (D32): repair the
   * statistics and rebalance. Call it in the deleting transaction, after the delete, so the jobs
   * exist exactly when the deletion commits.
   */
  itemsRemoved(options?: TopicHookOptions): Promise<void>;
}

const savepoint = "topic_hook";

/**
 * In a caller's transaction a failed statement would abort the whole transaction, so the hook
 * runs inside a savepoint and rolls back to it on failure: the deletion or replacement around it
 * still commits.
 */
async function inSavepoint<T>(client: Queryable, run: () => Promise<T>): Promise<T> {
  await client.query(`savepoint ${savepoint}`);
  try {
    const result = await run();
    await client.query(`release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    throw error;
  }
}

export function createTopicChangeHooks(
  triggers: TopicTriggers,
  logger?: Pick<Console, "warn">
): TopicChangeHooks {
  async function guarded(
    name: string,
    options: TopicHookOptions,
    run: () => Promise<unknown>
  ): Promise<void> {
    try {
      if (options.client) await inSavepoint(options.client, run);
      else await run();
    } catch (error) {
      logger?.warn(`Topic hook ${name} failed; the topic sweep repairs it`, error);
    }
  }

  return {
    notesChanged: (noteIds, options = {}) =>
      guarded("notesChanged", options, () => triggers.notesChanged(noteIds, options)),
    sourcesChanged: (sourceItemIds, options = {}) =>
      guarded("sourcesChanged", options, () => triggers.sourcesChanged(sourceItemIds, options)),
    itemsRemoved: (options = {}) => guarded("itemsRemoved", options, () => triggers.repair(options))
  };
}
